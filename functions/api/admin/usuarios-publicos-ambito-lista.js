import { getAdminSession } from "./_auth.js";
import { asegurarTablaBloqueosUsuariosPublicosAdmin } from "./_usuarios_publicos_bloqueo_admin.js";

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

    if (String(session.rol || "").toUpperCase() !== "ADMIN") {
      return json({ ok: false, error: "Solo ADMIN" }, 403);
    }

    await asegurarTablaBloqueosUsuariosPublicosAdmin(env);

    const rows = await env.DB.prepare(`
      SELECT
        u.id,
        u.nombre,
        u.centro,
        u.localidad,
        u.email,
        u.telefono_contacto,
        u.responsable_legal,
        u.tipo_documento,
        u.documento_identificacion,
        u.activo,
        u.fecha_alta,
        b.activo AS bloqueado_para_admin,
        COALESCE(b.motivo, '') AS motivo_bloqueo,
        b.updated_at AS bloqueo_actualizado_en
      FROM usuarios u
      LEFT JOIN usuarios_publicos_bloqueos_admin b
        ON b.admin_usuario_id = ?
       AND b.usuario_publico_id = u.id
      WHERE u.rol = 'SOLICITANTE'
        AND COALESCE(u.activo, 0) = 1
      ORDER BY UPPER(COALESCE(NULLIF(TRIM(u.centro), ''), NULLIF(TRIM(u.nombre), ''), u.email)) ASC
    `).bind(
      Number(session.usuario_id || 0)
    ).all();

    return json({
      ok: true,
      usuarios: rows.results || []
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error cargando usuarios públicos del ámbito del administrador.",
      detalle: error.message
    }, 500);
  }
}
