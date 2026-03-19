import { createSessionCookie } from "./_auth.js";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;

  const body = await request.json();
  const { email, password } = body;

  if (!email || !password) {
    return json({ ok: false, error: "Faltan credenciales" }, 400);
  }

  const user = await db
    .prepare("SELECT * FROM usuarios WHERE email = ? AND activo = 1")
    .bind(email)
    .first();

  if (!user) {
    return json({ ok: false, error: "Usuario no encontrado" }, 401);
  }

  const password_hash = await hashPassword(password);

  if (user.password_hash !== password_hash) {
    return json({ ok: false, error: "Contraseña incorrecta" }, 401);
  }

  const sessionUser = {
    id: user.id,
    nombre: user.nombre,
    email: user.email,
    rol: user.rol
  };

  const cookie = await createSessionCookie(sessionUser, env.SECRET_KEY);

  return json(
    { ok: true, user: sessionUser },
    200,
    { "Set-Cookie": cookie }
  );
}
