export async function onRequestGet(context) {
  const { env } = context;

  try {
    const sql = `
      SELECT
        r.id,
        r.franja_id,
        f.fecha,
        f.hora_inicio,
        f.hora_fin,
        r.centro,
        r.contacto,
        r.telefono,
        r.email,
        r.mayores10,
        r.menores10,
        r.personas,
        r.fecha_solicitud,
        r.idempotency_key
      FROM reservas r
      INNER JOIN franjas f
        ON r.franja_id = f.id
      ORDER BY f.fecha, f.hora_inicio, r.fecha_solicitud
    `;

    const result = await env.DB.prepare(sql).all();

    return Response.json({
      ok: true,
      total: result.results.length,
      reservas: result.results
    });

  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Error al obtener el listado de reservas.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
