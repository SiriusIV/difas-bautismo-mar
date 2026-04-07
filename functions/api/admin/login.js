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

const { results } = await env.DB.prepare(`
  SELECT id, rol, email, nombre, centro, logo_url, web_externa_url
  FROM usuarios
  WHERE email = ?
    AND activo = 1
    AND rol IN ('ADMIN', 'SUPERADMIN')
  LIMIT 1
`)
.bind(username)
.all();

if (!results || results.length === 0) {
  return json(
    {
      ok: false,
      error: "El usuario administrador no existe en la base de datos."
    },
    { status: 401 }
  );
}

const usuario_id = results[0].id;
const rol = results[0].rol;


    
    const cookie = await createSessionCookie(env, username, usuario_id, rol);

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
