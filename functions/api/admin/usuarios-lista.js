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
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    const rolRes = await env.DB.prepare(`
      SELECT rol
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(session.usuario_id).first();

    if (!rolRes || rolRes.rol !== "SUPERADMIN") {
      return json({ ok: false, error: "Solo SUPERADMIN" }, 403);
    }

    const usuarios = await env.DB.prepare(`
      SELECT
        u.id,
        u.nombre,
        u.email,
        u.rol,
        u.activo,
        u.fecha_alta
      FROM usuarios u
      WHERE u.rol IN ('ADMIN', 'SUPERADMIN')
      ORDER BY
        CASE WHEN u.rol = 'SUPERADMIN' THEN 0 ELSE 1 END,
        u.nombre ASC
    `).all();

    const actividades = await env.DB.prepare(`
      SELECT
        ua.usuario_id,
        ua.actividad_id,
        ua.activo,
        a.nombre AS actividad_nombre
      FROM usuario_actividad ua
      INNER JOIN actividades a
        ON a.id = ua.actividad_id
      WHERE ua.activo = 1
      ORDER BY a.nombre ASC
    `).all();

    const actividadesDisponibles = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        titulo_publico,
        activa,
        visible_portal
      FROM actividades
      ORDER BY nombre ASC
    `).all();

    const actividadesPorUsuario = new Map();

    for (const act of (actividades.results || [])) {
      if (!actividadesPorUsuario.has(act.usuario_id)) {
        actividadesPorUsuario.set(act.usuario_id, []);
      }

      actividadesPorUsuario.get(act.usuario_id).push({
        actividad_id: act.actividad_id,
        actividad_nombre: act.actividad_nombre
      });
    }

    return json({
      ok: true,
      actividades_disponibles: (actividadesDisponibles.results || []).map(a => ({
        id: a.id,
        nombre: a.nombre,
        titulo_publico: a.titulo_publico,
        activa: a.activa,
        visible_portal: a.visible_portal
      })),
      usuarios: (usuarios.results || []).map(u => ({
        id: u.id,
        nombre: u.nombre,
        email: u.email,
        rol: u.rol,
        activo: u.activo,
        fecha_alta: u.fecha_alta,
        actividades: u.rol === "SUPERADMIN"
          ? []
          : (actividadesPorUsuario.get(u.id) || [])
      }))
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error cargando usuarios", detalle: error.message },
      500
    );
  }
}
