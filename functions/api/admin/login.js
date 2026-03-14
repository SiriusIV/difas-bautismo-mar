import { createSessionCookie } from "./_auth.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    ...init
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();

    if (!username || !password) {
      return json(
        {
          ok: false,
          error: "Faltan credenciales."
        },
        { status: 400 }
      );
    }

    if (
      username !== String(env.ADMIN_USER || "") ||
      password !== String(env.ADMIN_PASSWORD || "")
    ) {
      return json(
        {
          ok: false,
          error: "Usuario o contraseña incorrectos."
        },
        { status: 401 }
      );
    }

    const cookie = await createSessionCookie(env, username);

    return new Response(
      JSON.stringify({
        ok: true,
        mensaje: "Sesión iniciada correctamente."
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": cookie
        }
      }
    );
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al iniciar sesión.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
