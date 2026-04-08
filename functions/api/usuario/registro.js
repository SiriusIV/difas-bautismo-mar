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

function esEmailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

  const centro = limpiarTexto(body.centro);
  const email = limpiarTexto(body.email).toLowerCase();
  const telefono_contacto = limpiarTexto(body.telefono_contacto);
  const password = String(body.password || "");
  const nombre = centro;

  if (!centro || !email || !password) {
    return json({ ok: false, error: "Faltan campos obligatorios" }, 400);
  }

  if (!esEmailValido(email)) {
    return json({ ok: false, error: "El email no es valido" }, 400);
  }

  // comprobar email existente
  const existingEmail = await db
    .prepare("SELECT id FROM usuarios WHERE email = ?")
    .bind(email)
    .first();

  if (existingEmail) {
    return json({ ok: false, error: "Email ya registrado" }, 400);
  }

  // comprobar centro existente solo entre solicitantes
  const existingCentro = await db
    .prepare("SELECT id FROM usuarios WHERE centro = ? AND rol = 'SOLICITANTE'")
    .bind(centro)
    .first();

  if (existingCentro) {
    return json({ ok: false, error: "Ya existe un usuario para ese centro" }, 400);
  }

  const password_hash = await hashPassword(password);

  const result = await db
    .prepare(`
      INSERT INTO usuarios (
        nombre,
        centro,
        email,
        password_hash,
        rol,
        telefono_contacto,
        activo,
        fecha_alta
      )
      VALUES (?, ?, ?, ?, 'SOLICITANTE', ?, 1, datetime('now'))
    `)
    .bind(nombre, centro, email, password_hash, telefono_contacto)
    .run();

  const user = {
    id: result.meta.last_row_id,
    nombre,
    centro,
    email,
    telefono_contacto,
    logo_url: "",
    web_externa_url: "",
    rol: "SOLICITANTE"
  };

  const cookie = await createSessionCookie(user, env.SECRET_KEY);

  return json(
    { ok: true, user },
    200,
    { "Set-Cookie": cookie }
  );
}
