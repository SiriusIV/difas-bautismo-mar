export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();

    const centro = (data.centro || "").trim();
    const contacto = (data.contacto || "").trim();
    const telefono = (data.telefono || "").trim();
    const email = (data.email || "").trim();
    const observaciones = (data.observaciones || "").trim();
    const franjaId = parseInt(data.franja, 10);
    const mayores10 = parseInt(data.mayores10 || 0, 10);
    const menores10 = parseInt(data.menores10 || 0, 10);
    const idempotencyKey = (data.idempotencyKey || "").trim();

    const personas = mayores10 + menores10;

    if (!centro || !contacto || !telefono || !email || !franjaId) {
      return Response.json(
        { ok: false, error: "Faltan campos obligatorios." },
        { status: 400 }
      );
    }

    if (!idempotencyKey) {
      return Response.json(
        { ok: false, error: "Falta la clave de idempotencia." },
        { status: 400 }
      );
    }

    if (personas <= 0) {
      return Response.json(
        { ok: false, error: "Debe indicar al menos 1 visitante." },
        { status: 400 }
      );
    }

    const session = env.DB.withSession("first-primary");

    // 1) Si ya existe una reserva con esta clave, devolvemos éxito sin duplicar
    const existente = await session
      .prepare(`
        SELECT
          r.id,
          r.franja_id,
          r.personas,
          f.fecha,
          f.hora_inicio,
          f.hora_fin,
          f.capacidad,
          (
            f.capacidad - (
              SELECT COALESCE(SUM(r2.personas), 0)
              FROM reservas r2
              WHERE r2.franja_id = f.id
            )
          ) AS disponibles
        FROM reservas r
        JOIN franjas f ON f.id = r.franja_id
        WHERE r.idempotency_key = ?
      `)
      .bind(idempotencyKey)
      .first();

    if (existente) {
      return Response.json({
        ok: true,
        duplicate: true,
        mensaje: "La solicitud ya había sido registrada anteriormente.",
        franja: {
          id: existente.franja_id,
          fecha: existente.fecha,
          hora_inicio: existente.hora_inicio,
          hora_fin: existente.hora_fin
        },
        capacidad: existente.capacidad,
        personas_reservadas: existente.personas,
        disponibles_despues: existente.disponibles
      });
    }

    // 2) Verificar que la franja existe
    const franja = await session
      .prepare(`
        SELECT id, fecha, hora_inicio, hora_fin, capacidad
        FROM franjas
        WHERE id = ?
      `)
      .bind(franjaId)
      .first();

    if (!franja) {
      return Response.json(
        { ok: false, error: "La franja seleccionada no existe." },
        { status: 404 }
      );
    }

    // 3) Insertar solo si todavía hay plazas suficientes
    const insertResult = await session
      .prepare(`
        INSERT INTO reservas (
          franja_id,
          centro,
          contacto,
          telefono,
          email,
          mayores10,
          menores10,
          personas,
          fecha_solicitud,
          idempotency_key
        )
        SELECT
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          datetime('now'),
          ?
        FROM franjas f
        LEFT JOIN (
          SELECT franja_id, COALESCE(SUM(personas), 0) AS ocupadas
          FROM reservas
          WHERE franja_id = ?
          GROUP BY franja_id
        ) r ON r.franja_id = f.id
        WHERE f.id = ?
          AND ? <= (f.capacidad - COALESCE(r.ocupadas, 0))
      `)
      .bind(
        franjaId,
        centro,
        contacto,
        telefono,
        email,
        mayores10,
        menores10,
        personas,
        idempotencyKey,
        franjaId,
        franjaId,
        personas
      )
      .run();

    const estado = await session
      .prepare(`
        SELECT
          f.id,
          f.fecha,
          f.hora_inicio,
          f.hora_fin,
          f.capacidad,
          COALESCE(SUM(r.personas), 0) AS ocupadas,
          (f.capacidad - COALESCE(SUM(r.personas), 0)) AS disponibles
        FROM franjas f
        LEFT JOIN reservas r
          ON f.id = r.franja_id
        WHERE f.id = ?
        GROUP BY f.id, f.fecha, f.hora_inicio, f.hora_fin, f.capacidad
      `)
      .bind(franjaId)
      .first();

    const cambios = insertResult?.meta?.changes || 0;

    if (cambios === 0) {
      return Response.json(
        {
          ok: false,
          error: `No hay plazas suficientes en esa franja. Disponibles: ${estado.disponibles}. Solicitadas: ${personas}.`,
          franja: {
            id: estado.id,
            fecha: estado.fecha,
            hora_inicio: estado.hora_inicio,
            hora_fin: estado.hora_fin
          },
          capacidad: estado.capacidad,
          ocupadas: estado.ocupadas,
          disponibles: estado.disponibles
        },
        { status: 400 }
      );
    }

    return Response.json({
      ok: true,
      mensaje: "Solicitud registrada correctamente.",
      franja: {
        id: estado.id,
        fecha: estado.fecha,
        hora_inicio: estado.hora_inicio,
        hora_fin: estado.hora_fin
      },
      capacidad: estado.capacidad,
      ocupadas: estado.ocupadas,
      personas_reservadas: personas,
      disponibles_despues: estado.disponibles
    });

  } catch (error) {
    // Si hubo carrera exacta con la misma idempotency_key
    if (String(error.message || "").includes("UNIQUE constraint failed")) {
      return Response.json(
        {
          ok: true,
          duplicate: true,
          mensaje: "La solicitud ya había sido procesada."
        }
      );
    }

    return Response.json(
      {
        ok: false,
        error: "Error interno del servidor.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
