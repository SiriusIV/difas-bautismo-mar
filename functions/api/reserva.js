export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const token = (url.searchParams.get("token") || "").trim();

    if (!token) {
      return Response.json(
        { ok: false, error: "Falta el token de edición." },
        { status: 400 }
      );
    }

    const reserva = await env.DB.prepare(`
      SELECT
        r.id,
        r.franja_id,
        r.centro,
        r.contacto,
        r.telefono,
        r.email,
        r.mayores10,
        r.menores10,
        r.personas,
        r.fecha_solicitud,
        r.fecha_modificacion,
        r.codigo_reserva,
        r.token_edicion,
        r.estado,
        r.observaciones,
        f.fecha,
        f.hora_inicio,
        f.hora_fin,
        f.capacidad,
        COALESCE((
          SELECT SUM(r2.personas)
          FROM reservas r2
          WHERE r2.franja_id = r.franja_id
        ), 0) AS ocupadas,
        (
          f.capacidad - COALESCE((
            SELECT SUM(r2.personas)
            FROM reservas r2
            WHERE r2.franja_id = r.franja_id
          ), 0)
        ) AS disponibles
      FROM reservas r
      INNER JOIN franjas f
        ON r.franja_id = f.id
      WHERE r.token_edicion = ?
      LIMIT 1
    `)
    .bind(token)
    .first();

    if (!reserva) {
      return Response.json(
        { ok: false, error: "No existe ninguna reserva con ese token." },
        { status: 404 }
      );
    }

    return Response.json({
      ok: true,
      reserva
    });

  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Error al recuperar la reserva.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
