const COOKIE_NAME = "usuario_session";

const encoder = new TextEncoder();

async function sign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(data)
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function createSessionCookie(payload, secret) {
  const data = btoa(JSON.stringify(payload));
  const signature = await sign(data, secret);
  const value = `${data}.${signature}`;

  return `${COOKIE_NAME}=${value}; HttpOnly; Path=/; SameSite=Strict; Secure`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict; Secure`;
}

export async function getUserSession(request, secret) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  const [data, signature] = match[1].split(".");
  if (!data || !signature) return null;

  const expected = await sign(data, secret);
  if (signature !== expected) return null;

  try {
    return JSON.parse(atob(data));
  } catch {
    return null;
  }
}
