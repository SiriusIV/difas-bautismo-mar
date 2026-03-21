import { getAdminSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const rolRes = await env.DB.prepare(`
      SELECT rol
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(session.usuario_id).first();

    if (!rolRes || rolRes.rol !== "SUPERADMIN") {
      return json({ ok: false, error: "Solo SUPERADMIN." }, 403);
    }

    const result = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        email,
        rol,
        activo
      FROM usuarios
      WHERE rol = 'ADMIN'
        AND activo = 1
      ORDER BY nombre ASC
    `).all();

    return json({
      ok: true,
      admins: result.results || []
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al cargar administradores.", detalle: error.message },
      500
    );
  }
}
