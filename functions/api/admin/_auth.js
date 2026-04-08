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

  if (session.rol !== "ADMIN" && session.rol !== "SUPERADMIN") {
    return null;
  }

  return {
    username: session.email,
    usuario_id: session.id,
    rol: session.rol
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
