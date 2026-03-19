import { clearSessionCookie } from "./_auth.js";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

export async function onRequestPost() {
  return json(
    { ok: true, mensaje: "Sesión cerrada" },
    200,
    { "Set-Cookie": clearSessionCookie() }
  );
}
