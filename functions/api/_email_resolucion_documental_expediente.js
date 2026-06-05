function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function etiquetaEstado(estado) {
  const valor = limpiarTexto(estado)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (valor === "VALIDADO" || valor === "VALIDADA" || valor === "APROBADA") return "Aprobado";
  if (valor === "RECHAZADO" || valor === "RECHAZADA") return "Rechazado";
  if (valor === "EN_REVISION" || valor === "EN REVISION") return "En revision";
  if (valor === "NO_ACTUALIZADO") return "Desactualizado";
  if (valor === "NO_ENVIADO" || valor === "NO_INICIADO") return "No presentado";
  return valor || "Sin estado";
}

function normalizarActividades(resumenActividades = {}) {
  const solicitables = Array.isArray(resumenActividades.solicitables)
    ? resumenActividades.solicitables
    : [];

  return solicitables
    .map((item) => {
      if (typeof item === "string") {
        return { actividad: limpiarTexto(item), organizador: "" };
      }
      return {
        actividad: limpiarTexto(item?.actividad || item?.nombre || ""),
        organizador: limpiarTexto(item?.organizador || item?.admin_nombre || "")
      };
    })
    .filter((item) => item.actividad);
}

function normalizarCambios(cambios = []) {
  return (Array.isArray(cambios) ? cambios : [])
    .map((cambio) => ({
      documento: limpiarTexto(cambio?.nombre_documento || cambio?.documento || ""),
      estado: etiquetaEstado(cambio?.estado),
      observaciones: limpiarTexto(cambio?.observaciones_admin || cambio?.observaciones || "")
    }))
    .filter((cambio) => cambio.documento);
}

export function construirEmailTextoResolucionExpedienteDocumental({
  cambios = [],
  resumen_actividades = null
}) {
  const filasRevision = normalizarCambios(cambios);
  const actividades = normalizarActividades(resumen_actividades || {});

  const lineas = [
    "La documentacion obligatoria que has remitido ha sido revisada.",
    "",
    "Detalle de la revision:"
  ];

  if (filasRevision.length) {
    filasRevision.forEach((fila) => {
      lineas.push(`- Documento: ${fila.documento}`);
      lineas.push(`  Estado: ${fila.estado}`);
      lineas.push(`  Observaciones: ${fila.observaciones || "-"}`);
    });
  } else {
    lineas.push("- No constan cambios de estado documental en esta revision.");
  }

  lineas.push("", "Actividades disponibles para su solicitud:");
  if (actividades.length) {
    actividades.forEach((item) => {
      lineas.push(`- ${item.actividad}${item.organizador ? ` (Organizador: ${item.organizador})` : ""}`);
    });
    lineas.push("", "IMPORTANTE: Debe volver a realizar la solicitud de la actividad en la que se va a participar.");
  } else {
    lineas.push(
      "Con la documentacion actualmente presentada aun no tienes acceso a solicitar ninguna actividad de las que requieren reserva."
    );
  }

  lineas.push("", "Puedes acceder a la plataforma para consultar el resultado detallado.");
  return lineas.join("\n");
}

export function construirEmailHtmlResolucionExpedienteDocumental({
  cambios = [],
  resumen_actividades = null
}) {
  const filasRevision = normalizarCambios(cambios);
  const actividades = normalizarActividades(resumen_actividades || {});

  const tablaRevision = filasRevision.length
    ? `
      <table style="border-collapse:collapse;width:100%;max-width:760px;margin:8px 0 16px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Documento</th>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Estado</th>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Observaciones</th>
          </tr>
        </thead>
        <tbody>
          ${filasRevision.map((fila) => `
            <tr>
              <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(fila.documento)}</td>
              <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(fila.estado)}</td>
              <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(fila.observaciones || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `
    : `<p>No constan cambios de estado documental en esta revision.</p>`;

  const bloqueActividades = actividades.length
    ? `
      <div style="margin:14px 0;padding:14px 16px;border-radius:8px;border:1px solid #cfe1f5;background:#f3f8ff;color:#173b62;">
        <p style="margin:0 0 10px;"><strong>Actividades disponibles para su solicitud</strong></p>
        <table style="border-collapse:collapse;width:100%;max-width:760px;background:#ffffff;">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#edf4fb;">Actividad</th>
              <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#edf4fb;">Organizador</th>
            </tr>
          </thead>
          <tbody>
            ${actividades.map((item) => `
              <tr>
                <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(item.actividad)}</td>
                <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(item.organizador || "-")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div style="margin:12px 0 0;padding:10px 12px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-right:8px;border-radius:999px;background:#f5b400;color:#1f1f1f;font-weight:700;">!</span>
          <strong>Debe volver a realizar la solicitud de la actividad en la que se va a participar.</strong>
        </div>
      </div>
    `
    : `
      <div style="margin:14px 0;padding:14px 16px;border-radius:8px;border:1px solid #cfe1f5;background:#f3f8ff;color:#173b62;">
        <p style="margin:0;"><strong>Con la documentacion actualmente presentada aun no tienes acceso a solicitar ninguna actividad de las que requieren reserva.</strong></p>
      </div>
    `;

  return `
    <p>La documentacion obligatoria que has remitido ha sido revisada.</p>
    <p><strong>Detalle de la revision</strong></p>
    ${tablaRevision}
    ${bloqueActividades}
    <p>Puedes acceder a la plataforma para consultar el resultado detallado.</p>
  `;
}
