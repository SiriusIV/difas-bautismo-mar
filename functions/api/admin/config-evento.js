export async function onRequestGet(context) {
  const { env } = context;

  try {
    const config = await env.DB.prepare(`
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

export async function onRequestPut(context) {
  const { env, request } = context;

  try {
    const body = await request.json();

    const nombre_evento = String(body.nombre_evento || "").trim();
    const subtitulo_evento = String(body.subtitulo_evento || "").trim();
    const descripcion_publica = String(body.descripcion_publica || "").trim();
    const lugar = String(body.lugar || "").trim();

    await env.DB.prepare(`
      UPDATE configuracion_evento
      SET
        nombre_evento = ?,
        subtitulo_evento = ?,
        descripcion_publica = ?,
        lugar = ?,
        fecha_modificacion = datetime('now')
      WHERE id = 1
    `)
    .bind(
      nombre_evento,
      subtitulo_evento,
      descripcion_publica,
      lugar
    )
    .run();

    const config = await env.DB.prepare(`
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

    return new Response(JSON.stringify({
      ok: true,
      mensaje: "Configuración del evento actualizada correctamente.",
      config
    }), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: "Error al actualizar la configuración del evento.",
      detalle: error.message
    }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
}
