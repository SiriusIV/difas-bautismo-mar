import { getAdminSession } from "./_auth.js";
import { eliminarAdministrador, eliminarAdministradorDocumental } from "./_admins_gestion.js";

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

    if (String(session.rol || "").toUpperCase() !== "SUPERADMIN") {
      return json({ ok: false, error: "Solo SUPERADMIN" }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const adminId = Number(body.usuario_id || 0);
    const motivo = String(body.motivo || "").trim();

    if (!(adminId > 0)) {
      return json({ ok: false, error: "Administrador no válido." }, 400);
    }

    if (!motivo) {
      return json({ ok: false, error: "Debes indicar observaciones para eliminar la cuenta." }, 400);
    }

    const objetivo = await env.DB.prepare(`
      SELECT rol
      FROM usuarios
      WHERE id = ?
        AND rol IN ('ADMIN', 'SECRETARIA')
      LIMIT 1
    `).bind(adminId).first();

    if (!objetivo) {
      return json({ ok: false, error: "Usuario Armada no encontrado." }, 404);
    }

    const rolObjetivo = String(objetivo.rol || "").toUpperCase();
    const contexto = {
      actorUsuarioId: session.usuario_id,
      actorRol: session.rol,
      actorNombre: session.username,
      motivo
    };

    const resumen = rolObjetivo === "SECRETARIA"
      ? await eliminarAdministradorDocumental(env, adminId, contexto)
      : await eliminarAdministrador(env, adminId, contexto);

    return json({
      ok: true,
      mensaje: rolObjetivo === "SECRETARIA"
        ? "Administrador documental eliminado correctamente."
        : "Administrador eliminado correctamente.",
      resumen
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error eliminando el administrador.",
      detalle: error.message
    }, 500);
  }
}
