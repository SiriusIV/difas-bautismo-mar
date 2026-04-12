function limpiarTexto(valor) {
  return String(valor || "").trim();
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

export async function enviarEmail(env, { to, subject, text, html }) {
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

  const payload = {
    from,
    to: [destinatario],
    subject: asunto,
    text: limpiarTexto(text),
    html: limpiarTexto(html)
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

    return {
      ok: true,
      skipped: false,
      provider: "resend",
      id: data?.id || ""
    };
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
  if (valor === "NO_ENVIADO") return "No enviado";
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

  lineas.push("", "Puedes consultar el estado actualizado desde la plataforma.");
  return lineas.join("\n");
}

export function construirEmailHtmlDocumentacionResuelta({ admin, centro, versionRequerida, estado, observaciones }) {
  const organizador = escaparHtml(nombreVisibleAdmin(admin));
  const estadoTexto = estado === "VALIDADA" ? "VALIDADA" : "RECHAZADA";
  const observacionesHtml = observaciones
    ? `<p><strong>Observaciones del administrador:</strong> ${escaparHtml(observaciones)}</p>`
    : "";

  return `
    <p>El estado de tu documentación general ha cambiado.</p>
    <p><strong>Organizador:</strong> ${organizador}</p>
    <p><strong>Centro:</strong> ${escaparHtml(centro?.centro || "")}</p>
    <p><strong>Estado actual:</strong> ${escaparHtml(estadoTexto)}</p>
    <p><strong>Versión documental:</strong> ${Number(versionRequerida || 0)}</p>
    ${observacionesHtml}
    <p>Puedes consultar el estado actualizado desde la plataforma.</p>
  `;
}
