import { requireAdminSession } from "./_auth.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function validarConfig({ nombre_evento, subtitulo_evento }) {
  if (!nombre_evento) {
    return "El nombre del evento es obligatorio.";
  }

  if (!subtitulo_evento) {
    return "El subtítulo del evento es obligatorio.";
  }

  return null;
}

async function leerConfig(env) {
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
    await env.DB.prepare(`
      INSERT INTO configuracion_evento (
        id,
        nombre_evento,
        subtitulo_evento,
        descripcion_publica,
        lugar,
        fecha_modificacion
      )
      VALUES (
        1,
        'Evento no configurado',
        'Sin subtítulo',
        '',
        '',
        datetime('now')
      )
    `).run();

    config = await env.DB.prepare(`
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
  }

  return config;
}

export async function onRequestGet(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { env } = context;

  try {
    const config = await leerConfig(env);

    return json({
      ok: true,
      config
    });

  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al obtener la configuración del evento.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestPut(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    const data = await request.json();

    const nombre_evento = limpiarTexto(data.nombre_evento);
    const subtitulo_evento = limpiarTexto(data.subtitulo_evento);
    const descripcion_publica = limpiarTexto(data.descripcion_publica);
    const lugar = limpiarTexto(data.lugar);

    const errorValidacion = validarConfig({
      nombre_evento,
      subtitulo_evento
    });

    if (errorValidacion) {
      return json(
        { ok: false, error: errorValidacion },
        { status: 400 }
      );
    }

    await leerConfig(env);

    const updateResult = await env.DB.prepare(`
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

    if ((updateResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo actualizar la configuración del evento." },
        { status: 500 }
      );
    }

    const config = await leerConfig(env);

    return json({
      ok: true,
      mensaje: "Configuración del evento actualizada correctamente.",
      config
    });

  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al actualizar la configuración del evento.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
