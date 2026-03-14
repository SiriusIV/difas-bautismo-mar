export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const token = url.searchParams.get("token");

  if (!token) {
    return Response.json(
      {
        ok: false,
        error: "Falta token de edición."
      },
      { status: 400 }
    );
  }

  try {
    const reserva = await env.DB.prepare(`
      SELECT id, estado
      FROM reservas
      WHERE token_edicion = ?
        AND estado IN ('PENDIENTE', 'CONFIRMADA')
    `)
      .bind(token)
      .first();

    if (!reserva) {
      return Response.json(
        {
          ok: false,
          error: "Solicitud no encontrada o no editable."
        },
        { status: 404 }
      );
    }

    const visitantes = await env.DB.prepare(`
      SELECT
        id,
        nombre_completo,
        categoria_edad,
        fecha_creacion,
        fecha_modificacion
      FROM visitantes
      WHERE reserva_id = ?
      ORDER BY id ASC
    `)
      .bind(reserva.id)
      .all();

    return Response.json({
      ok: true,
      reserva_id: reserva.id,
      estado: reserva.estado,
      total: visitantes.results.length,
      visitantes: visitantes.results
    });

  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Error al recuperar visitantes.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
