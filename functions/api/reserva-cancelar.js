export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();
    const tokenEdicion = String(data.token_edicion || "").trim();

    if (!tokenEdicion) {
      return Response.json(
        { ok: false, error: "Falta el token de ediciÃ³n." },
        { status: 400 }
      );
    }

    const session = env.DB.withSession("first-primary");

    const reserva = await session
      .prepare(`
        SELECT
          r.id,
          r.franja_id,
          r.codigo_reserva,
          r.token_edicion,
          r.estado,
          f.fecha,
          f.hora_inicio,
          f.hora_fin,
          f.capacidad
        FROM reservas r
        INNER JOIN franjas f
          ON r.franja_id = f.id
        WHERE r.token_edicion = ?
        LIMIT 1
      `)
      .bind(tokenEdicion)
      .first();

    if (!reserva) {
      return Response.json(
        { ok: false, error: "No existe ninguna solicitud con ese token." },
        { status: 404 }
      );
    }

    if (reserva.estado === "RECHAZADA") {
      return Response.json(
        {
          ok: false,
          error: "La solicitud ya estÃ¡ rechazada y no puede anularse desde este formulario."
        },
        { status: 400 }
      );
    }

    await session
      .prepare(`
        DELETE FROM visitantes
        WHERE reserva_id = ?
      `)
      .bind(reserva.id)
      .run();

    const deleteResult = await session
      .prepare(`
        DELETE FROM reservas
        WHERE id = ?
      `)
      .bind(reserva.id)
      .run();

    if ((deleteResult?.meta?.changes || 0) === 0) {
      return Response.json(
        { ok: false, error: "No se pudo anular la solicitud." },
        { status: 500 }
      );
    }

    const estadoFinal = await session
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
      .bind(reserva.franja_id)
      .first();

    return Response.json({
      ok: true,
      mensaje: "Solicitud anulada correctamente.",
      codigo_reserva: reserva.codigo_reserva,
      token_edicion: reserva.token_edicion,
      estado: "ANULADA",
      franja: {
        id: estadoFinal.id,
        fecha: estadoFinal.fecha,
        hora_inicio: estadoFinal.hora_inicio,
        hora_fin: estadoFinal.hora_fin
      },
      capacidad: estadoFinal.capacidad,
      ocupadas: estadoFinal.ocupadas,
      disponibles_despues: estadoFinal.disponibles
    });

  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Error interno al anular la solicitud.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
