import { getAdminSession } from "./_auth.js";
import { enviarEmail } from "../_email.js";
import { asegurarColumnaForzarCambioPassword, hashPassword } from "../usuario/_password.js";
import { generarPasswordTemporal } from "./_solicitudes_armada.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function escapeHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function construirCorreo(admin, passwordTemporal, baseUrl) {
  const nombre = limpiarTexto(admin?.nombre || "administrador");
  const texto = [
    `Hola ${nombre},`,
    "",
    "El superadministrador ha generado una nueva contraseña temporal de un solo uso para tu cuenta.",
    "",
    `Correo de acceso: ${limpiarTexto(admin?.email || "")}`,
    `Código temporal: ${passwordTemporal}`,
    "",
    `Accede desde: ${baseUrl}/portal.html`,
    "Al iniciar sesión tendrás que definir una nueva contraseña personal."
  ].join("\n");

  const html = `
    <p>Hola ${escapeHtml(nombre)},</p>
    <p>El superadministrador ha generado una nueva contraseña temporal de un solo uso para tu cuenta.</p>
    <p><strong>Correo de acceso:</strong> ${escapeHtml(limpiarTexto(admin?.email || ""))}</p>
    <p><strong>Código temporal:</strong> <span style="font-size:16px;font-weight:700;">${escapeHtml(passwordTemporal)}</span></p>
    <p><a href="${escapeHtml(baseUrl)}/portal.html" target="_blank" rel="noopener noreferrer">Acceder al portal</a></p>
    <p>Al iniciar sesión tendrás que definir una nueva contraseña personal.</p>
  `;

  return {
    subject: "Nueva contraseña temporal de administrador",
    text: texto,
    html
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    if (String(session.rol || "").toUpperCase() !== "SUPERADMIN") {
      return json({ ok: false, error: "Solo SUPERADMIN" }, 403);
    }

    await asegurarColumnaForzarCambioPassword(env.DB);

    const body = await request.json().catch(() => ({}));
    const adminId = Number(body.usuario_id || 0);
    if (!(adminId > 0)) {
      return json({ ok: false, error: "Administrador no válido." }, 400);
    }

    const admin = await env.DB.prepare(`
      SELECT id, nombre, email, rol, password_hash, forzar_cambio_password
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(adminId).first();

    if (!admin || String(admin.rol || "").toUpperCase() !== "ADMIN") {
      return json({ ok: false, error: "Administrador no encontrado." }, 404);
    }

    const passwordTemporal = generarPasswordTemporal();
    const passwordHash = await hashPassword(passwordTemporal);

    await env.DB.prepare(`
      UPDATE usuarios
      SET password_hash = ?,
          forzar_cambio_password = 1
      WHERE id = ?
        AND rol = 'ADMIN'
    `).bind(passwordHash, adminId).run();

    const baseUrl = new URL(request.url).origin;
    const correo = construirCorreo(admin, passwordTemporal, baseUrl);
    const envio = await enviarEmail(env, {
      to: limpiarTexto(admin.email),
      subject: correo.subject,
      text: correo.text,
      html: correo.html
    });

    if (!envio.ok) {
      await env.DB.prepare(`
        UPDATE usuarios
        SET password_hash = ?,
            forzar_cambio_password = ?
        WHERE id = ?
          AND rol = 'ADMIN'
      `).bind(
        admin.password_hash || "",
        Number(admin.forzar_cambio_password || 0) === 1 ? 1 : 0,
        adminId
      ).run();

      return json({
        ok: false,
        error: envio.skipped
          ? "No se pudo enviar la contraseña temporal porque el servicio de correo no está configurado."
          : (envio.error || "No se pudo enviar el correo al administrador."),
        detalle: envio.error || ""
      }, 503);
    }

    return json({
      ok: true,
      mensaje: "Se ha enviado una nueva contraseña temporal al administrador."
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error generando la contraseña temporal del administrador.",
      detalle: error.message
    }, 500);
  }
}

