import { clearSessionCookie } from "./_auth.js";

export async function onRequestPost() {
  return new Response(
    JSON.stringify({
      ok: true,
      mensaje: "Sesión cerrada correctamente."
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": clearSessionCookie()
      }
    }
  );
}
