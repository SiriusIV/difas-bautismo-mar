import { getAdminSession } from "./_auth.js";
import { enviarEmail } from "../_email.js";
import { asegurarColumnaForzarCambioPassword, hashPassword } from "../usuario/_password.js";
import {
  asegurarTablaSolicitudesArmada,
  generarPasswordTemporal,
  limpiarTexto,
  normalizarCentro
} from "./_solicitudes_armada.js";

async function asegurarColumnaUsuarioCargoPuesto(db) {
  try {
    await db.prepare("ALTER TABLE usuarios ADD COLUMN cargo_puesto TEXT").run();
  } catch (error) {
    const detalle = String(error?.message || "").toLowerCase();
    if (
      detalle.includes("duplicate column name") ||
      detalle.includes("duplicate") ||
      detalle.includes("already exists")
    ) {
      return;
    }
    throw error;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function construirCorreoAltaArmadaTexto({ unidad, cargoPuesto, email, passwordTemporal, baseUrl }) {
  const lineas = [
    "Tu solicitud de Usuario Armada ha sido aprobada.",
    "",
    `Unidad / dependencia: ${unidad}`,
    `Correo de acceso: ${email}`
  ];

  if (cargoPuesto) {
    lineas.push(`Cargo / puesto: ${cargoPuesto}`);
  }

  lineas.push(
    `Código temporal de un solo uso: ${passwordTemporal}`,
    "",
    `Accede desde: ${baseUrl}/portal.html`,
    "Una vez inicies sesión con ese código temporal, el sistema te obligará a crear una contraseña personal antes de poder continuar.",
    "",
    "Si no reconoces esta solicitud, contacta con la administración de la plataforma."
  );

  return lineas.join("\n");
}

function construirCorreoAltaArmadaHtml({ unidad, cargoPuesto, email, passwordTemporal, baseUrl }) {
  return `
    <p>Tu solicitud de <strong>Usuario Armada</strong> ha sido aprobada.</p>
    <p><strong>Unidad / dependencia:</strong> ${escaparHtml(unidad)}</p>
    ${cargoPuesto ? `<p><strong>Cargo / puesto:</strong> ${escaparHtml(cargoPuesto)}</p>` : ""}
    <p><strong>Correo de acceso:</strong> ${escaparHtml(email)}</p>
    <p><strong>Código temporal de un solo uso:</strong> <span style="font-size:16px;font-weight:700;">${escaparHtml(passwordTemporal)}</span></p>
    <p><a href="${escaparHtml(baseUrl)}/portal.html" target="_blank" rel="noopener noreferrer">Acceder al portal</a></p>
    <p>Una vez inicies sesión con ese código temporal, el sistema te obligará a crear una contraseña personal antes de poder continuar.</p>
    <p>Si no reconoces esta solicitud, contacta con la administración de la plataforma.</p>
  `;
}

function construirCorreoRechazoTexto({ unidad, cargoPuesto, motivo }) {
  const lineas = [
    "Tu solicitud de Usuario Armada ha sido rechazada.",
    "",
    `Unidad / dependencia: ${unidad}`
  ];

  if (cargoPuesto) {
    lineas.push(`Cargo / puesto: ${cargoPuesto}`);
  }

  lineas.push(
    "",
    "Observaciones del superadministrador:",
    motivo,
    "",
    "Si deseas volver a intentarlo, deberás generar una nueva solicitud desde el portal."
  );

  return lineas.join("\n");
}

function construirCorreoRechazoHtml({ unidad, cargoPuesto, motivo }) {
  return `
    <p>Tu solicitud de <strong>Usuario Armada</strong> ha sido rechazada.</p>
    <p><strong>Unidad / dependencia:</strong> ${escaparHtml(unidad)}</p>
    ${cargoPuesto ? `<p><strong>Cargo / puesto:</strong> ${escaparHtml(cargoPuesto)}</p>` : ""}
    <p><strong>Observaciones del superadministrador:</strong></p>
    <p>${escaparHtml(motivo)}</p>
    <p>Si deseas volver a intentarlo, deberás generar una nueva solicitud desde el portal.</p>
  `;
}

async function enviarCorreoAprobacion(env, request, solicitud, passwordTemporal) {
  const email = limpiarTexto(solicitud.email).toLowerCase();
  const baseUrl = new URL(request.url).origin;

  return await enviarEmail(env, {
    to: email,
    subject: "Aprobación de cuenta Usuario Armada",
    text: construirCorreoAltaArmadaTexto({
      unidad: limpiarTexto(solicitud.centro),
      cargoPuesto: limpiarTexto(solicitud.cargo_puesto),
      email,
      passwordTemporal,
      baseUrl
    }),
    html: construirCorreoAltaArmadaHtml({
      unidad: limpiarTexto(solicitud.centro),
      cargoPuesto: limpiarTexto(solicitud.cargo_puesto),
      email,
      passwordTemporal,
      baseUrl
    })
  });
}

async function enviarCorreoRechazo(env, solicitud, motivo) {
  const email = limpiarTexto(solicitud.email).toLowerCase();
  return await enviarEmail(env, {
    to: email,
    subject: "Rechazo de solicitud Usuario Armada",
    text: construirCorreoRechazoTexto({
      unidad: limpiarTexto(solicitud.centro),
      cargoPuesto: limpiarTexto(solicitud.cargo_puesto),
      motivo
    }),
    html: construirCorreoRechazoHtml({
      unidad: limpiarTexto(solicitud.centro),
      cargoPuesto: limpiarTexto(solicitud.cargo_puesto),
      motivo
    })
  });
}

function errorCorreo(envio, mensajeConfiguracion, mensajeEnvio) {
  return json({
    ok: false,
    error: envio.skipped ? mensajeConfiguracion : (envio.error || mensajeEnvio),
    detalle: envio.error || ""
  }, 503);
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

    await asegurarTablaSolicitudesArmada(env.DB);
    await asegurarColumnaForzarCambioPassword(env.DB);
    await asegurarColumnaUsuarioCargoPuesto(env.DB);

    const body = await request.json().catch(() => ({}));
    const solicitudId = Number(body.solicitud_id || 0);
    const accion = limpiarTexto(body.accion).toUpperCase();
    const motivo = limpiarTexto(body.motivo);

    if (!solicitudId || !["APROBAR", "RECHAZAR"].includes(accion)) {
      return json({ ok: false, error: "Datos de resolución no válidos" }, 400);
    }

    if (accion === "RECHAZAR" && !motivo) {
      return json({ ok: false, error: "Las observaciones son obligatorias para rechazar una solicitud." }, 400);
    }

    const solicitud = await env.DB.prepare(`
      SELECT *
      FROM solicitudes_registro_armada
      WHERE id = ?
      LIMIT 1
    `).bind(solicitudId).first();

    if (!solicitud) {
      return json({ ok: false, error: "Solicitud no encontrada" }, 404);
    }

    if (String(solicitud.estado || "").toUpperCase() !== "PENDIENTE") {
      return json({ ok: false, error: "La solicitud ya no está pendiente de resolución." }, 400);
    }

    if (accion === "RECHAZAR") {
      const envio = await enviarCorreoRechazo(env, solicitud, motivo);
      if (!envio.ok) {
        return errorCorreo(
          envio,
          "No se pudo rechazar la solicitud porque el servicio de correo no está configurado.",
          "No se pudo enviar el correo de rechazo al solicitante."
        );
      }

      await env.DB.prepare(`
        DELETE FROM solicitudes_registro_armada
        WHERE id = ?
      `).bind(solicitudId).run();

      return json({
        ok: true,
        estado: "RECHAZADA",
        mensaje: "Solicitud rechazada correctamente. Se ha enviado el correo al solicitante."
      });
    }

    const email = limpiarTexto(solicitud.email).toLowerCase();
    const centroNormalizado = normalizarCentro(solicitud.centro);

    const existingEmail = await env.DB.prepare(`
      SELECT id
      FROM usuarios
      WHERE email = ?
      LIMIT 1
    `).bind(email).first();

    if (existingEmail) {
      return json({ ok: false, error: "Ya existe un usuario con ese correo electrónico." }, 400);
    }

    const existingCentro = await env.DB.prepare(`
      SELECT id
      FROM usuarios
      WHERE UPPER(TRIM(centro)) = ?
        AND rol IN ('ADMIN', 'SUPERADMIN')
      LIMIT 1
    `).bind(centroNormalizado).first();

    if (existingCentro) {
      return json({ ok: false, error: "Ya existe una cuenta administrativa asociada a esa unidad o dependencia." }, 400);
    }

    const passwordTemporal = generarPasswordTemporal();
    const passwordHash = await hashPassword(passwordTemporal);

    const creado = await env.DB.prepare(`
      INSERT INTO usuarios (
        nombre,
        centro,
        localidad,
        email,
        password_hash,
        rol,
        telefono_contacto,
        responsable_legal,
        cargo_puesto,
        tipo_documento,
        documento_identificacion,
        forzar_cambio_password,
        activo,
        fecha_alta
      )
      VALUES (?, ?, ?, ?, ?, 'ADMIN', ?, ?, ?, ?, ?, 1, 1, datetime('now'))
    `).bind(
      limpiarTexto(solicitud.responsable_legal) || limpiarTexto(solicitud.centro),
      limpiarTexto(solicitud.centro),
      limpiarTexto(solicitud.localidad),
      email,
      passwordHash,
      limpiarTexto(solicitud.telefono_contacto),
      limpiarTexto(solicitud.responsable_legal),
      limpiarTexto(solicitud.cargo_puesto),
      limpiarTexto(solicitud.tipo_documento).toUpperCase(),
      limpiarTexto(solicitud.documento_identificacion).toUpperCase()
    ).run();

    const usuarioCreadoId = Number(creado.meta?.last_row_id || 0);
    const envio = await enviarCorreoAprobacion(env, request, solicitud, passwordTemporal);

    if (!envio.ok) {
      await env.DB.prepare(`
        DELETE FROM usuarios
        WHERE id = ?
      `).bind(usuarioCreadoId).run();

      return errorCorreo(
        envio,
        "No se pudo aprobar la solicitud porque el servicio de correo no está configurado.",
        "No se pudo enviar el correo al solicitante."
      );
    }

    await env.DB.prepare(`
      DELETE FROM solicitudes_registro_armada
      WHERE id = ?
    `).bind(solicitudId).run();

    return json({
      ok: true,
      estado: "APROBADA",
      mensaje: "Solicitud aprobada correctamente. Se ha enviado el código temporal al correo del solicitante."
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error resolviendo la solicitud de Usuario Armada",
      detalle: error.message
    }, 500);
  }
}
