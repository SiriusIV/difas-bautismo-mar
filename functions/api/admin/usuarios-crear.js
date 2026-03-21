import { getAdminSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(v) {
  return String(v || "").trim();
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    // SOLO SUPERADMIN puede crear admins
    const rolSession = await env.DB.prepare(`
      SELECT rol FROM usuarios WHERE id = ?
    `).bind(session.usuario_id).first();

    if (!rolSession || rolSession.rol !== "SUPERADMIN") {
      return json({ ok: false, error: "Solo SUPERADMIN puede crear administradores" }, 403);
    }

    const body = await request.json();

    const nombre = limpiarTexto(body.nombre);
    const email = limpiarTexto(body.email).toLowerCase();
    const password = String(body.password || "");
    const rol = limpiarTexto(body.rol).toUpperCase(); // ADMIN o SUPERADMIN

    if (!nombre || !email || !password || !rol) {
      return json({ ok: false, error: "Faltan datos" }, 400);
    }

    if (rol !== "ADMIN") {
  return json({ ok: false, error: "Solo se pueden crear usuarios ADMIN desde este panel" }, 400);
}

    const existing = await env.DB.prepare(`
      SELECT id FROM usuarios WHERE email = ?
    `).bind(email).first();

    if (existing) {
      return json({ ok: false, error: "Email ya registrado" }, 400);
    }

    const password_hash = await hashPassword(password);

    const result = await env.DB.prepare(`
      INSERT INTO usuarios (nombre, centro, email, password_hash, rol)
      VALUES (?, NULL, ?, ?, ?)
    `)
      .bind(nombre, email, password_hash, rol)
      .run();

    return json({
      ok: true,
      id: result.meta.last_row_id,
      mensaje: "Usuario creado correctamente"
    });

  } catch (error) {
    return json(
      { ok: false, error: "Error creando usuario", detalle: error.message },
      500
    );
  }
}
