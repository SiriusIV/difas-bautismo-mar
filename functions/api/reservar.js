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

    // 1. Leer la franja y su capacidad
    const franjaResult = await env.DB.prepare(
      `SELECT id, fecha, hora_inicio, hora_fin, capacidad
       FROM franjas
       WHERE id = ?`
    )
      .bind(franjaId)
      .first();

    if (!franjaResult) {
      return Response.json(
        { ok: false, error: "La franja seleccionada no existe." },
        { status: 404 }
      );
    }

    // 2. Calcular cuántas plazas ya están ocupadas
    const ocupacionResult = await env.DB.prepare(
      `SELECT COALESCE(SUM(personas), 0) AS ocupadas
       FROM reservas
       WHERE franja_id = ?`
    )
      .bind(franjaId)
      .first();

    const ocupadas = ocupacionResult?.ocupadas || 0;
    const capacidad = franjaResult.capacidad;
    const disponibles = capacidad - ocupadas;

    // 3. Comprobar si caben
    if (personas > disponibles) {
      return Response.json(
        {
          ok: false,
          error: `No hay plazas suficientes en esa franja. Disponibles: ${disponibles}. Solicitadas: ${personas}.`
        },
        { status: 400 }
      );
    }

    // 4. Guardar la reserva
    await env.DB.prepare(
      `INSERT INTO reservas
       (franja_id, centro, contacto, telefono, email, mayores10, menores10, personas, fecha_solicitud)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
      .bind(
        franjaId,
        centro,
        contacto,
        telefono,
        email,
        mayores10,
        menores10,
        personas
      )
      .run();

    // 5. Respuesta OK
    return Response.json({
      ok: true,
      mensaje: "Solicitud registrada correctamente.",
      franja: {
        id: franjaResult.id,
        fecha: franjaResult.fecha,
        hora_inicio: franjaResult.hora_inicio,
        hora_fin: franjaResult.hora_fin
      },
      capacidad,
      ocupadas,
      disponibles_antes: disponibles,
      personas_reservadas: personas,
      disponibles_despues: disponibles - personas
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
