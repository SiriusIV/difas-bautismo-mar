export async function onRequestGet(context) {
  const { env } = context;

  const sql = `
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
    GROUP BY f.id, f.fecha, f.hora_inicio, f.hora_fin, f.capacidad
    HAVING disponibles > 0
    ORDER BY f.fecha, f.hora_inicio
  `;

  const result = await env.DB.prepare(sql).all();

  return Response.json(result.results);
}
