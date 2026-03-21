import { getAdminSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    // SOLO SUPERADMIN
    const rolRes = await env.DB.prepare(`
      SELECT rol FROM usuarios WHERE id = ?
    `).bind(session.usuario_id).first();

    if (!rolRes || rolRes.rol !== "SUPERADMIN") {
      return json({ ok: false, error: "Solo SUPERADMIN" }, 403);
    }

    const body = await request.json();

    const usuario_id = Number(body.usuario_id || 0);
    const actividad_id = Number(body.actividad_id || 0);

    if (!usuario_id || !actividad_id) {
      return json({ ok: false, error: "Faltan datos" }, 400);
    }

    await env.DB.prepare(`
      INSERT OR IGNORE INTO usuario_actividad (usuario_id, actividad_id, activo)
      VALUES (?, ?, 1)
    `)
      .bind(usuario_id, actividad_id)
      .run();

    return json({
      ok: true,
      mensaje: "Actividad asignada al administrador"
    });

  } catch (error) {
    return json(
      { ok: false, error: "Error asignando actividad", detalle: error.message },
      500
    );
  }
}
