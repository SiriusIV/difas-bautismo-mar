function generarTokenEdicion() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

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

    // 1) Si ya existe una reserva con esta clave, devolvemos la ya creada
    const existente = await session
      .prepare(`
        SELECT
          r.id,
          r.franja_id,
          r.personas,
          r.codigo_reserva,
          r.token_edicion,
          r.estado,
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
        codigo_reserva: existente.codigo_reserva,
        token_edicion: existente.token_edicion,
        estado: existente.estado,
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

    // 3) Preparar identificadores
    const tokenEdicion = generarTokenEdicion();

    // 4) Insertar solo si todavía hay plazas suficientes
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
          idempotency_key,
          token_edicion,
          estado,
          fecha_modificacion
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
          ?,
          ?,
          'ACTIVA',
          datetime('now')
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
        tokenEdicion,
        franjaId,
        franjaId,
        personas
      )
      .run();

    const cambios = insertResult?.meta?.changes || 0;

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

    // 5) Obtener el id insertado y generar el codigo_reserva
    const reservaInsertada = await session
      .prepare(`
        SELECT id
        FROM reservas
        WHERE idempotency_key = ?
      `)
      .bind(idempotencyKey)
      .first();

    const reservaId = reservaInsertada.id;
    const codigoReserva = `DIFAS-${String(reservaId).padStart(6, "0")}`;

    await session
      .prepare(`
        UPDATE reservas
        SET codigo_reserva = ?
        WHERE id = ?
      `)
      .bind(codigoReserva, reservaId)
      .run();

    return Response.json({
      ok: true,
      mensaje: "Solicitud registrada correctamente.",
      codigo_reserva: codigoReserva,
      token_edicion: tokenEdicion,
      estado: "ACTIVA",
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
