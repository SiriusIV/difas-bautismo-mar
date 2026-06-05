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

function normalizarReservasRechazadas(reservas = []) {
  return (Array.isArray(reservas) ? reservas : [])
    .map((reserva) => ({
      codigo: limpiarTexto(reserva?.codigo_reserva || reserva?.codigo || ""),
      actividad: limpiarTexto(reserva?.actividad || reserva?.actividad_nombre || ""),
      observaciones: limpiarTexto(reserva?.observaciones || reserva?.observaciones_admin || ""),
      fecha: limpiarTexto(reserva?.rechazo_elimina_en_texto || reserva?.fecha_eliminacion_texto || "")
    }))
    .filter((reserva) => reserva.actividad || reserva.codigo || reserva.fecha);
}

export function construirEmailTextoResolucionExpedienteDocumental({
  cambios = [],
  resumen_actividades = null,
  reservas_rechazadas = []
}) {
  const filasRevision = normalizarCambios(cambios);
  const actividades = normalizarActividades(resumen_actividades || {});
  const reservasRechazadas = normalizarReservasRechazadas(reservas_rechazadas);

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

  if (reservasRechazadas.length) {
    lineas.push("", "SOLICITUDES RECHAZADAS PENDIENTES DE SUBSANACION");
    reservasRechazadas.forEach((reserva) => {
      lineas.push(`- ${reserva.actividad || "Actividad"}${reserva.codigo ? ` (${reserva.codigo})` : ""}`);
      if (reserva.observaciones) {
        lineas.push(`  Observaciones: ${reserva.observaciones}`);
      }
      lineas.push(
        reserva.fecha
          ? `  Si no subsanas lo solicitado en las observaciones y reenvias la solicitud, quedara definitivamente eliminada del sistema el ${reserva.fecha}.`
          : "  Si no subsanas lo solicitado en las observaciones y reenvias la solicitud, quedara definitivamente eliminada del sistema."
      );
    });
  }

  lineas.push("", "Puedes acceder a la plataforma para consultar el resultado detallado.");
  return lineas.join("\n");
}

export function construirEmailHtmlResolucionExpedienteDocumental({
  cambios = [],
  resumen_actividades = null,
  reservas_rechazadas = []
}) {
  const filasRevision = normalizarCambios(cambios);
  const actividades = normalizarActividades(resumen_actividades || {});
  const reservasRechazadas = normalizarReservasRechazadas(reservas_rechazadas);

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

  const bloqueReservasRechazadas = reservasRechazadas.length
    ? `
      <div style="margin:14px 0;padding:14px 16px;border-radius:8px;border:1px solid #f0b4aa;background:#fff1ef;color:#7a2f25;">
        <p style="margin:0 0 10px;"><strong>Solicitudes rechazadas pendientes de subsanación</strong></p>
        ${reservasRechazadas.map((reserva) => `
          <div style="margin:0 0 12px;padding:10px 12px;border-radius:8px;background:#ffffff;border:1px solid #f3c9bf;">
            <p style="margin:0 0 6px;"><strong>${escaparHtml(reserva.actividad || "Actividad")}${reserva.codigo ? ` (${escaparHtml(reserva.codigo)})` : ""}</strong></p>
            ${reserva.observaciones ? `<p style="margin:0 0 6px;"><strong>Observaciones:</strong> ${escaparHtml(reserva.observaciones)}</p>` : ""}
            <p style="margin:0;">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-right:8px;border-radius:999px;background:#f5b400;color:#1f1f1f;font-weight:700;">!</span>
              ${reserva.fecha
                ? `Si no subsanas lo solicitado en las observaciones y reenvías la solicitud, quedará definitivamente eliminada del sistema el <strong>${escaparHtml(reserva.fecha)}</strong>.`
                : "Si no subsanas lo solicitado en las observaciones y reenvías la solicitud, quedará definitivamente eliminada del sistema."
              }
            </p>
          </div>
        `).join("")}
      </div>
    `
    : "";

  return `
    <p>La documentacion obligatoria que has remitido ha sido revisada.</p>
    <p><strong>Detalle de la revision</strong></p>
    ${tablaRevision}
    ${bloqueActividades}
    ${bloqueReservasRechazadas}
    <p>Puedes acceder a la plataforma para consultar el resultado detallado.</p>
  `;
}
