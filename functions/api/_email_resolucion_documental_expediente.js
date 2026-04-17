import { nombreVisibleAdmin } from "./_email.js";

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

function etiquetaEstado(estado) {
  const e = limpiarTexto(estado).toUpperCase();
  if (e === "VALIDADO") return "Validado";
  if (e === "RECHAZADO") return "Rechazado";
  if (e === "EN_REVISION") return "En revisión";
  return e || "Sin estado";
}

export function construirEmailTextoResolucionExpedienteDocumental({
  admin,
  centro,
  estado_expediente,
  cambios = []
}) {
  const lineas = [
    "El estado de tu documentación obligatoria ha sido revisado.",
    "",
    `Organizador: ${nombreVisibleAdmin(admin)}`,
    `Centro: ${limpiarTexto(centro?.centro)}`,
    `Estado del expediente: ${limpiarTexto(estado_expediente)}`
  ];

  if (Array.isArray(cambios) && cambios.length) {
    lineas.push("", "Detalle de la revisión:");
    cambios.forEach((cambio) => {
      lineas.push(`- ${limpiarTexto(cambio?.nombre_documento)}: ${etiquetaEstado(cambio?.estado)}`);
      if (limpiarTexto(cambio?.observaciones_admin)) {
        lineas.push(`  Observaciones: ${limpiarTexto(cambio?.observaciones_admin)}`);
      }
    });
  }

  lineas.push("", "Puedes acceder a la plataforma para consultar el resultado detallado.");
  return lineas.join("\n");
}

export function construirEmailHtmlResolucionExpedienteDocumental({
  admin,
  centro,
  estado_expediente,
  cambios = []
}) {
  const filas = (Array.isArray(cambios) ? cambios : []).map((cambio) => `
    <tr>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(cambio?.nombre_documento || "")}</td>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(etiquetaEstado(cambio?.estado))}</td>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(cambio?.observaciones_admin || "")}</td>
    </tr>
  `).join("");

  return `
    <p>El estado de tu documentación obligatoria ha sido revisado.</p>
    <p><strong>Organizador:</strong> ${escaparHtml(nombreVisibleAdmin(admin))}</p>
    <p><strong>Centro:</strong> ${escaparHtml(centro?.centro || "")}</p>
    <p><strong>Estado del expediente:</strong> ${escaparHtml(estado_expediente || "")}</p>
    ${filas ? `
      <p><strong>Detalle de la revisión</strong></p>
      <table style="border-collapse:collapse;width:100%;max-width:760px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Documento</th>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Estado</th>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Observaciones</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    ` : ""}
    <p>Puedes acceder a la plataforma para consultar el resultado detallado.</p>
  `;
}
