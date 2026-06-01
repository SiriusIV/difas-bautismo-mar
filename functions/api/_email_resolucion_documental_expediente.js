import { nombreVisibleAdmin } from "./_email.js";

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
  const e = limpiarTexto(estado)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (e === "VALIDADO" || e === "VALIDADA" || e === "APROBADA") return "Aprobado";
  if (e === "RECHAZADO" || e === "RECHAZADA") return "Rechazado";
  if (e === "EN_REVISION") return "En revisión";
  if (e === "NO_ACTUALIZADO") return "Desactualizado";
  if (e === "NO_ENVIADO" || e === "NO_INICIADO") return "No presentado";
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
  const actividadesFormateadas = actividadesSolicitables.map((item) => {
    if (typeof item === "string") {
      return { actividad: limpiarTexto(item), organizador: "" };
    }
    return {
      actividad: limpiarTexto(item?.actividad || item?.nombre || ""),
      organizador: limpiarTexto(item?.organizador || item?.admin_nombre || "")
    };
  }).filter((item) => item.actividad);

  const lineas = [
    "El estado de tu documentación obligatoria ha sido revisado.",
    "",
    `Organizador: ${nombreVisibleAdmin(admin)}`,
    `Centro: ${limpiarTexto(centro?.centro)}`
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
    lineas.push("", "Documentación obligatoria aprobada al completo:");
    validados.forEach((doc) => {
      lineas.push(`- ${limpiarTexto(doc?.nombre)}`);
      if (limpiarTexto(doc?.observaciones_admin)) {
        lineas.push(`  Observaciones: ${limpiarTexto(doc?.observaciones_admin)}`);
      }
    });
    lineas.push(
      "",
      "IMPORTANTE:",
      "Ya tienes toda la documentación obligatoria aprobada para este organizador."
    );
  } else {
    const cambiosAprobados = (Array.isArray(cambios) ? cambios : []).filter((item) => {
      const e = limpiarTexto(item?.estado)
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      return e === "VALIDADO" || e === "VALIDADA" || e === "APROBADA";
    });
    if (cambiosAprobados.length) {
      lineas.push("", "Se ha aprobado la documentación siguiente:");
      cambiosAprobados.forEach((doc) => lineas.push(`- ${limpiarTexto(doc?.nombre_documento)}`));
    }
    if (pendientes.length) {
      lineas.push("", "Documentos pendientes para completar la validación:");
      pendientes.forEach((doc) => lineas.push(`- ${limpiarTexto(doc?.nombre)} (${limpiarTexto(doc?.motivo)})`));
      lineas.push(
        "",
        "IMPORTANTE:",
        "Aún no tienes toda la documentación obligatoria completada para este organizador.",
        "Mientras no estén remitidos y aprobados todos los documentos pendientes indicados, no se admitirá el envío de solicitudes de actividad."
      );
    }
  }

  if (totalActivas <= 0) {
    lineas.push("", "Actualmente este organizador no tiene actividades activas que requieran reserva disponibles para solicitud.");
  } else if (puedeTodas) {
    lineas.push(
      "",
      "Con la documentación actualmente aprobada puedes solicitar todas las actividades activas de este organizador que requieran reserva.",
      "Debes iniciar o reiniciar la solicitud de la actividad en la que desees participar."
    );
  } else if (totalSolicitables > 0) {
    lineas.push("", "Con la documentación actualmente aprobada puedes solicitar las siguientes actividades que requieren reserva:");
    actividadesFormateadas.forEach((item) => {
      lineas.push(`- ${item.actividad}${item.organizador ? ` (Organizador: ${item.organizador})` : ""}`);
    });
    lineas.push("", "Para otras actividades de este organizador, debes completar la documentación pendiente.");
  } else {
    lineas.push(
      "",
      `Con la documentación actualmente presentada no tienes aún acceso a solicitar las actividades disponibles organizadas por ${nombreVisibleAdmin(admin)} que requieran reserva.`,
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
  const actividadesFormateadas = actividadesSolicitables.map((item) => {
    if (typeof item === "string") {
      return { actividad: limpiarTexto(item), organizador: "" };
    }
    return {
      actividad: limpiarTexto(item?.actividad || item?.nombre || ""),
      organizador: limpiarTexto(item?.organizador || item?.admin_nombre || "")
    };
  }).filter((item) => item.actividad);

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
      <p><strong>Documentación obligatoria aprobada al completo.</strong></p>
      ${filasValidados ? `
        <table style="border-collapse:collapse;width:100%;max-width:760px;margin-top:8px;">
          <thead><tr>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Documento aprobado</th>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Observaciones</th>
          </tr></thead><tbody>${filasValidados}</tbody>
        </table>
      ` : ""}
      <p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;">
        <strong>Importante:</strong> Ya tienes toda la documentación obligatoria aprobada para este organizador.
      </p>
    `
    : `
      ${(Array.isArray(cambios) ? cambios : []).some((item) => {
          const e = limpiarTexto(item?.estado).toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          return e === "VALIDADO" || e === "VALIDADA" || e === "APROBADA";
        })
        ? `<p><strong>Se ha aprobado la documentación siguiente:</strong></p>
           <ul>${(Array.isArray(cambios) ? cambios : [])
              .filter((item) => {
                const e = limpiarTexto(item?.estado).toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                return e === "VALIDADO" || e === "VALIDADA" || e === "APROBADA";
              })
              .map((doc) => `<li>${escaparHtml(doc?.nombre_documento || "")}</li>`).join("")}</ul>`
        : ""
      }
      ${listaPendientes ? `<p><strong>Documentos pendientes para completar la validación:</strong></p><ul>${listaPendientes}</ul>` : ""}
      ${pendientes.length ? `
        <p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;">
          <strong>Atención:</strong> Aún no tienes toda la documentación obligatoria completada para este organizador. Mientras no estén remitidos y aprobados todos los documentos pendientes indicados, no se admitirá el envío de solicitudes de actividad.
        </p>
      ` : ""}
    `;

  let bloqueActividades = "";
  if (totalActivas <= 0) {
    bloqueActividades = `<p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #d8e0e8;background:#f8fbff;color:#29445f;">Actualmente este organizador no tiene actividades activas que requieran reserva disponibles para solicitud.</p>`;
  } else if (puedeTodas) {
    bloqueActividades = `<p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #b9e0c0;background:#eaf7ea;color:#1f5f2e;"><strong>Con la documentación actualmente aprobada puedes solicitar todas las actividades activas de este organizador que requieran reserva.</strong><br>Debes iniciar o reiniciar la solicitud de la actividad en la que desees participar.</p>`;
  } else if (totalSolicitables > 0) {
    bloqueActividades = `<p><strong>Con la documentación actualmente aprobada puedes solicitar las siguientes actividades que requieren reserva:</strong></p><ul>${actividadesFormateadas.map((item) => `<li>${escaparHtml(item.actividad)}${item.organizador ? ` <span style="color:#4b5f73;">(Organizador: ${escaparHtml(item.organizador)})</span>` : ""}</li>`).join("")}</ul><p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;">Para otras actividades de este organizador, debes completar la documentación pendiente.</p>`;
  } else {
    bloqueActividades = `<p style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;"><strong>Con la documentación actualmente presentada no tienes aún acceso a solicitar las actividades disponibles organizadas por ${escaparHtml(nombreVisibleAdmin(admin))} que requieran reserva.</strong><br>Debes completar y validar los documentos pendientes para habilitar solicitudes.</p>`;
  }

  return `
    <p>El estado de tu documentación obligatoria ha sido revisado.</p>
    <p><strong>Organizador:</strong> ${escaparHtml(nombreVisibleAdmin(admin))}</p>
    <p><strong>Centro:</strong> ${escaparHtml(centro?.centro || "")}</p>
    ${filas ? `<p><strong>Detalle de la revisión</strong></p><table style="border-collapse:collapse;width:100%;max-width:760px;"><thead><tr><th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Documento</th><th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Estado</th><th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Observaciones</th></tr></thead><tbody>${filas}</tbody></table>` : ""}
    ${bloqueResultado}
    ${bloqueActividades}
    <p>Puedes acceder a la plataforma para consultar el resultado detallado.</p>
  `;
}
