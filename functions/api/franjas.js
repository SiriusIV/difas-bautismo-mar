export async function onRequestGet(context) {
  const { env } = context;

  const sql = `
    SELECT
      id,
      fecha,
      hora_inicio,
      hora_fin,
      capacidad
    FROM franjas
    ORDER BY fecha, hora_inicio
  `;

  const result = await env.DB.prepare(sql).all();

  return Response.json(result.results);
}
