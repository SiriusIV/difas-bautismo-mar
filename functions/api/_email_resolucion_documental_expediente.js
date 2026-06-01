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
  const e = limpiarTexto(estado)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (e === "VALIDADA" || e === "APROBADA") return "Validado";
  if (e === "VALIDADO") return "Validado";
  if (e === "RECHAZADO") return "Rechazado";
  if (e === "EN_REVISION") return "En revisión";
  return e || "Sin estado";
}

export function construirEmailTextoResolucionExpedienteDocumental({
  admin,
  centro,
  estado_expediente,
  cambios = [],
  resumen_documental = null,
  resumen_actividades = null
}) {
  const resumen = resumen_documental || {};
  const validados = Array.isArray(resumen.validados) ? resumen.validados : [];
  const pendientes = Array.isArray(resumen.pendientes) ? resumen.pendientes : [];
  const validacionCompleta = !!resumen.completo;
  const resumenActividades = resumen_actividades || {};
  const totalActivas = Number(resumenActividades.total_activas || 0);
  const totalSolicitables = Number(resumenActividades.solicitables_total || 0);
  const puedeTodas = !!resumenActividades.puede_todas;
  const actividadesSolicitables = Array.isArray(resumenActividades.solicitables) ? resumenActividades.solicitables : [];

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

  if (validacionCompleta) {
    lineas.push("", "Documentación obligatoria validada al completo:");
    validados.forEach((doc) => {
      lineas.push(`- ${limpiarTexto(doc?.nombre)}`);
      if (limpiarTexto(doc?.observaciones_admin)) {
        lineas.push(`  Observaciones: ${limpiarTexto(doc?.observaciones_admin)}`);
      }
    });
    lineas.push(
      "",
      "IMPORTANTE:",
      "Ya tienes toda la documentación obligatoria validada para este organizador."
    );
  } else {
    const cambiosValidados = (Array.isArray(cambios) ? cambios : []).filter(
      (item) => {
        const e = limpiarTexto(item?.estado)
          .toUpperCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");
        return e === "VALIDADO" || e === "VALIDADA" || e === "APROBADA";
      }
    );
    if (cambiosValidados.length) {
      lineas.push("", "Se ha validado la documentación siguiente:");
      cambiosValidados.forEach((doc) => {
        lineas.push(`- ${limpiarTexto(doc?.nombre_documento)}`);
      });
    }
    if (pendientes.length) {
      lineas.push("", "Documentos pendientes para completar la validación:");
      pendientes.forEach((doc) => {
        lineas.push(`- ${limpiarTexto(doc?.nombre)} (${limpiarTexto(doc?.motivo)})`);
      });
    }
    if (pendientes.length) {
      lineas.push(
        "",
        "IMPORTANTE:",
        "Aún no tienes toda la documentación obligatoria completada para este organizador.",
        "Mientras no estén remitidos y validados todos los documentos pendientes indicados, no se admitirá el envío de solicitudes de actividad."
      );
    }
  }

  if (totalActivas <= 0) {
    lineas.push("", "Actualmente este organizador no tiene actividades activas disponibles para solicitud.");
  } else if (puedeTodas) {
    lineas.push(
      "",
      "Con la documentación validada actual puedes solicitar todas las actividades activas de este organizador.",
      "Debes iniciar o reiniciar la solicitud de la actividad en la que desees participar."
    );
  } else if (totalSolicitables > 0) {
    lineas.push("", "Con la documentación validada actual puedes solicitar las siguientes actividades:");
    actividadesSolicitables.forEach((nombre) => lineas.push(`- ${limpiarTexto(nombre)}`));
    lineas.push("", "Para otras actividades de este organizador, debes completar la documentación pendiente.");
  } else {
    lineas.push(
      "",
      "Con la documentación validada actual todavía no puedes solicitar ninguna actividad de este organizador.",
      "Debes completar y validar los documentos pendientes para habilitar solicitudes."
    );
  }

  lineas.push("", "Puedes acceder a la plataforma para consultar el resultado detallado.");
  return lineas.join("\n");
}

export function construirEmailHtmlResolucionExpedienteDocumental({
  admin,
  centro,
  estado_expediente,
  cambios = [],
  resumen_documental = null,
  resumen_actividades = null
}) {
  const resumen = resumen_documental || {};
  const validados = Array.isArray(resumen.validados) ? resumen.validados : [];
  const pendientes = Array.isArray(resumen.pendientes) ? resumen.pendientes : [];
  const validacionCompleta = !!resumen.completo;
  const resumenActividades = resumen_actividades || {};
  const totalActivas = Number(resumenActividades.total_activas || 0);
  const totalSolicitables = Number(resumenActividades.solicitables_total || 0);
  const puedeTodas = !!resumenActividades.puede_todas;
  const actividadesSolicitables = Array.isArray(resumenActividades.solicitables) ? resumenActividades.solicitables : [];

  const filas = (Array.isArray(cambios) ? cambios : []).map((cambio) => `
    <tr>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(cambio?.nombre_documento || "")}</td>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(etiquetaEstado(cambio?.estado))}</td>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(cambio?.observaciones_admin || "")}</td>
    </tr>
  `).join("");

  const filasValidados = validados.map((doc) => `
    <tr>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(doc?.nombre || "")}</td>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(doc?.observaciones_admin || "-")}</td>
    </tr>
  `).join("");

  const listaPendientes = pendientes.map((doc) =>
    `<li><strong>${escaparHtml(doc?.nombre || "")}</strong> (${escaparHtml(doc?.motivo || "")})</li>`
  ).join("");

  const bloqueResultado = validacionCompleta
    ? `
      <p><strong>Documentación obligatoria validada al completo.</strong></p>
      ${filasValidados ? `
        <table style="border-collapse:collapse;width:100%;max-width:760px;margin-top:8px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Documento validado</th>
              <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Observaciones</th>
            </tr>
          </thead>
          <tbody>${filasValidados}</tbody>
        </table>
      ` : ""}
      <p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;">
        <strong>Importante:</strong> Ya tienes toda la documentación obligatoria validada para este organizador.
      </p>
    `
    : `
      ${(Array.isArray(cambios) ? cambios : []).some((item) => limpiarTexto(item?.estado).toUpperCase() === "VALIDADO")
        ? `
          <p><strong>Se ha validado la documentación siguiente:</strong></p>
          <ul>
            ${(Array.isArray(cambios) ? cambios : [])
              .filter((item) => {
                const e = limpiarTexto(item?.estado)
                  .toUpperCase()
                  .normalize("NFD")
                  .replace(/[\u0300-\u036f]/g, "");
                return e === "VALIDADO" || e === "VALIDADA" || e === "APROBADA";
              })
              .map((doc) => `<li>${escaparHtml(doc?.nombre_documento || "")}</li>`)
              .join("")}
          </ul>
        `
        : ""
      }
      ${listaPendientes
        ? `<p><strong>Documentos pendientes para completar la validación:</strong></p><ul>${listaPendientes}</ul>`
        : ""
      }
      ${pendientes.length ? `
        <p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;">
          <strong>Atención:</strong> Aún no tienes toda la documentación obligatoria completada para este organizador. Mientras no estén remitidos y validados todos los documentos pendientes indicados, no se admitirá el envío de solicitudes de actividad.
        </p>
      ` : ""}
    `;

  let bloqueActividades = "";
  if (totalActivas <= 0) {
    bloqueActividades = `
      <p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #d8e0e8;background:#f8fbff;color:#29445f;">
        Actualmente este organizador no tiene actividades activas disponibles para solicitud.
      </p>
    `;
  } else if (puedeTodas) {
    bloqueActividades = `
      <p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #b9e0c0;background:#eaf7ea;color:#1f5f2e;">
        <strong>Con la documentación validada actual puedes solicitar todas las actividades activas de este organizador.</strong><br>
        Debes iniciar o reiniciar la solicitud de la actividad en la que desees participar.
      </p>
    `;
  } else if (totalSolicitables > 0) {
    bloqueActividades = `
      <p><strong>Con la documentación validada actual puedes solicitar las siguientes actividades:</strong></p>
      <ul>${actividadesSolicitables.map((nombre) => `<li>${escaparHtml(nombre)}</li>`).join("")}</ul>
      <p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;">
        Para otras actividades de este organizador, debes completar la documentación pendiente.
      </p>
    `;
  } else {
    bloqueActividades = `
      <p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;">
        <strong>Con la documentación validada actual todavía no puedes solicitar ninguna actividad de este organizador.</strong><br>
        Debes completar y validar los documentos pendientes para habilitar solicitudes.
      </p>
    `;
  }

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
    ${bloqueResultado}
    ${bloqueActividades}
    <p>Puedes acceder a la plataforma para consultar el resultado detallado.</p>
  `;
}

