import {
  createSessionCookie as createUserSessionCookie,
  clearSessionCookie as clearUserSessionCookie,
  getUserSession
} from "../usuario/_auth.js";

export async function createSessionCookie(env, username, usuario_id, rol, extra = {}) {
  const payload = {
    id: usuario_id,
    email: username,
    rol,
    ...extra
  };

  return await createUserSessionCookie(payload, env.SECRET_KEY);
}

export async function getAdminSession(request, env) {
  const session = await getUserSession(request, env.SECRET_KEY);

  if (!session) return null;

  if (Number(session.forzar_cambio_password || 0) === 1) {
    return null;
  }

  if (session.rol !== "ADMIN" && session.rol !== "SUPERADMIN") {
    return null;
  }

  const usuario = await env.DB.prepare(`
    SELECT id, rol, activo
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(Number(session.id || 0)).first();

  if (!usuario) return null;
  if (Number(usuario.activo || 0) !== 1) return null;
  if (usuario.rol !== "ADMIN" && usuario.rol !== "SUPERADMIN") return null;

  return {
    username: session.email,
    usuario_id: Number(usuario.id || 0),
    rol: usuario.rol
  };
}

export function clearSessionCookie() {
  return clearUserSessionCookie();
}

export async function requireAdminSession(context) {
  const session = await getAdminSession(context.request, context.env);

  if (!session) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "No autorizado."
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        }
      }
    );
  }

  return null;
}
