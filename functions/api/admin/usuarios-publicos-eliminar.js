import { getAdminSession } from "./_auth.js";
import { eliminarUsuarioPublico } from "./_usuarios_publicos_gestion.js";

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
    const usuarioId = Number(body.usuario_id || 0);
    const motivo = String(body.motivo || "").trim();

    if (!(usuarioId > 0)) {
      return json({ ok: false, error: "Usuario publico no valido." }, 400);
    }

    if (!motivo) {
      return json({ ok: false, error: "Debes indicar observaciones para eliminar la cuenta." }, 400);
    }

    const resumen = await eliminarUsuarioPublico(env, usuarioId, {
      actorUsuarioId: session.usuario_id,
      actorRol: session.rol,
      actorNombre: session.username,
      motivo
    });

    return json({
      ok: true,
      mensaje: "Usuario publico eliminado correctamente.",
      resumen
    });
  } catch (error) {
    const detalle = String(error?.message || "").trim();
    return json({
      ok: false,
      error: detalle ? `Error eliminando el usuario publico: ${detalle}` : "Error eliminando el usuario publico.",
      detalle
    }, 500);
  }
}
