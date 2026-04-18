import { getUserSession } from "./_auth.js";
import { listarNotificaciones } from "../_notificaciones.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    ...init
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    const usuarioId = Number(session?.usuario_id || session?.id || 0);
    if (!usuarioId) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const url = new URL(request.url);
    const soloNoLeidas = ["1", "true", "si", "sí"].includes(String(url.searchParams.get("solo_no_leidas") || "").toLowerCase());
    const limit = Number(url.searchParams.get("limit") || 25);
    const data = await listarNotificaciones(env, usuarioId, { limit, soloNoLeidas });

    return json({
      ok: true,
      usuario_id: usuarioId,
      total: data.total,
      unread: data.unread,
      items: data.items
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudieron cargar las notificaciones.",
      detalle: error.message
    }, { status: 500 });
  }
}
