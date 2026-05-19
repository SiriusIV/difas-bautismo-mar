import {
  asegurarTablaResetPassword,
  hashPassword,
  hashToken,
  limpiarTexto,
  mensajePoliticaPassword,
  validarPoliticaPassword
} from "./_password.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function obtenerResetVigente(db, tokenPlano) {
  const tokenHash = await hashToken(tokenPlano);

  return await db.prepare(`
    SELECT
      prt.id,
      prt.user_id,
      prt.expires_at,
      u.email,
      u.activo
    FROM password_reset_tokens prt
    INNER JOIN usuarios u ON u.id = prt.user_id
    WHERE prt.token_hash = ?
      AND prt.used_at IS NULL
      AND datetime(prt.expires_at) >= datetime('now')
    LIMIT 1
  `).bind(tokenHash).first();
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    await asegurarTablaResetPassword(env.DB);
    const url = new URL(request.url);
    const token = limpiarTexto(url.searchParams.get("token"));

    if (!token) {
      return json({ ok: false, error: "Falta el token de recuperación." }, 400);
    }

    const reset = await obtenerResetVigente(env.DB, token);

    if (!reset || Number(reset.activo || 0) !== 1) {
      return json({ ok: false, error: "El enlace de recuperación no es válido o ha caducado." }, 404);
    }

    return json({
      ok: true,
      email: reset.email || ""
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudo validar el enlace de recuperación.",
      detalle: error.message
    }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    await asegurarTablaResetPassword(env.DB);
    const body = await request.json();
    const token = limpiarTexto(body.token);
    const passwordNueva = String(body.password_nueva || "");

    if (!token || !passwordNueva) {
      return json({ ok: false, error: "Faltan datos obligatorios." }, 400);
    }

    const validacion = validarPoliticaPassword(passwordNueva);
    if (!validacion.ok) {
      return json({
        ok: false,
        error: mensajePoliticaPassword(),
        detalles: validacion.errores
      }, 400);
    }

    const reset = await obtenerResetVigente(env.DB, token);

    if (!reset || Number(reset.activo || 0) !== 1) {
      return json({ ok: false, error: "El enlace de recuperación no es válido o ha caducado." }, 404);
    }

    const nuevaHash = await hashPassword(passwordNueva);

    await env.DB.prepare(`
      UPDATE usuarios
      SET password_hash = ?
      WHERE id = ?
    `).bind(nuevaHash, reset.user_id).run();

    await env.DB.prepare(`
      UPDATE password_reset_tokens
      SET used_at = datetime('now')
      WHERE user_id = ?
        AND used_at IS NULL
    `).bind(reset.user_id).run();

    return json({
      ok: true,
      mensaje: "Contraseña restablecida correctamente."
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudo restablecer la contraseña.",
      detalle: error.message
    }, 500);
  }
}
