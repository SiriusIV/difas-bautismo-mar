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

function limpiarTexto(valor) {
  return String(valor || "").trim();
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

  try {
    const body = await request.json();
    const email = limpiarTexto(body.email).toLowerCase();
    const password = String(body.password || "").trim();

    if (!email || !password) {
      return json({ ok: false, error: "Faltan credenciales" }, 400);
    }

    const user = await db.prepare(`
      SELECT id, nombre, centro, email, password_hash, rol, activo
      FROM usuarios
      WHERE email = ?
      LIMIT 1
    `).bind(email).first();

    if (!user) {
      return json({ ok: false, error: "Usuario no encontrado" }, 401);
    }

    if (Number(user.activo || 0) !== 1) {
      return json({ ok: false, error: "Usuario inactivo" }, 401);
    }

    const password_hash = await hashPassword(password);

    if (String(user.password_hash || "") !== password_hash) {
      return json({ ok: false, error: "Contraseña incorrecta" }, 401);
    }

    await db.prepare(`
      UPDATE usuarios
      SET ultimo_acceso = datetime('now')
      WHERE id = ?
    `).bind(user.id).run();

    const sessionUser = {
      id: user.id,
      nombre: user.nombre,
      centro: user.centro,
      email: user.email,
      rol: user.rol
    };

    const cookie = await createSessionCookie(sessionUser, env.SECRET_KEY);

    return json(
      {
        ok: true,
        user: sessionUser,
        redirect_to:
          user.rol === "SOLICITANTE"
            ? "/usuario-panel.html"
            : "/portal.html"
      },
      200,
      { "Set-Cookie": cookie }
    );

  } catch (error) {
    return json(
      { ok: false, error: "Error interno en login", detalle: error.message },
      500
    );
  }
}
