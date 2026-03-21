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

    // USUARIOS
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

    // ACTIVIDADES (NUEVO MODELO)
    const actividades = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        titulo_publico,
        admin_id
      FROM actividades
      WHERE admin_id IS NOT NULL
      ORDER BY nombre ASC
    `).all();

    // MAPA admin → actividades
    const actividadesPorUsuario = new Map();

    for (const act of (actividades.results || [])) {
      if (!actividadesPorUsuario.has(act.admin_id)) {
        actividadesPorUsuario.set(act.admin_id, []);
      }

      actividadesPorUsuario.get(act.admin_id).push({
        actividad_id: act.id,
        actividad_nombre: act.titulo_publico || act.nombre
      });
    }

    return json({
      ok: true,
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
