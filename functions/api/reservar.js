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

    const personas = mayores10 + menores10;

    if (!centro || !contacto || !telefono || !email || !franjaId) {
      return Response.json(
        { ok: false, error: "Faltan campos obligatorios." },
        { status: 400 }
      );
    }

    if (personas <= 0) {
      return Response.json(
        { ok: false, error: "Debe indicar al menos 1 visitante." },
        { status: 400 }
      );
    }

    // Sesión consistente para leer/escribir sobre el dato más reciente
    const session = env.DB.withSession("first-primary");

    // 1) Verificar que la franja existe
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

    // 2) Intentar insertar SOLO si aún hay plazas suficientes
    //    Esta es la parte crítica: comprobación + inserción en una sola sentencia SQL
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
          fecha_solicitud
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
        franjaId,
        franjaId,
        personas
      )
      .run();

    // 3) Leer ocupación real después del intento
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

    // 4) Si no insertó nada, es que ya no cabía
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

    // 5) Si insertó, la reserva quedó registrada correctamente
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
