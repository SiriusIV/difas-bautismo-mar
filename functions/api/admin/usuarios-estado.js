import { getAdminSession } from "./_auth.js";
import { actualizarEstadoAdministrador, actualizarEstadoSecretariaDocumental } from "./_admins_gestion.js";

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
    const activo = body.activo === true || body.activo === 1 || body.activo === "1" ? 1 : 0;
    const motivo = String(body.motivo || "").trim();

    if (!(adminId > 0)) {
      return json({ ok: false, error: "Administrador no válido." }, 400);
    }

    const objetivo = await env.DB.prepare(`
      SELECT rol
      FROM usuarios
      WHERE id = ?
        AND rol IN ('ADMIN', 'SECRETARIA')
    `).bind(adminId).first();

    if (!objetivo) {
      return json({ ok: false, error: "Usuario Armada no encontrado." }, 404);
    }

    const rolObjetivo = String(objetivo.rol || "").toUpperCase();
    const resumen = rolObjetivo === "SECRETARIA"
      ? await actualizarEstadoSecretariaDocumental(env, adminId, activo, {
        actorUsuarioId: session.usuario_id,
        actorRol: session.rol,
        actorNombre: session.username,
        motivo
      })
      : await actualizarEstadoAdministrador(env, adminId, activo, {
      actorUsuarioId: session.usuario_id,
      actorRol: session.rol,
      actorNombre: session.username,
      motivo
    });

    return json({
      ok: true,
      mensaje: rolObjetivo === "SECRETARIA"
        ? (activo
          ? "Administrador documental reactivado correctamente."
          : "Administrador documental desactivado correctamente.")
        : (activo
          ? "Administrador reactivado correctamente."
          : "Administrador desactivado correctamente."),
      resumen
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error actualizando el estado del administrador.",
      detalle: error.message
    }, 500);
  }
}
