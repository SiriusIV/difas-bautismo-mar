const COOKIE_NAME = "difas_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 horas

function textEncoder() {
  return new TextEncoder();
}

function toBase64Url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    textEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signString(secret, value) {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder().encode(value));
  const bytes = Array.from(new Uint8Array(sig));
  const raw = String.fromCharCode(...bytes);
  return toBase64Url(raw);
}

export async function createSessionCookie(env, username, usuario_id, rol) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_TTL_SECONDS;

  const payloadObj = {
    u: username,
    usuario_id,
    rol,
    exp
  };

  const payload = toBase64Url(JSON.stringify(payloadObj));
  const signature = await signString(env.ADMIN_SESSION_SECRET, payload);
  const token = `${payload}.${signature}`;

  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function parseCookies(request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = {};

  cookieHeader.split(";").forEach(part => {
    const trimmed = part.trim();
    if (!trimmed) return;

    const idx = trimmed.indexOf("=");
    if (idx === -1) return;

    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    cookies[key] = value;
  });

  return cookies;
}

export async function getAdminSession(request, env) {
  try {
    const cookies = parseCookies(request);
    const token = cookies[COOKIE_NAME];

    if (!token) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payload, signature] = parts;

    const expected = await signString(env.ADMIN_SESSION_SECRET, payload);
    if (signature !== expected) return null;

    const decoded = JSON.parse(fromBase64Url(payload));
    if (!decoded || !decoded.u || !decoded.exp) return null;

    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp < now) return null;

    return {
  username: decoded.u,
  usuario_id: decoded.usuario_id,
  rol: decoded.rol,
  exp: decoded.exp
};
  } catch {
    return null;
  }
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
