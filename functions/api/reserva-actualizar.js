export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();

    const tokenEdicion = (data.token_edicion || "").trim();
    const centro = (data.centro || "").trim();
    const contacto = (data.contacto || "").trim();
    const telefono = (data.telefono || "").trim();
    const email = (data.email || "").trim();
    const observaciones = (data.observaciones || "").trim();
    const franjaNuevaId = parseInt(data.franja, 10);
    const mayores10 = parseInt(data.mayores10 || 0, 10);
    const menores10 = parseInt(data.menores10 || 0, 10);

    const personasNuevas = mayores10 + menores10;

    if (!tokenEdicion) {
      return Response.json(
        { ok: false, error: "Falta el token de edición." },
        { status: 400 }
      );
    }

    if (!centro || !contacto || !telefono || !email || !franjaNuevaId) {
      return Response.json(
        { ok: false, error: "Faltan campos obligatorios." },
        { status: 400 }
      );
    }

    if (personasNuevas <= 0) {
      return Response.json(
        { ok: false, error: "Debe indicar al menos 1 visitante." },
        { status: 400 }
      );
    }

    const session = env.DB.withSession("first-primary");

    // 1) Leer la reserva actual
    const reservaActual = await session
      .prepare(`
        SELECT
          id,
          franja_id,
          personas,
          codigo_reserva,
          token_edicion,
          estado
        FROM reservas
        WHERE token_edicion = ?
        LIMIT 1
      `)
      .bind(tokenEdicion)
      .first();

    if (!reservaActual) {
      return Response.json(
        { ok: false, error: "No existe ninguna reserva con ese token." },
        { status: 404 }
      );
    }

    if (!["PENDIENTE", "CONFIRMADA"].includes(reservaActual.estado)) {
      return Response.json(
        {
          ok: false,
          error: "La solicitud no está en un estado editable."
        },
        { status: 400 }
      );
    }

    // 2) Verificar que la nueva franja existe
    const franjaNueva = await session
      .prepare(`
        SELECT id, fecha, hora_inicio, hora_fin, capacidad
        FROM franjas
        WHERE id = ?
      `)
      .bind(franjaNuevaId)
      .first();

    if (!franjaNueva) {
      return Response.json(
        { ok: false, error: "La franja seleccionada no existe." },
        { status: 404 }
      );
    }

    const mismaFranja = Number(reservaActual.franja_id) === Number(franjaNuevaId);

    // 3) Calcular disponibilidad real en la franja destino
    // Si es la misma franja, excluimos la propia reserva del cálculo
    const ocupacionDestino = await session
      .prepare(`
        SELECT COALESCE(SUM(personas), 0) AS ocupadas
        FROM reservas
        WHERE franja_id = ?
          AND id <> ?
          AND estado IN ('PENDIENTE', 'CONFIRMADA')
      `)
      .bind(franjaNuevaId, reservaActual.id)
      .first();

    const ocupadasDestino = Number(ocupacionDestino?.ocupadas || 0);
    const disponiblesDestino = Number(franjaNueva.capacidad) - ocupadasDestino;

    if (personasNuevas > disponiblesDestino) {
      return Response.json(
        {
          ok: false,
          error: `No hay plazas suficientes en la franja seleccionada. Disponibles: ${disponiblesDestino}. Solicitadas: ${personasNuevas}.`
        },
        { status: 400 }
      );
    }

    // 4) Actualizar la reserva existente
    await session
      .prepare(`
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          mayores10 = ?,
          menores10 = ?,
          personas = ?,
          observaciones = ?,
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `)
      .bind(
        franjaNuevaId,
        centro,
        contacto,
        telefono,
        email,
        mayores10,
        menores10,
        personasNuevas,
        observaciones,
        reservaActual.id
      )
      .run();

    // 5) Leer estado final de la franja ya actualizada
    const estadoFinalFranja = await session
      .prepare(`
        SELECT
          f.id,
          f.fecha,
          f.hora_inicio,
          f.hora_fin,
          f.capacidad,
          COALESCE(SUM(
            CASE
              WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN r.personas
              ELSE 0
            END
          ), 0) AS ocupadas,
          (
            f.capacidad - COALESCE(SUM(
              CASE
                WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN r.personas
                ELSE 0
              END
            ), 0)
          ) AS disponibles
        FROM franjas f
        LEFT JOIN reservas r
          ON f.id = r.franja_id
        WHERE f.id = ?
        GROUP BY f.id, f.fecha, f.hora_inicio, f.hora_fin, f.capacidad
      `)
      .bind(franjaNuevaId)
      .first();

    return Response.json({
      ok: true,
      mensaje: "Solicitud actualizada correctamente.",
      codigo_reserva: reservaActual.codigo_reserva,
      token_edicion: reservaActual.token_edicion,
      estado: reservaActual.estado,
      franja: {
        id: estadoFinalFranja.id,
        fecha: estadoFinalFranja.fecha,
        hora_inicio: estadoFinalFranja.hora_inicio,
        hora_fin: estadoFinalFranja.hora_fin
      },
      capacidad: estadoFinalFranja.capacidad,
      ocupadas: estadoFinalFranja.ocupadas,
      personas_reservadas: personasNuevas,
      disponibles_despues: estadoFinalFranja.disponibles,
      cambio_de_franja: !mismaFranja
    });

  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Error interno al actualizar la solicitud.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
