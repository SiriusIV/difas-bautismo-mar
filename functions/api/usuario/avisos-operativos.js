import { getUserSession } from "./_auth.js";
import { listarAvisosUsuario } from "../_avisos_usuario.js";

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
    const limit = Number(url.searchParams.get("limit") || 25);
    const items = await listarAvisosUsuario(env, usuarioId, { limit });

    return json({
      ok: true,
      usuario_id: usuarioId,
      total: items.length,
      items
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudieron cargar los avisos operativos.",
      detalle: error.message
    }, { status: 500 });
  }
}
