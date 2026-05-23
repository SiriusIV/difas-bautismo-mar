import { getAdminSession } from "./_auth.js";
import { actualizarEstadoAdministrador } from "./_admins_gestion.js";

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

    if (!(adminId > 0)) {
      return json({ ok: false, error: "Administrador no válido." }, 400);
    }

    const resumen = await actualizarEstadoAdministrador(env, adminId, activo, {
      actorUsuarioId: session.usuario_id,
      actorRol: session.rol,
      actorNombre: session.username
    });

    return json({
      ok: true,
      mensaje: activo
        ? "Administrador reactivado correctamente."
        : "Administrador desactivado correctamente.",
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
