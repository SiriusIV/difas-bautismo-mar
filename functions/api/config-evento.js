export async function onRequestGet(context) {
  const { env } = context;

  try {
    let config = await env.DB.prepare(`
      SELECT
        id,
        nombre_evento,
        subtitulo_evento,
        descripcion_publica,
        lugar,
        fecha_modificacion
      FROM configuracion_evento
      WHERE id = 1
      LIMIT 1
    `).first();

    if (!config) {
      config = {
        id: 1,
        nombre_evento: "Evento no configurado",
        subtitulo_evento: "Sin subtítulo",
        descripcion_publica: "",
        lugar: "",
        fecha_modificacion: null
      };
    }

    return new Response(JSON.stringify({
      ok: true,
      config
    }), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: "Error al obtener la configuración del evento.",
      detalle: error.message
    }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
}
