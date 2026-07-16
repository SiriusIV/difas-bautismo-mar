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
  if (valor === "EN_REVISION" || valor === "EN REVISION") return "En revisión";
  if (valor === "NO_ACTUALIZADO") return "Desactualizado";
  if (valor === "NO_ENVIADO" || valor === "NO_INICIADO") return "No presentado";
  return valor || "Sin estado";
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

function formatearFecha(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return "";
  const match = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return texto;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function normalizarSolicitud(centro = {}) {
  const actividad = limpiarTexto(centro.actividad_nombre || centro.actividad_titulo || centro.actividad || "");
  const solicitante = limpiarTexto(centro.solicitante_nombre || centro.centro || centro.nombre_publico || centro.nombre || centro.email || "");
  const fecha = formatearFecha(centro.fecha || centro.reserva_fecha || centro.franja_fecha || "");
  const horaInicio = limpiarTexto(centro.hora_inicio || "");
  const horaFin = limpiarTexto(centro.hora_fin || "");
  const horario = horaInicio && horaFin ? `${horaInicio} - ${horaFin}` : (horaInicio || horaFin);
  const codigo = limpiarTexto(centro.codigo_reserva || "");

  if (!actividad && !solicitante && !fecha && !horario && !codigo) return null;
  return { actividad, solicitante, fecha, horario, codigo };
}

export function construirEmailTextoResolucionExpedienteDocumental({
  centro = {},
  cambios = [],
}) {
  const filasRevision = normalizarCambios(cambios);
  const solicitud = normalizarSolicitud(centro || {});

  const lineas = [
    solicitud?.actividad
      ? `La documentación remitida para la solicitud de la actividad "${solicitud.actividad}" ha sido revisada.`
      : "La documentación remitida para una solicitud de actividad ha sido revisada."
  ];

  if (solicitud) {
    lineas.push("", "Contexto de la solicitud:");
    if (solicitud.actividad) lineas.push(`- Actividad: ${solicitud.actividad}`);
    if (solicitud.solicitante) lineas.push(`- Solicitante: ${solicitud.solicitante}`);
    if (solicitud.fecha) lineas.push(`- Fecha: ${solicitud.fecha}`);
    if (solicitud.horario) lineas.push(`- Horario: ${solicitud.horario}`);
    if (solicitud.codigo) lineas.push(`- Codigo de reserva: ${solicitud.codigo}`);
  }

  lineas.push("", "Detalle de la revisión:");

  if (filasRevision.length) {
    filasRevision.forEach((fila) => {
      lineas.push(`- Documento: ${fila.documento}`);
      lineas.push(`  Estado: ${fila.estado}`);
      lineas.push(`  Observaciones: ${fila.observaciones || "-"}`);
    });
  } else {
    lineas.push("- No constan cambios de estado documental en esta revisión.");
  }

  lineas.push("", "Puedes acceder a la plataforma para consultar el resultado detallado.");
  return lineas.join("\n");
}

export function construirEmailHtmlResolucionExpedienteDocumental({
  centro = {},
  cambios = [],
}) {
  const filasRevision = normalizarCambios(cambios);
  const solicitud = normalizarSolicitud(centro || {});

  const filasContexto = solicitud
    ? [
        ["Actividad", solicitud.actividad],
        ["Solicitante", solicitud.solicitante],
        ["Fecha", solicitud.fecha],
        ["Horario", solicitud.horario],
        ["Código de reserva", solicitud.codigo]
      ].filter(([, valor]) => limpiarTexto(valor))
    : [];

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
    : `<p>No constan cambios de estado documental en esta revisión.</p>`;

  const bloqueSolicitud = filasContexto.length
    ? `
      <div style="margin:14px 0;padding:14px 16px;border-radius:8px;border:1px solid #cfe1f5;background:#f3f8ff;color:#173b62;">
        <p style="margin:0 0 10px;"><strong>Solicitud vinculada</strong></p>
        <table style="border-collapse:collapse;width:100%;max-width:760px;background:#ffffff;">
          <tbody>
            ${filasContexto.map(([etiqueta, valor]) => `
              <tr>
                <th style="text-align:left;width:170px;padding:8px 10px;border:1px solid #d8e0e8;background:#edf4fb;">${escaparHtml(etiqueta)}</th>
                <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(valor)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `
    : "";

  return `
    <p>${solicitud?.actividad
      ? `La documentación remitida para la solicitud de la actividad <strong>${escaparHtml(solicitud.actividad)}</strong> ha sido revisada.`
      : "La documentación remitida para una solicitud de actividad ha sido revisada."
    }</p>
    ${bloqueSolicitud}
    <p><strong>Detalle de la revisión</strong></p>
    ${tablaRevision}
    <p>Puedes acceder a la plataforma para consultar el resultado detallado.</p>
  `;
}
