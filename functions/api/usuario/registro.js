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

  const body = await request.json();

  const nombre = limpiarTexto(body.nombre);
  const centro = limpiarTexto(body.centro);
  const email = limpiarTexto(body.email).toLowerCase();
  const password = String(body.password || "");

  if (!nombre || !centro || !email || !password) {
    return json({ ok: false, error: "Faltan campos obligatorios" }, 400);
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
      INSERT INTO usuarios (nombre, centro, email, password_hash, rol)
      VALUES (?, ?, ?, ?, 'SOLICITANTE')
    `)
    .bind(nombre, centro, email, password_hash)
    .run();

  const user = {
    id: result.meta.last_row_id,
    nombre,
    centro,
    email,
    rol: "SOLICITANTE"
  };

  const cookie = await createSessionCookie(user, env.SECRET_KEY);

  return json(
    { ok: true, user },
    200,
    { "Set-Cookie": cookie }
  );
}
