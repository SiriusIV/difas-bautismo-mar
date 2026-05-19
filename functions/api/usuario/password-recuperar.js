import { enviarEmail } from "../_email.js";
import {
  asegurarTablaResetPassword,
  generarTokenSeguro,
  hashToken,
  limpiarTexto
} from "./_password.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function construirEmailRecuperacionTexto({ enlace, horasValidez = 2 }) {
  return [
    "Hemos recibido una solicitud para restablecer tu contraseña.",
    "",
    `Este enlace estará disponible durante ${horasValidez} horas:`,
    enlace,
    "",
    "Si no has solicitado este cambio, puedes ignorar este mensaje."
  ].join("\n");
}

function construirEmailRecuperacionHtml({ enlace, horasValidez = 2 }) {
  return `
    <p>Hemos recibido una solicitud para restablecer tu contraseña.</p>
    <p>Este enlace estará disponible durante <strong>${Number(horasValidez || 2)}</strong> horas.</p>
    <p><a href="${enlace}" target="_blank" rel="noopener noreferrer">Restablecer contraseña</a></p>
    <p>Si no has solicitado este cambio, puedes ignorar este mensaje.</p>
  `;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const email = limpiarTexto(body.email).toLowerCase();

    if (!email) {
      return json({ ok: false, error: "Debes indicar un correo electrónico." }, 400);
    }

    await asegurarTablaResetPassword(env.DB);

    const usuario = await env.DB.prepare(`
      SELECT id, email, activo
      FROM usuarios
      WHERE lower(trim(email)) = ?
      LIMIT 1
    `).bind(email).first();

    if (!usuario) {
      return json({
        ok: false,
        error: "Ese usuario no está registrado en el sistema."
      }, 404);
    }

    if (Number(usuario.activo || 0) !== 1) {
      return json({
        ok: false,
        error: "La cuenta existe pero está inactiva y no puede recuperar la contraseña."
      }, 403);
    }

    const tokenPlano = generarTokenSeguro(32);
    const tokenHash = await hashToken(tokenPlano);
    const baseUrl = new URL(request.url).origin;
    const enlace = `${baseUrl}/usuario-password-restablecer.html?token=${encodeURIComponent(tokenPlano)}`;

    await env.DB.prepare(`
      UPDATE password_reset_tokens
      SET used_at = datetime('now')
      WHERE user_id = ?
        AND used_at IS NULL
    `).bind(usuario.id).run();

    await env.DB.prepare(`
      INSERT INTO password_reset_tokens (
        user_id,
        token_hash,
        expires_at
      )
      VALUES (?, ?, datetime('now', '+2 hours'))
    `).bind(usuario.id, tokenHash).run();

    const envio = await enviarEmail(env, {
      to: usuario.email,
      subject: "Restablecer contraseña",
      text: construirEmailRecuperacionTexto({ enlace }),
      html: construirEmailRecuperacionHtml({ enlace })
    });

    if (!envio.ok) {
      return json({
        ok: false,
        error: envio.skipped
          ? "La recuperación de contraseña no está disponible en este momento porque falta configurar el servicio de correo."
          : (envio.error || "No se pudo enviar el correo de recuperación."),
        detalle: envio.error || ""
      }, 503);
    }

    return json({
      ok: true,
      mensaje: "Te hemos enviado un enlace de recuperación al correo registrado en el sistema."
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudo iniciar la recuperación de contraseña.",
      detalle: error.message
    }, 500);
  }
}
