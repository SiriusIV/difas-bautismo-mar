import { createSessionCookie, getUserSession } from "./_auth.js";
import {
  asegurarColumnaForzarCambioPassword,
  hashPassword,
  mensajePoliticaPassword,
  validarPoliticaPassword
} from "./_password.js";

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

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    await asegurarColumnaForzarCambioPassword(env.DB);

    if (!session || !session.id) {
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    const body = await request.json();
    const passwordActual = limpiarTexto(body.password_actual);
    const passwordNueva = limpiarTexto(body.password_nueva);
    const soloValidar = Number(body.solo_validar || 0) === 1;

    if (!passwordActual || (!soloValidar && !passwordNueva)) {
      return json({ ok: false, error: "Faltan datos obligatorios" }, 400);
    }

    const user = await env.DB.prepare(`
      SELECT
        id,
        password_hash
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(session.id).first();

    if (!user) {
      return json({ ok: false, error: "Usuario no encontrado" }, 404);
    }

    const actualHash = await hashPassword(passwordActual);

    if (String(user.password_hash || "") !== actualHash) {
      return json({ ok: false, error: "La contraseÃ±a actual no es correcta" }, 400);
    }

    if (soloValidar) {
      return json({
        ok: true,
        mensaje: "ContraseÃ±a actual validada correctamente"
      });
    }

    const validacionPassword = validarPoliticaPassword(passwordNueva);
    if (!validacionPassword.ok) {
      return json({
        ok: false,
        error: mensajePoliticaPassword(),
        detalles: validacionPassword.errores
      }, 400);
    }

    const nuevaHash = await hashPassword(passwordNueva);

    await env.DB.prepare(`
      UPDATE usuarios
      SET password_hash = ?,
          forzar_cambio_password = 0
      WHERE id = ?
    `).bind(nuevaHash, user.id).run();

    const cookie = await createSessionCookie(
      {
        ...session,
        forzar_cambio_password: 0
      },
      env.SECRET_KEY
    );

    return json(
      {
        ok: true,
        mensaje: "ContraseÃ±a actualizada correctamente"
      },
      200,
      { "Set-Cookie": cookie }
    );
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al cambiar la contraseÃ±a",
        detalle: error.message
      },
      500
    );
  }
}
