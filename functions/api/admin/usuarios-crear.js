import { getAdminSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
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

  try {
    const session = await getAdminSession(request, env);
    if (!session || session.rol !== "SUPERADMIN") {
      return json({ ok: false, error: "Solo SUPERADMIN" }, 403);
    }

    const body = await request.json();

    const nombre = String(body.nombre || "").trim();
    const email = String(body.email || "").trim();
    const password = String(body.password || "").trim();
    const rol = "ADMIN";

    const actividad_id = Number(body.actividad_id || 0);

    if (!nombre || !email || !password || !actividad_id) {
      return json({ ok: false, error: "Faltan datos obligatorios" }, 400);
    }

    // comprobar email existente
    const existing = await db.prepare(`
      SELECT id FROM usuarios WHERE email = ?
    `).bind(email).first();

    if (existing) {
      return json({ ok: false, error: "Email ya registrado" }, 400);
    }

    const password_hash = await hashPassword(password);

    // 1. Crear usuario
    const result = await db.prepare(`
      INSERT INTO usuarios (nombre, email, password_hash, rol, activo, fecha_alta)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
    `).bind(nombre, email, password_hash, rol).run();

    const usuario_id = result.meta.last_row_id;

    // 2. ASIGNAR ACTIVIDAD (CLAVE DEL PROBLEMA)
    await db.prepare(`
      INSERT INTO usuario_actividad (usuario_id, actividad_id, activo)
      VALUES (?, ?, 1)
    `).bind(usuario_id, actividad_id).run();

    return json({
      ok: true,
      mensaje: "Administrador creado correctamente"
    });

  } catch (error) {
    return json({
      ok: false,
      error: "Error creando administrador",
      detalle: error.message
    }, 500);
  }
}
