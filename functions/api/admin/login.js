import { createSessionCookie } from "./_auth.js";
import { asegurarColumnaForzarCambioPassword } from "../usuario/_password.js";

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
    await asegurarColumnaForzarCambioPassword(env.DB);

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
      SELECT id, rol, email, nombre, nombre_publico, centro, logo_url, web_externa_url, telefono_contacto, forzar_cambio_password
      FROM usuarios
      WHERE email = ?
        AND activo = 1
        AND rol IN ('ADMIN', 'SUPERADMIN', 'SECRETARIA')
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

    const usuario = results[0];
    const usuario_id = usuario.id;
    const rol = usuario.rol;
    const requiereCambioPassword = Number(usuario.forzar_cambio_password || 0) === 1;

    const cookie = await createSessionCookie(env, username, usuario_id, rol, {
      nombre: usuario.nombre || "",
      nombre_publico: usuario.nombre_publico || "",
      centro: usuario.centro || "",
      logo_url: usuario.logo_url || "",
      web_externa_url: usuario.web_externa_url || "",
      telefono_contacto: usuario.telefono_contacto || "",
      forzar_cambio_password: requiereCambioPassword ? 1 : 0
    });

    return new Response(
      JSON.stringify({
        ok: true,
        mensaje: "Sesión iniciada correctamente.",
        requiere_cambio_password: requiereCambioPassword,
        redirect_to: requiereCambioPassword
          ? "/usuario-perfil.html?forzar_password=1"
          : (rol === "SECRETARIA" ? "/usuario-perfil.html" : "/admin-reservas.html")
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
