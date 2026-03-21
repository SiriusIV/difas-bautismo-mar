function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const result = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        tipo,
        fecha_inicio,
        fecha_fin,
        titulo_publico,
        subtitulo_publico,
        descripcion_corta,
        descripcion_larga,
        lugar,
        imagen_url,
        visible_portal,
        orden_portal
      FROM actividades
      WHERE activa = 1
        AND visible_portal = 1
        AND (
          tipo = 'PERMANENTE'
          OR (
            tipo = 'TEMPORAL'
            AND (
              fecha_fin IS NULL
              OR date(fecha_fin) >= date('now')
            )
          )
        )
      ORDER BY orden_portal ASC, id ASC
    `).all();

    return json({
      ok: true,
      actividades: result.results || []
    });
  } catch (error) {
    return json(
      { ok: false, error: "No se pudieron cargar las actividades.", detalle: error.message },
      { status: 500 }
    );
  }
}
