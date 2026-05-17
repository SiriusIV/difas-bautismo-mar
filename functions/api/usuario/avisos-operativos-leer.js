import { getUserSession } from "./_auth.js";
import { eliminarAvisoUsuario, eliminarTodosLosAvisosUsuario } from "../_avisos_usuario.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    const usuarioId = Number(session?.usuario_id || session?.id || 0);
    if (!usuarioId) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    if (body?.todas === true) {
      const result = await eliminarTodosLosAvisosUsuario(env, usuarioId);
      return json({
        ok: true,
        mensaje: "Todos los avisos operativos se han marcado como vistos.",
        changes: Number(result?.changes || 0)
      });
    }

    const avisoId = parsearIdPositivo(body?.aviso_id);
    if (!avisoId) {
      return json({ ok: false, error: "Debes indicar un aviso válido." }, { status: 400 });
    }

    const result = await eliminarAvisoUsuario(env, usuarioId, avisoId);
    return json({
      ok: true,
      mensaje: "Aviso operativo marcado como visto.",
      changes: Number(result?.changes || 0)
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudo actualizar el aviso operativo.",
      detalle: error.message
    }, { status: 500 });
  }
}
