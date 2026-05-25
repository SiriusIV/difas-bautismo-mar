import { getAdminSession } from "./_auth.js";
import { actualizarBloqueoUsuarioPublicoPorAdmin } from "./_usuarios_publicos_bloqueo_admin.js";

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

    if (String(session.rol || "").toUpperCase() !== "ADMIN") {
      return json({ ok: false, error: "Solo ADMIN" }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const usuarioId = Number(body.usuario_id || 0);
    const bloqueado = body.bloqueado === true || body.bloqueado === 1 || body.bloqueado === "1";
    const motivo = String(body.motivo || "").trim();

    if (!(usuarioId > 0)) {
      return json({ ok: false, error: "Usuario público no válido." }, 400);
    }

    const row = await actualizarBloqueoUsuarioPublicoPorAdmin(env, {
      adminUsuarioId: Number(session.usuario_id || 0),
      usuarioPublicoId: usuarioId,
      activo: bloqueado ? 1 : 0,
      motivo,
      actorUsuarioId: Number(session.usuario_id || 0)
    });

    return json({
      ok: true,
      mensaje: bloqueado
        ? "Usuario público bloqueado para tus actividades."
        : "Usuario público desbloqueado para tus actividades.",
      bloqueo: row || null
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error actualizando el bloqueo por ámbito.",
      detalle: error.message
    }, 500);
  }
}
