function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function dbPrimaria(env) {
  if (typeof env?.DB?.withSession === "function") {
    return env.DB.withSession("first-primary");
  }
  return env.DB;
}

function hashTextoDeterminista(valor) {
  const texto = String(valor || "");
  let hash = 2166136261;
  for (let i = 0; i < texto.length; i += 1) {
    hash ^= texto.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function asegurarTablaDedupeEmail(env) {
  if (!env?.DB) return;

  await dbPrimaria(env).prepare(`
    CREATE TABLE IF NOT EXISTS email_envios_dedupe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      destinatario TEXT NOT NULL,
      asunto TEXT NOT NULL,
      huella TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await dbPrimaria(env).prepare(`
    CREATE INDEX IF NOT EXISTS idx_email_envios_dedupe_busqueda
    ON email_envios_dedupe (destinatario, asunto, huella, created_at DESC, id DESC)
  `).run();
}

async function existeCorreoRecienteDuplicado(env, {
  destinatario = "",
  asunto = "",
  huella = "",
  dedupeSegundos = 180
} = {}) {
  if (!env?.DB) return false;

  const ventana = Number(dedupeSegundos || 0);
  if (!(ventana > 0)) return false;

  const row = await dbPrimaria(env).prepare(`
    SELECT id
    FROM email_envios_dedupe
    WHERE destinatario = ?
      AND asunto = ?
      AND huella = ?
      AND datetime(created_at) >= datetime('now', ?)
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `).bind(destinatario, asunto, huella, `-${ventana} seconds`).first();

  return !!row?.id;
}

async function registrarCorreoParaDedupe(env, { destinatario = "", asunto = "", huella = "" } = {}) {
  if (!env?.DB) return;
  await dbPrimaria(env).prepare(`
    INSERT INTO email_envios_dedupe (destinatario, asunto, huella)
    VALUES (?, ?, ?)
  `).bind(destinatario, asunto, huella).run();
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function nombreVisibleAdmin(admin = {}) {
  return limpiarTexto(admin.nombre_publico || admin.nombre || admin.localidad || "Organizador");
}

export function esEmailConfigurable(env) {
  return !!limpiarTexto(env?.RESEND_API_KEY) && !!limpiarTexto(env?.EMAIL_FROM);
}

function construirAvisoCabeceraTexto() {
  return [
    "AVISO AUTOMATICO",
    "Este correo ha sido generado automaticamente por la plataforma. Por favor, no respondas a este mensaje.",
    ""
  ].join("\n");
}

function construirAvisoCabeceraHtml() {
  return `
    <div style="margin-bottom:16px;padding:12px 14px;border:1px solid #d9e2ec;border-radius:12px;background:#f8fafc;color:#445566;font-family:Arial,sans-serif;">
      <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#516274;margin-bottom:6px;">Aviso automático</div>
      <div style="font-size:13px;line-height:1.45;">Este correo ha sido generado automáticamente por la plataforma. Por favor, no respondas a este mensaje.</div>
    </div>
  `;
}

function envolverTextoAutomatico(texto) {
  const contenido = limpiarTexto(texto);
  if (!contenido) return construirAvisoCabeceraTexto().trim();
  return `${construirAvisoCabeceraTexto()}${contenido}`;
}

function envolverHtmlAutomatico(html) {
  const contenido = limpiarTexto(html);
  if (!contenido) return construirAvisoCabeceraHtml().trim();
  return `${construirAvisoCabeceraHtml()}${contenido}`;
}

export async function enviarEmail(env, {
  to,
  subject,
  text,
  html,
  dedupe = false,
  dedupeSegundos = 180
}) {
  const destinatario = limpiarTexto(to).toLowerCase();
  const asunto = limpiarTexto(subject);

  if (!destinatario || !asunto) {
    return {
      ok: false,
      skipped: true,
      error: "Faltan destinatario o asunto."
    };
  }

  const apiKey = limpiarTexto(env?.RESEND_API_KEY);
  const from = limpiarTexto(env?.EMAIL_FROM);

  if (!apiKey || !from) {
    return {
      ok: false,
      skipped: true,
      error: "Falta configurar RESEND_API_KEY o EMAIL_FROM."
    };
  }

  const textFinal = envolverTextoAutomatico(text);
  const htmlFinal = envolverHtmlAutomatico(html);

  if (dedupe && env?.DB) {
    await asegurarTablaDedupeEmail(env);
    const huella = hashTextoDeterminista(`${destinatario}|${asunto}|${textFinal}|${htmlFinal}`);
    const existeDuplicado = await existeCorreoRecienteDuplicado(env, {
      destinatario,
      asunto,
      huella,
      dedupeSegundos
    });
    if (existeDuplicado) {
      return {
        ok: true,
        skipped: true,
        duplicate: true,
        provider: "resend"
      };
    }
  }

  const payload = {
    from,
    to: [destinatario],
    subject: asunto,
    text: textFinal,
    html: htmlFinal
  };

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        error: data?.message || "No se pudo enviar el correo.",
        provider: "resend",
        response: data
      };
    }

    const resultado = {
      ok: true,
      skipped: false,
      provider: "resend",
      id: data?.id || ""
    };
    if (dedupe && env?.DB) {
      const huella = hashTextoDeterminista(`${destinatario}|${asunto}|${textFinal}|${htmlFinal}`);
      await registrarCorreoParaDedupe(env, { destinatario, asunto, huella });
    }
    return resultado;
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error.message || "Error al conectar con el proveedor de correo.",
      provider: "resend"
    };
  }
}

export function construirEmailTextoDocumentacionRemitida({ admin, centro, versionRequerida }) {
  const organizador = nombreVisibleAdmin(admin);
  return [
    "Se ha remitido nueva documentación general pendiente de revisión.",
    "",
    `Organizador: ${organizador}`,
    `Centro: ${limpiarTexto(centro?.centro)}`,
    `Correo del centro: ${limpiarTexto(centro?.email)}`,
    `Versión documental remitida: ${Number(versionRequerida || 0)}`,
    "",
    "La documentación ha quedado en revisión manual dentro de la plataforma."
  ].join("\n");
}

export function construirEmailHtmlDocumentacionRemitida({ admin, centro, versionRequerida }) {
  const organizador = escaparHtml(nombreVisibleAdmin(admin));
  return `
    <p>Se ha remitido nueva documentación general pendiente de revisión.</p>
    <p><strong>Organizador:</strong> ${organizador}</p>
    <p><strong>Centro:</strong> ${escaparHtml(centro?.centro || "")}</p>
    <p><strong>Correo del centro:</strong> ${escaparHtml(centro?.email || "")}</p>
    <p><strong>Versión documental remitida:</strong> ${Number(versionRequerida || 0)}</p>
    <p>La documentación ha quedado en revisión manual dentro de la plataforma.</p>
  `;
}

function etiquetaEstadoDocumentoEmail(estado) {
  const valor = limpiarTexto(estado).toUpperCase();
  if (valor === "VALIDADO") return "Validado";
  if (valor === "EN_REVISION") return "En revisión";
  if (valor === "RECHAZADO") return "Rechazado";
  if (valor === "NO_ACTUALIZADO") return "No actualizado";
  if (valor === "NO_ENVIADO") return "No presentado";
  return valor || "Sin estado";
}

export function construirEmailTextoDocumentacionRemitidaAgrupada({ admin, centro, versionRequerida, cambios = [] }) {
  const organizador = nombreVisibleAdmin(admin);
  const lineas = [
    "Se han guardado cambios en la documentación remitida por un centro.",
    "",
    `Organizador: ${organizador}`,
    `Centro: ${limpiarTexto(centro?.centro)}`,
    `Correo del centro: ${limpiarTexto(centro?.email)}`,
    `Versión documental vigente: ${Number(versionRequerida || 0)}`
  ];

  if (Array.isArray(cambios) && cambios.length) {
    lineas.push("", "Detalle de los documentos modificados:");
    cambios.forEach((item) => {
      lineas.push(`- ${limpiarTexto(item?.nombre)}: ${etiquetaEstadoDocumentoEmail(item?.estado)}`);
    });
  }

  lineas.push("", "La situación actual puede revisarse desde la plataforma.");
  return lineas.join("\n");
}

export function construirEmailHtmlDocumentacionRemitidaAgrupada({ admin, centro, versionRequerida, cambios = [] }) {
  const organizador = escaparHtml(nombreVisibleAdmin(admin));
  const filas = Array.isArray(cambios) && cambios.length
    ? cambios.map((item) => `
        <tr>
          <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(item?.nombre || "")}</td>
          <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(etiquetaEstadoDocumentoEmail(item?.estado))}</td>
        </tr>
      `).join("")
    : "";

  return `
    <p>Se han guardado cambios en la documentación remitida por un centro.</p>
    <p><strong>Organizador:</strong> ${organizador}</p>
    <p><strong>Centro:</strong> ${escaparHtml(centro?.centro || "")}</p>
    <p><strong>Correo del centro:</strong> ${escaparHtml(centro?.email || "")}</p>
    <p><strong>Versión documental vigente:</strong> ${Number(versionRequerida || 0)}</p>
    ${filas ? `
      <p><strong>Detalle de los documentos modificados</strong></p>
      <table style="border-collapse:collapse;width:100%;max-width:640px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Documento</th>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Estado</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    ` : ""}
    <p>La situación actual puede revisarse desde la plataforma.</p>
  `;
}

export function construirEmailTextoDocumentacionResuelta({ admin, centro, versionRequerida, estado, observaciones }) {
  const organizador = nombreVisibleAdmin(admin);
  const estadoTexto = estado === "VALIDADA" ? "VALIDADA" : "RECHAZADA";
  const lineas = [
    "El estado de tu documentación general ha cambiado.",
    "",
    `Organizador: ${organizador}`,
    `Centro: ${limpiarTexto(centro?.centro)}`,
    `Estado actual: ${estadoTexto}`,
    `Versión documental: ${Number(versionRequerida || 0)}`
  ];

  if (observaciones) {
    lineas.push(`Observaciones del administrador: ${observaciones}`);
  }

  if (estado === "VALIDADA") {
    lineas.push(
      "",
      "IMPORTANTE: Debes volver a iniciar el proceso de solicitud de la reserva de actividad."
    );
  }

  lineas.push("", "Puedes consultar el estado actualizado desde la plataforma.");
  return lineas.join("\n");
}

export function construirEmailHtmlDocumentacionResuelta({ admin, centro, versionRequerida, estado, observaciones }) {
  const organizador = escaparHtml(nombreVisibleAdmin(admin));
  const estadoTexto = estado === "VALIDADA" ? "VALIDADA" : "RECHAZADA";
  const observacionesHtml = observaciones
    ? `<p><strong>Observaciones del administrador:</strong> ${escaparHtml(observaciones)}</p>`
    : "";
  const avisoReinicioHtml = estado === "VALIDADA"
    ? `<p style="margin:12px 0;padding:10px 12px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;"><strong>Importante:</strong> Debes volver a iniciar el proceso de solicitud de la reserva de actividad.</p>`
    : "";

  return `
    <p>El estado de tu documentación general ha cambiado.</p>
    <p><strong>Organizador:</strong> ${organizador}</p>
    <p><strong>Centro:</strong> ${escaparHtml(centro?.centro || "")}</p>
    <p><strong>Estado actual:</strong> ${escaparHtml(estadoTexto)}</p>
    <p><strong>Versión documental:</strong> ${Number(versionRequerida || 0)}</p>
    ${observacionesHtml}
    ${avisoReinicioHtml}
    <p>Puedes consultar el estado actualizado desde la plataforma.</p>
  `;
}

export function construirEmailTextoCambioMarcoDocumental({
  admin,
  secretaria,
  centro,
  totalDocumentos = 0
}) {
  const organizador = nombreVisibleAdmin(admin);
  const secretariaNombre = limpiarTexto(secretaria?.nombre_publico || secretaria?.nombre || "la secretaría responsable");
  const cantidad = Number(totalDocumentos || 0);

  return [
    "La documentación obligatoria asociada a este organizador ha cambiado.",
    "",
    `Organizador: ${organizador}`,
    `Centro: ${limpiarTexto(centro?.centro)}`,
    `Nueva gestión documental: ${secretariaNombre}`,
    cantidad > 0
      ? `Ahora debes presentar ${cantidad} documento(s) del nuevo marco documental.`
      : "Actualmente no hay documentos base activos en el nuevo marco documental.",
    "",
    "La documentación anterior deja de ser aplicable para este organizador.",
    "Accede a tu perfil de usuario para revisar la nueva documentación obligatoria y remitirla de nuevo si procede."
  ].join("\n");
}

export function construirEmailHtmlCambioMarcoDocumental({
  admin,
  secretaria,
  centro,
  totalDocumentos = 0
}) {
  const organizador = escaparHtml(nombreVisibleAdmin(admin));
  const secretariaNombre = escaparHtml(secretaria?.nombre_publico || secretaria?.nombre || "la secretaría responsable");
  const cantidad = Number(totalDocumentos || 0);

  return `
    <p>La documentación obligatoria asociada a este organizador ha cambiado.</p>
    <p><strong>Organizador:</strong> ${organizador}</p>
    <p><strong>Centro:</strong> ${escaparHtml(centro?.centro || "")}</p>
    <p><strong>Nueva gestión documental:</strong> ${secretariaNombre}</p>
    <p>${
      cantidad > 0
        ? `Ahora debes presentar <strong>${cantidad}</strong> documento(s) del nuevo marco documental.`
        : "Actualmente no hay documentos base activos en el nuevo marco documental."
    }</p>
    <p>La documentación anterior deja de ser aplicable para este organizador.</p>
    <p>Accede a tu perfil de usuario para revisar la nueva documentación obligatoria y remitirla de nuevo si procede.</p>
  `;
}
