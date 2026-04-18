import { getUserSession } from "./_auth.js";
import { marcarNotificacionLeida, marcarTodasLasNotificacionesLeidas } from "../_notificaciones.js";

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
    if (!session?.usuario_id) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    if (body?.todas === true) {
      const result = await marcarTodasLasNotificacionesLeidas(env, session.usuario_id);
      return json({
        ok: true,
        mensaje: "Todas las notificaciones se han marcado como vistas.",
        changes: Number(result?.changes || 0)
      });
    }

    const notificacionId = parsearIdPositivo(body?.notificacion_id);
    if (!notificacionId) {
      return json({ ok: false, error: "Debes indicar una notificación válida." }, { status: 400 });
    }

    const result = await marcarNotificacionLeida(env, session.usuario_id, notificacionId);
    return json({
      ok: true,
      mensaje: "Notificación marcada como vista.",
      changes: Number(result?.changes || 0)
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudo actualizar la notificación.",
      detalle: error.message
    }, { status: 500 });
  }
}
