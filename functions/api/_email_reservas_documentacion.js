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

function etiquetaEstadoPendienteReserva(estado) {
  const valor = limpiarTexto(estado).toUpperCase();
  if (valor === "NO_ENVIADO") return "No presentado";
  if (valor === "NO_ACTUALIZADO") return "No actualizado";
  if (valor === "EN_REVISION") return "En revision";
  if (valor === "RECHAZADO") return "Rechazado";
  return valor || "Pendiente";
}

function construirLineaReservas(reservas = []) {
  const lista = Array.isArray(reservas) ? reservas : [];
  return lista
    .map((item) => limpiarTexto(item?.codigo_reserva))
    .filter(Boolean)
    .join(", ");
}

function resolverTextoEstadoReactivado(reservas = [], estadoDestinoEntrada = "CONFIRMADA") {
  const estados = (Array.isArray(reservas) ? reservas : [])
    .map((reserva) => limpiarTexto(reserva?.estado_reactivado).toUpperCase())
    .filter((estado) => ["PENDIENTE", "CONFIRMADA"].includes(estado));

  if (estados.length) {
    const unicos = Array.from(new Set(estados));
    if (unicos.length > 1) return { estado: "su estado anterior", etiqueta: "Reservas reactivadas" };
    return unicos[0] === "PENDIENTE"
      ? { estado: "pendiente", etiqueta: "Reservas reactivadas como pendientes" }
      : { estado: "confirmada", etiqueta: "Reservas reactivadas" };
  }

  return limpiarTexto(estadoDestinoEntrada).toUpperCase() === "PENDIENTE"
    ? { estado: "pendiente", etiqueta: "Reservas reactivadas como pendientes" }
    : { estado: "confirmada", etiqueta: "Reservas reactivadas" };
}

export function construirEmailTextoReservaCondicionadaDocumentacion({
  admin,
  centro,
  motivo_texto,
  reservas = [],
  documentos_pendientes = [],
  enlace_perfil = ""
}) {
  const organizador = nombreVisibleAdmin(admin);
  const lineas = [
    "Tu solicitud ha quedado suspendida por un cambio en la documentacion obligatoria vigente.",
    "",
    `${motivo_texto || "Se ha producido un cambio documental que requiere una nueva revision."}`,
    "",
    `Organizador: ${organizador}`,
    `Centro: ${limpiarTexto(centro?.centro)}`,
    `Reservas afectadas: ${construirLineaReservas(reservas) || "Sin codigo disponible"}`
  ];

  if (Array.isArray(documentos_pendientes) && documentos_pendientes.length) {
    lineas.push("", "Documentos que debes revisar o presentar:");
    documentos_pendientes.forEach((doc) => {
      lineas.push(`- ${limpiarTexto(doc?.nombre)} (v${Number(doc?.version_documental || 0)}): ${etiquetaEstadoPendienteReserva(doc?.estado)}`);
    });
  }

  lineas.push(
    "",
    "Mientras no regularices la documentacion, la actividad quedara suspendida documentalmente.",
    "Si faltan menos de 24 horas para el inicio de la actividad y la documentacion sigue sin regularizarse, la solicitud pasara automaticamente a rechazada.",
    enlace_perfil ? `Acceso directo: ${enlace_perfil}` : "Accede a tu perfil para revisar y actualizar la documentacion obligatoria."
  );

  return lineas.join("\n");
}

export function construirEmailHtmlReservaCondicionadaDocumentacion({
  admin,
  centro,
  motivo_texto,
  reservas = [],
  documentos_pendientes = [],
  enlace_perfil = ""
}) {
  const organizador = escaparHtml(nombreVisibleAdmin(admin));
  const reservasTexto = escaparHtml(construirLineaReservas(reservas) || "Sin codigo disponible");
  const filasDocs = (Array.isArray(documentos_pendientes) ? documentos_pendientes : []).map((doc) => `
    <tr>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(doc?.nombre || "")}</td>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(`v${Number(doc?.version_documental || 0)}`)}</td>
      <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(etiquetaEstadoPendienteReserva(doc?.estado))}</td>
    </tr>
  `).join("");

  return `
    <p>Tu solicitud ha quedado suspendida por un cambio en la documentacion obligatoria vigente.</p>
    <p>${escaparHtml(motivo_texto || "Se ha producido un cambio documental que requiere una nueva revision.")}</p>
    <p><strong>Organizador:</strong> ${organizador}</p>
    <p><strong>Centro:</strong> ${escaparHtml(centro?.centro || "")}</p>
    <p><strong>Reservas afectadas:</strong> ${reservasTexto}</p>
    ${filasDocs ? `
      <p><strong>Documentos que debes revisar o presentar</strong></p>
      <table style="border-collapse:collapse;width:100%;max-width:720px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Documento</th>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Version</th>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#f7fafc;">Situacion</th>
          </tr>
        </thead>
        <tbody>${filasDocs}</tbody>
      </table>
    ` : ""}
    <p>Mientras no regularices la documentacion, la actividad quedara suspendida documentalmente.</p>
    <p>Si faltan menos de 24 horas para el inicio de la actividad y la documentacion sigue sin regularizarse, la solicitud pasara automaticamente a rechazada.</p>
    ${enlace_perfil ? `
      <p>
        <a href="${escaparHtml(enlace_perfil)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#0b5ed7;color:#ffffff;text-decoration:none;font-weight:bold;">
          Revisar documentacion
        </a>
      </p>
    ` : `
      <p>Accede a tu perfil para revisar y actualizar la documentacion obligatoria.</p>
    `}
  `;
}

export function construirEmailTextoReservaEliminadaDocumentacionCritica({
  admin,
  centro,
  motivo_texto,
  reservas = []
}) {
  const organizador = nombreVisibleAdmin(admin);
  return [
    "Tu solicitud ha sido eliminada del sistema por no conservar la documentacion obligatoria requerida dentro del plazo minimo previo al inicio de la actividad.",
    "",
    `${motivo_texto || "Se ha producido un cambio documental que deja la solicitud sin la documentacion obligatoria exigida."}`,
    "",
    `Organizador: ${organizador}`,
    `Centro: ${limpiarTexto(centro?.centro)}`,
    `Solicitudes eliminadas: ${construirLineaReservas(reservas) || "Sin codigo disponible"}`,
    "",
    "Al encontrarse la actividad dentro del plazo critico previo al inicio, ya no es posible suspender la solicitud para regularizarla."
  ].join("\n");
}

export function construirEmailHtmlReservaEliminadaDocumentacionCritica({
  admin,
  centro,
  motivo_texto,
  reservas = []
}) {
  const organizador = escaparHtml(nombreVisibleAdmin(admin));
  const reservasTexto = escaparHtml(construirLineaReservas(reservas) || "Sin codigo disponible");

  return `
    <p>Tu solicitud ha sido eliminada del sistema por no conservar la documentacion obligatoria requerida dentro del plazo minimo previo al inicio de la actividad.</p>
    <p>${escaparHtml(motivo_texto || "Se ha producido un cambio documental que deja la solicitud sin la documentacion obligatoria exigida.")}</p>
    <p><strong>Organizador:</strong> ${organizador}</p>
    <p><strong>Centro:</strong> ${escaparHtml(centro?.centro || "")}</p>
    <p><strong>Solicitudes eliminadas:</strong> ${reservasTexto}</p>
    <div style="margin:14px 0;padding:12px 14px;border-radius:10px;border:1px solid #f0c36d;background:#fff6df;color:#704600;">
      Al encontrarse la actividad dentro del plazo critico previo al inicio, ya no es posible suspender la solicitud para regularizarla.
    </div>
  `;
}

export function construirEmailTextoReservaReactivadaDocumentacion({
  admin,
  centro,
  motivo_texto,
  reservas = [],
  estado_destino = "CONFIRMADA",
  enlace_perfil = ""
}) {
  const organizador = nombreVisibleAdmin(admin);
  const estadoReactivado = resolverTextoEstadoReactivado(reservas, estado_destino);
  return [
    `Tu solicitud vuelve a estar ${estadoReactivado.estado} tras la actualizacion documental aplicada por el organizador.`,
    "",
    `${motivo_texto || "Ha cambiado el conjunto de documentos obligatorios vigente."}`,
    "",
    `Organizador: ${organizador}`,
    `Centro: ${limpiarTexto(centro?.centro)}`,
    `${estadoReactivado.etiqueta}: ${construirLineaReservas(reservas) || "Sin codigo disponible"}`,
    "",
    enlace_perfil
      ? `Puedes revisar el estado actualizado desde aqui: ${enlace_perfil}`
      : "Puedes revisar el estado actualizado desde tu perfil de usuario."
  ].join("\n");
}

export function construirEmailHtmlReservaReactivadaDocumentacion({
  admin,
  centro,
  motivo_texto,
  reservas = [],
  estado_destino = "CONFIRMADA",
  enlace_perfil = ""
}) {
  const organizador = escaparHtml(nombreVisibleAdmin(admin));
  const estadoReactivado = resolverTextoEstadoReactivado(reservas, estado_destino);
  return `
    <p>Tu solicitud vuelve a estar ${escaparHtml(estadoReactivado.estado)} tras la actualizacion documental aplicada por el organizador.</p>
    <p>${escaparHtml(motivo_texto || "Ha cambiado el conjunto de documentos obligatorios vigente.")}</p>
    <p><strong>Organizador:</strong> ${organizador}</p>
    <p><strong>Centro:</strong> ${escaparHtml(centro?.centro || "")}</p>
    <p><strong>${escaparHtml(estadoReactivado.etiqueta)}:</strong> ${escaparHtml(construirLineaReservas(reservas) || "Sin codigo disponible")}</p>
    ${enlace_perfil ? `
      <p>
        <a href="${escaparHtml(enlace_perfil)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#198754;color:#ffffff;text-decoration:none;font-weight:bold;">
          Ver estado actualizado
        </a>
      </p>
    ` : `
      <p>Puedes revisar el estado actualizado desde tu perfil de usuario.</p>
    `}
  `;
}
