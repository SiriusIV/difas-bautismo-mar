import {
  enviarEmail,
  nombreVisibleAdmin
} from "./_email.js";
import {
  construirEmailHtmlReservaCondicionadaDocumentacion,
  construirEmailHtmlReservaEliminadaDocumentacionCritica,
  construirEmailHtmlReservaReactivadaDocumentacion,
  construirEmailTextoReservaCondicionadaDocumentacion,
  construirEmailTextoReservaEliminadaDocumentacionCritica,
  construirEmailTextoReservaReactivadaDocumentacion
} from "./_email_reservas_documentacion.js";
import {
  asegurarTablaPropietariosDocumentalesAdmin,
  obtenerCatalogoDocumentalVinculadoAdmin
} from "./_documentacion_propietarios.js";
import { crearNotificacion } from "./_notificaciones.js";
import { registrarEventoReserva } from "./_reservas_historial.js";
import {
  asegurarTablasDocumentacionActividad,
  obtenerCatalogoDocumentosActivosAdmin,
  obtenerConfiguracionDocumentalPorActividades,
  resolverDocumentosExigiblesActividad
} from "./_actividad_documentacion.js";
import { asegurarColumnasContextoDocumental } from "./_documentacion_contextual.js";

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarClaveTexto(valor) {
  return limpiarTexto(valor).toUpperCase();
}

function obtenerPropietarioDocumento(doc = {}) {
  return Number(doc?.propietario_id || doc?.admin_id || 0);
}

function claveDocumentoEntregable(nombre, propietarioId = 0) {
  return `${Number(propietarioId || 0)}::${normalizarClaveTexto(nombre)}`;
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolverContactoReservaParaCorreo(reservas = []) {
  const primeraConCorreo = (Array.isArray(reservas) ? reservas : []).find((reserva) => limpiarTexto(reserva?.email));
  if (!primeraConCorreo) {
    return { contacto: "", email: "" };
  }

  return {
    contacto: limpiarTexto(primeraConCorreo.contacto || ""),
    email: limpiarTexto(primeraConCorreo.email || "")
  };
}

function parsearFecha(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return null;
  const fecha = new Date(texto.replace(" ", "T"));
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function parsearFechaComparable(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return null;
  const fecha = new Date(texto.replace(" ", "T"));
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function normalizarEstadoDocumento(estado) {
  const valor = limpiarTexto(estado)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (valor === "VALIDADA" || valor === "APROBADO" || valor === "APROBADA") return "VALIDADO";
  if (valor === "EN REVISION") return "EN_REVISION";
  return valor || "EN_REVISION";
}

function calcularEstadoDocumento(doc, entrega) {
  if (!entrega) return "NO_ENVIADO";
  if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) {
    return "NO_ACTUALIZADO";
  }
  const fechaMarco = parsearFechaComparable(doc.fecha_actualizacion);
  const fechaEntrega = parsearFechaComparable(entrega.fecha_subida);
  if (fechaMarco && fechaEntrega && fechaEntrega < fechaMarco) {
    return "NO_ACTUALIZADO";
  }
  return normalizarEstadoDocumento(entrega.estado);
}

function indexarArchivosActivos(archivosActivos) {
  const porPropietarioYNombre = new Map();
  const porNombre = new Map();

  for (const archivo of archivosActivos || []) {
    const nombre = limpiarTexto(archivo?.nombre_documento);
    if (!nombre) continue;

    const propietario = Number(
      archivo?.propietario_id ||
      archivo?.documento_propietario_id ||
      archivo?.admin_id ||
      0
    );
    if (propietario > 0) {
      porPropietarioYNombre.set(claveDocumentoEntregable(nombre, propietario), archivo);
    }
    if (!porNombre.has(normalizarClaveTexto(nombre))) {
      porNombre.set(normalizarClaveTexto(nombre), archivo);
    }
  }

  return { porPropietarioYNombre, porNombre };
}

function obtenerEntregaDocumento(doc, indiceArchivos) {
  const nombre = limpiarTexto(doc?.nombre);
  if (!nombre) return null;

  const propietario = obtenerPropietarioDocumento(doc);
  if (propietario > 0) {
    const entregaPropietaria = indiceArchivos.porPropietarioYNombre.get(
      claveDocumentoEntregable(nombre, propietario)
    );
    if (entregaPropietaria) return entregaPropietaria;
  }

  return indiceArchivos.porNombre.get(normalizarClaveTexto(nombre)) || null;
}

function calcularEstadoGlobal(documentosActivos, archivosActivos) {
  if (!Array.isArray(documentosActivos) || documentosActivos.length === 0) {
    return "NO_REQUERIDA";
  }

  const indiceArchivos = indexarArchivosActivos(archivosActivos);

  const estados = documentosActivos.map((doc) => {
    const entrega = obtenerEntregaDocumento(doc, indiceArchivos);
    return calcularEstadoDocumento(doc, entrega);
  });

  if (estados.every((estado) => estado === "NO_ENVIADO")) return "NO_INICIADO";
  if (estados.some((estado) => estado === "RECHAZADO")) return "RECHAZADA";
  if (estados.some((estado) => estado === "NO_ACTUALIZADO")) return "NO_ACTUALIZADO";
  if (estados.some((estado) => estado === "NO_ENVIADO")) return "NO_COMPLETADO";
  if (estados.every((estado) => estado === "VALIDADO")) return "VALIDADA";
  return "EN_REVISION";
}

function estadoDocumentalCompleto(estado) {
  return ["VALIDADA", "NO_REQUERIDA"].includes(String(estado || "").toUpperCase());
}

function resumirEstadosDocumentales(estados = []) {
  const normalizados = (Array.isArray(estados) ? estados : [])
    .map((estado) => limpiarTexto(estado).toUpperCase())
    .filter(Boolean);
  if (!normalizados.length) return "NO_REQUERIDA";
  if (normalizados.some((estado) => estado === "RECHAZADA")) return "RECHAZADA";
  if (normalizados.some((estado) => estado === "NO_ACTUALIZADO")) return "NO_ACTUALIZADO";
  if (normalizados.some((estado) => estado === "NO_COMPLETADO")) return "NO_COMPLETADO";
  if (normalizados.some((estado) => estado === "EN_REVISION")) return "EN_REVISION";
  if (normalizados.every((estado) => estado === "VALIDADA" || estado === "NO_REQUERIDA")) return "VALIDADA";
  return normalizados[0] || "NO_REQUERIDA";
}

function motivoImpactoDocumentalTexto(motivo) {
  const clave = limpiarTexto(motivo).toLowerCase();
  if (clave === "cambio_responsable") {
    return "Ha cambiado el responsable de la documentacion obligatoria del organizador.";
  }
  if (clave === "documento_activado") {
    return "Se ha activado un documento obligatorio que ahora pasa a ser exigible.";
  }
  if (clave === "documento_creado") {
    return "Se ha creado un nuevo documento obligatorio.";
  }
  if (clave === "documento_eliminado") {
    return "Se ha eliminado un documento obligatorio del marco vigente.";
  }
  if (clave === "documentos_actualizados") {
    return "Se ha actualizado el conjunto de documentos obligatorios vigente.";
  }
  if (clave === "documentacion_solicitante_actualizada") {
    return "El solicitante ha actualizado documentación obligatoria ya remitida.";
  }
  if (clave === "documentacion_solicitante_eliminada") {
    return "El solicitante ha eliminado documentación obligatoria ya remitida.";
  }
  return "Se ha producido un cambio en la documentacion obligatoria vigente.";
}

function construirUrlPerfilDocumentacion(baseUrl, adminId) {
  const base = limpiarTexto(baseUrl);
  if (!base || !adminId) return "";

  try {
    const url = new URL("/usuario-panel.html", base);
    return url.toString();
  } catch {
    return "";
  }
}

async function obtenerDocumentosActivosVigentes(env, adminId) {
  const admin = await env.DB.prepare(`
    SELECT
      id,
      nombre,
      nombre_publico,
      email,
      localidad
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(adminId).first();

  const catalogoFallback = await obtenerCatalogoDocumentosActivosAdmin(env, adminId);
  const documentos = await obtenerCatalogoDocumentalVinculadoAdmin(env, adminId, catalogoFallback);

  return {
    resolucion: { admin: admin || { id: adminId } },
    propietario_documental_id: adminId,
    documentos
  };
}

async function obtenerSolicitantesAfectados(env, adminId) {
  const rows = await env.DB.prepare(`
    SELECT DISTINCT
      u.id,
      u.centro,
      u.email
    FROM usuarios u
    WHERE u.rol = 'SOLICITANTE'
      AND u.id IN (
        SELECT cad.centro_usuario_id
        FROM centro_admin_documentacion cad
        WHERE cad.admin_id = ?
        UNION
        SELECT r.usuario_id
        FROM reservas r
        INNER JOIN actividades a ON a.id = r.actividad_id
        WHERE a.admin_id = ?
      )
    ORDER BY COALESCE(u.centro, u.email, u.id) ASC
  `).bind(adminId, adminId).all();

  return rows?.results || [];
}

async function obtenerExpediente(env, adminId, centroUsuarioId, contexto = {}) {
  const actividadId = Number(contexto?.actividadId || 0);
  const reservaId = Number(contexto?.reservaId || 0);
  return await env.DB.prepare(`
    SELECT
      id,
      admin_id,
      centro_usuario_id,
      actividad_id,
      reserva_id,
      version_requerida,
      version_aportada,
      estado,
      fecha_ultima_entrega,
      fecha_validacion,
      observaciones_admin
    FROM centro_admin_documentacion
    WHERE admin_id = ?
      AND centro_usuario_id = ?
      AND ${actividadId > 0 ? "actividad_id = ?" : "actividad_id IS NULL"}
      AND ${reservaId > 0 ? "reserva_id = ?" : "reserva_id IS NULL"}
    LIMIT 1
  `).bind(...[
    adminId,
    centroUsuarioId,
    ...(actividadId > 0 ? [actividadId] : []),
    ...(reservaId > 0 ? [reservaId] : [])
  ]).first();
}

async function asegurarExpediente(env, adminId, centroUsuarioId, versionRequerida, estadoInicial, contexto = {}) {
  await asegurarColumnasContextoDocumental(env);
  const actividadId = Number(contexto?.actividadId || 0) || null;
  const reservaId = Number(contexto?.reservaId || 0) || null;
  let expediente = await obtenerExpediente(env, adminId, centroUsuarioId, { actividadId, reservaId });
  if (expediente) return expediente;

  await env.DB.prepare(`
    INSERT INTO centro_admin_documentacion (
      centro_usuario_id,
      admin_id,
      actividad_id,
      reserva_id,
      version_requerida,
      version_aportada,
      estado,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    centroUsuarioId,
    adminId,
    actividadId,
    reservaId,
    versionRequerida,
    estadoInicial
  ).run();

  return await obtenerExpediente(env, adminId, centroUsuarioId, { actividadId, reservaId });
}

function obtenerPropietariosDocumentos(documentos = [], adminIdFallback = 0) {
  const ids = new Set();
  for (const doc of documentos || []) {
    const propietario = obtenerPropietarioDocumento(doc) || Number(adminIdFallback || 0);
    if (propietario > 0) ids.add(propietario);
  }
  if (!ids.size && Number(adminIdFallback || 0) > 0) {
    ids.add(Number(adminIdFallback || 0));
  }
  return Array.from(ids);
}

async function asegurarExpedientesPropietarios(
  env,
  centroUsuarioId,
  propietarios = [],
  documentos = [],
  estadoInicial = "NO_INICIADO",
  contexto = {}
) {
  const mapa = new Map();
  for (const propietarioId of propietarios) {
    const documentosPropietario = (documentos || []).filter((doc) =>
      (obtenerPropietarioDocumento(doc) || Number(propietarioId || 0)) === Number(propietarioId || 0)
    );
    const versionRequerida = documentosPropietario.reduce(
      (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
      0
    );
    const expediente = await asegurarExpediente(
      env,
      Number(propietarioId || 0),
      Number(centroUsuarioId || 0),
      versionRequerida,
      documentosPropietario.length > 0 ? estadoInicial : "NO_REQUERIDA",
      contexto
    );
    if (expediente?.id) {
      mapa.set(Number(propietarioId || 0), expediente);
    }
  }
  return mapa;
}

async function obtenerArchivosActivosExpediente(env, expedienteId) {
  const rows = await env.DB.prepare(`
    SELECT
      id,
      nombre_documento,
      version_documental,
      estado,
      archivo_url,
      fecha_subida
    FROM centro_admin_documentacion_archivos
    WHERE documentacion_id = ?
      AND activo = 1
    ORDER BY id ASC
  `).bind(expedienteId).all();

  return rows?.results || [];
}

async function actualizarExpediente(env, expedienteId, datos) {
  await env.DB.prepare(`
    UPDATE centro_admin_documentacion
    SET
      version_requerida = ?,
      version_aportada = ?,
      estado = ?,
      fecha_ultima_entrega = ?,
      fecha_validacion = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    Number(datos.version_requerida || 0),
    Number(datos.version_aportada || 0),
    datos.estado || "NO_INICIADO",
    datos.fecha_ultima_entrega || null,
    datos.fecha_validacion || null,
    expedienteId
  ).run();
}

async function obtenerReservasActivasPorUsuario(env, adminId, usuarioId) {
  const rows = await env.DB.prepare(`
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado,
      r.actividad_id,
      r.franja_id,
      r.contacto,
      r.email,
      r.fecha_solicitud,
      r.fecha_modificacion,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      COALESCE(
        CASE
          WHEN f.fecha IS NOT NULL AND f.hora_inicio IS NOT NULL
            THEN f.fecha || ' ' || f.hora_inicio
          ELSE NULL
        END,
        CASE
          WHEN a.fecha_inicio IS NOT NULL
            THEN a.fecha_inicio || ' 00:00:00'
          ELSE NULL
        END
      ) AS inicio_reserva
    FROM reservas r
    INNER JOIN actividades a ON a.id = r.actividad_id
    LEFT JOIN franjas f ON f.id = r.franja_id
    WHERE a.admin_id = ?
      AND r.usuario_id = ?
      AND r.estado IN ('PENDIENTE', 'CONFIRMADA', 'EN_REVISION', 'SUSPENDIDA')
    ORDER BY r.fecha_solicitud ASC, r.id ASC
  `).bind(adminId, usuarioId).all();

  return rows?.results || [];
}

async function obtenerArchivosActivosExpedientes(env, expedientesPorPropietario = new Map()) {
  const expedientes = Array.from(expedientesPorPropietario.entries())
    .filter(([, expediente]) => Number(expediente?.id || 0) > 0);
  if (!expedientes.length) return [];

  const propietarioPorExpediente = new Map(
    expedientes.map(([propietarioId, expediente]) => [Number(expediente.id || 0), Number(propietarioId || 0)])
  );
  const placeholders = expedientes.map(() => "?").join(", ");
  const rows = await env.DB.prepare(`
    SELECT
      id,
      documentacion_id,
      nombre_documento,
      version_documental,
      estado,
      archivo_url,
      fecha_subida
    FROM centro_admin_documentacion_archivos
    WHERE documentacion_id IN (${placeholders})
      AND activo = 1
    ORDER BY id ASC
  `).bind(...expedientes.map(([, expediente]) => expediente.id)).all();

  return (rows?.results || []).map((row) => ({
    ...row,
    propietario_documental_id: propietarioPorExpediente.get(Number(row.documentacion_id || 0)) || 0
  }));
}

function reservaEnPlazoCriticoDocumental(reserva = {}) {
  const inicio = parsearFecha(reserva?.inicio_reserva);
  if (!inicio) return false;
  const limite = new Date(inicio.getTime() - 24 * 60 * 60 * 1000);
  return limite.getTime() <= Date.now();
}

function construirPendientes(documentosActivos, archivosActivos) {
  const indiceArchivos = indexarArchivosActivos(archivosActivos);

  return (documentosActivos || []).map((doc) => {
    const entrega = obtenerEntregaDocumento(doc, indiceArchivos);
    const estado = calcularEstadoDocumento(doc, entrega);
    return {
      id: Number(doc.id || 0),
      propietario_id: obtenerPropietarioDocumento(doc),
      nombre: limpiarTexto(doc.nombre),
      descripcion: limpiarTexto(doc.descripcion),
      version_documental: Number(doc.version_documental || 0),
      estado
    };
  }).filter((doc) => doc.estado !== "VALIDADO");
}

function unificarPendientesReservas(listas = []) {
  const vistos = new Set();
  const salida = [];

  for (const item of Array.isArray(listas) ? listas.flat() : []) {
    const nombre = limpiarTexto(item?.nombre);
    if (!nombre) continue;
    const key = nombre.toUpperCase();
    if (vistos.has(key)) continue;
    vistos.add(key);
    salida.push(item);
  }

  return salida;
}

async function actualizarEstadoReserva(env, reservaId, nuevoEstado) {
  await env.DB.prepare(`
    UPDATE reservas
    SET
      estado = ?,
      fecha_modificacion = datetime('now')
    WHERE id = ?
  `).bind(nuevoEstado, reservaId).run();
}

async function eliminarReservaPorDocumentacionCritica(env, reservaId) {
  const id = Number(reservaId || 0);
  if (!(id > 0)) return false;

  await env.DB.prepare(`
    DELETE FROM visitantes
    WHERE reserva_id = ?
  `).bind(id).run();

  const result = await env.DB.prepare(`
    DELETE FROM reservas
    WHERE id = ?
  `).bind(id).run();

  return Number(result?.meta?.changes || 0) > 0;
}

async function notificarReservaCondicionada(env, payload) {
  return await enviarEmail(env, {
    to: payload?.centro?.email || "",
    subject: `[Reservas] Solicitud suspendida por documentacion en ${nombreVisibleAdmin(payload?.admin)}`,
    text: construirEmailTextoReservaCondicionadaDocumentacion(payload),
    html: construirEmailHtmlReservaCondicionadaDocumentacion(payload)
  });
}

async function notificarReservaReactivada(env, payload) {
  return await enviarEmail(env, {
    to: payload?.centro?.email || "",
    subject: `[Reservas] Solicitud reactivada en ${nombreVisibleAdmin(payload?.admin)}`,
    text: construirEmailTextoReservaReactivadaDocumentacion(payload),
    html: construirEmailHtmlReservaReactivadaDocumentacion(payload)
  });
}

async function notificarReservaEliminadaDocumentacionCritica(env, payload) {
  return await enviarEmail(env, {
    to: payload?.centro?.email || "",
    subject: `[Reservas] Solicitud eliminada por documentacion en ${nombreVisibleAdmin(payload?.admin)}`,
    text: construirEmailTextoReservaEliminadaDocumentacionCritica(payload),
    html: construirEmailHtmlReservaEliminadaDocumentacionCritica(payload)
  });
}

async function obtenerEstadoPrevioSuspensionDocumental(env, reservaId) {
  const id = Number(reservaId || 0);
  if (!(id > 0)) return "PENDIENTE";

  const resolverEstadoDocumentalReactivado = (estadoEntrada) => {
    const estado = limpiarTexto(estadoEntrada).toUpperCase();
    if (estado === "CONFIRMADA") return "CONFIRMADA";
    if (estado === "PENDIENTE") return "PENDIENTE";
    if (estado === "RECHAZADA") return "PENDIENTE";
    return "";
  };

  try {
    const row = await env.DB.prepare(`
      SELECT estado_origen
      FROM reservas_historial_estados
      WHERE reserva_id = ?
        AND accion = 'SUSPENSION_DOCUMENTAL'
        AND estado_destino = 'SUSPENDIDA'
      ORDER BY fecha_evento DESC, id DESC
      LIMIT 1
    `).bind(id).first();

    const estado = limpiarTexto(row?.estado_origen).toUpperCase();
    const estadoReactivado = resolverEstadoDocumentalReactivado(estado);
    if (estadoReactivado) return estadoReactivado;

    const rowPrevio = await env.DB.prepare(`
      SELECT estado_destino
      FROM reservas_historial_estados
      WHERE reserva_id = ?
        AND estado_destino IN ('PENDIENTE', 'CONFIRMADA', 'RECHAZADA')
      ORDER BY fecha_evento DESC, id DESC
      LIMIT 1
    `).bind(id).first();

    const estadoPrevio = limpiarTexto(rowPrevio?.estado_destino).toUpperCase();
    return resolverEstadoDocumentalReactivado(estadoPrevio) || "PENDIENTE";
  } catch (_) {
    return "PENDIENTE";
  }
}

async function crearNotificacionReservaCondicionada(env, payload) {
  return await crearNotificacion(env, {
    usuarioId: Number(payload?.centro?.usuario_id || 0),
    rolDestino: "SOLICITANTE",
    tipo: "DOCUMENTACION",
    titulo: "Documentación pendiente para tus reservas",
    mensaje: `Tu documentación para ${nombreVisibleAdmin(payload?.admin)} necesita revisión o actualización. Algunas reservas han quedado suspendidas hasta que la regularices.`,
    urlDestino: payload?.enlace_perfil || ""
  });
}

async function crearNotificacionReservaReactivada(env, payload) {
  return await crearNotificacion(env, {
    usuarioId: Number(payload?.centro?.usuario_id || 0),
    rolDestino: "SOLICITANTE",
    tipo: "DOCUMENTACION",
    titulo: "Documentación al día y reservas reactivadas",
    mensaje: `Tu documentación para ${nombreVisibleAdmin(payload?.admin)} vuelve a estar al día. Ya puedes consultar tus reservas reactivadas en tu perfil.`,
    urlDestino: payload?.enlace_perfil || ""
  });
}

function construirCorreoCambioMarcoSinCambios(payload = {}) {
  const contacto = limpiarTexto(payload?.centro?.contacto || "");
  const saludo = contacto ? `Hola ${contacto},` : "Hola,";
  const adminNombre = nombreVisibleAdmin(payload?.admin || {});
  const motivo = limpiarTexto(payload?.motivo_texto || "Se ha actualizado la documentación obligatoria vigente.");
  const reservas = Array.isArray(payload?.reservas) ? payload.reservas : [];
  const pendientes = Array.isArray(payload?.documentos_pendientes) ? payload.documentos_pendientes : [];
  const codigoReservas = reservas
    .map((reserva) => limpiarTexto(reserva?.codigo_reserva || ""))
    .filter(Boolean);
  const reservasTexto = codigoReservas.length
    ? `Reservas vinculadas: ${codigoReservas.join(", ")}`
    : "";
  const detallePendientes = pendientes.length
    ? `Documentación pendiente o desactualizada: ${pendientes.map((item) => limpiarTexto(item?.nombre || "")).filter(Boolean).join(", ")}`
    : "";
  const asunto = `[Documentación] Actualización documental con reservas activas en ${adminNombre}`;
  const mensaje = estadoDocumentalCompleto(payload?.estado_documental)
    ? `La documentación obligatoria de ${adminNombre} se ha actualizado. Tus reservas activas no cambian de estado, pero conviene revisar el detalle en tu perfil.`
    : `La documentación obligatoria de ${adminNombre} se ha actualizado. Tus reservas activas no cambian de estado por ahora, pero debes revisar el detalle documental para evitar incidencias posteriores.`;

  const texto = [
    saludo,
    "",
    mensaje,
    "",
    motivo,
    reservasTexto,
    detallePendientes,
    "",
    "Puedes revisar el detalle desde tu perfil documental."
  ].filter(Boolean).join("\n");

  const html = `
    <p>${saludo}</p>
    <p>${escaparHtml(mensaje)}</p>
    <p>${escaparHtml(motivo)}</p>
    ${reservasTexto ? `<p><strong>Reservas vinculadas:</strong> ${escaparHtml(codigoReservas.join(", "))}</p>` : ""}
    ${detallePendientes ? `<p><strong>Documentación pendiente o desactualizada:</strong> ${escaparHtml(pendientes.map((item) => limpiarTexto(item?.nombre || "")).filter(Boolean).join(", "))}</p>` : ""}
    <p>Puedes revisar el detalle desde tu perfil documental.</p>
  `;

  return { asunto, texto, html };
}

async function notificarCambioMarcoSinCambios(env, payload) {
  const correo = construirCorreoCambioMarcoSinCambios(payload);
  return await enviarEmail(env, {
    to: payload?.centro?.email || "",
    subject: correo.asunto,
    text: correo.texto,
    html: correo.html
  });
}

async function crearNotificacionCambioMarcoSinCambios(env, payload) {
  return await crearNotificacion(env, {
    usuarioId: Number(payload?.centro?.usuario_id || 0),
    rolDestino: "SOLICITANTE",
    tipo: "DOCUMENTACION",
    titulo: "Marco documental actualizado",
    mensaje: estadoDocumentalCompleto(payload?.estado_documental)
      ? `La documentación obligatoria de ${nombreVisibleAdmin(payload?.admin)} se ha actualizado. Tus reservas activas se mantienen, pero conviene revisar el detalle en tu perfil.`
      : `La documentación obligatoria de ${nombreVisibleAdmin(payload?.admin)} se ha actualizado. Tus reservas activas siguen igual por ahora, pero debes revisar el detalle documental en tu perfil.`,
    urlDestino: payload?.enlace_perfil || ""
  });
}

function debeAvisarCambioMarcoSinCambios(motivo = "", avisarCambioMarcoSinCambios = false) {
  if (avisarCambioMarcoSinCambios) return true;
  return ["cambio_responsable", "documento_creado", "documento_eliminado", "documento_activado"].includes(
    limpiarTexto(motivo).toLowerCase()
  );
}

async function obtenerAdminsAfectadosPorPropietario(env, propietarioDocumentalId) {
  const propietario = Number(propietarioDocumentalId || 0);
  if (!(propietario > 0)) return [];

  await asegurarTablaPropietariosDocumentalesAdmin(env);
  await asegurarTablasDocumentacionActividad(env);

  const rows = await env.DB.prepare(`
    SELECT DISTINCT
      u.id,
      u.nombre,
      u.nombre_publico
    FROM usuarios u
    WHERE u.id IN (
      SELECT DISTINCT a.admin_id
      FROM actividades a
      INNER JOIN actividad_documentos_obligatorios ado
        ON ado.actividad_id = a.id
      WHERE ado.propietario_id = ?
        AND COALESCE(ado.activo, 1) = 1
      UNION
      SELECT DISTINCT v.admin_id
      FROM admin_documentacion_propietarios v
      WHERE v.propietario_id = ?
        AND COALESCE(v.activo, 1) = 1
      UNION
      SELECT ?
    )
      AND UPPER(COALESCE(u.rol, '')) IN ('ADMIN', 'SUPERADMIN')
      AND COALESCE(u.activo, 1) = 1
    ORDER BY
      CASE
        WHEN u.nombre_publico IS NOT NULL AND TRIM(u.nombre_publico) <> '' THEN TRIM(u.nombre_publico)
        ELSE TRIM(u.nombre)
      END COLLATE NOCASE ASC,
      u.id ASC
  `).bind(propietario, propietario, propietario).all();

  return (rows?.results || [])
    .map((row) => ({
      id: Number(row.id || 0),
      nombre: limpiarTexto(row.nombre),
      nombre_publico: limpiarTexto(row.nombre_publico)
    }))
    .filter((row) => row.id > 0);
}

export async function recalcularImpactoDocumentalReservasPorPropietario(env, {
  propietarioDocumentalId,
  baseUrl = "",
  motivo = "documentos_actualizados",
  avisarCambioMarcoSinCambios = false
} = {}) {
  const propietario = Number(propietarioDocumentalId || 0);
  if (!(propietario > 0)) {
    return {
      ok: false,
      error: "propietario_documental_id no valido."
    };
  }

  const admins = await obtenerAdminsAfectadosPorPropietario(env, propietario);
  const resumen = {
    ok: true,
    propietario_documental_id: propietario,
    motivo,
    admins_afectados: admins.length,
    detalle: []
  };

  for (const admin of admins) {
    const impacto = await recalcularImpactoDocumentalReservas(env, {
      adminId: Number(admin.id || 0),
      baseUrl,
      motivo,
      avisarCambioMarcoSinCambios
    });
    resumen.detalle.push({
      admin_id: Number(admin.id || 0),
      admin_nombre: admin.nombre_publico || admin.nombre || "",
      impacto
    });
  }

  return resumen;
}

export async function recalcularImpactoDocumentalReservas(env, {
  adminId,
  baseUrl = "",
  motivo = "documentos_actualizados",
  avisarCambioMarcoSinCambios = false
} = {}) {
  const adminIdNumerico = Number(adminId || 0);
  if (!(adminIdNumerico > 0)) {
    return {
      ok: false,
      error: "admin_id no valido."
    };
  }

  const { resolucion, documentos } = await obtenerDocumentosActivosVigentes(env, adminIdNumerico);
  if (!resolucion?.admin) {
    return {
      ok: false,
      error: "Administrador no encontrado."
    };
  }

  const admin = resolucion.admin;
  const solicitantes = await obtenerSolicitantesAfectados(env, adminIdNumerico);
  const resumen = {
    ok: true,
    admin_id: adminIdNumerico,
    motivo,
    total_solicitantes_revisados: 0,
    reservas_eliminadas_plazo_critico: 0,
    reservas_suspendidas: 0,
    reservas_reactivadas: 0,
    notificaciones_condicionadas: 0,
    notificaciones_reactivadas: 0,
    detalle: []
  };

  for (const solicitante of solicitantes) {
    resumen.total_solicitantes_revisados += 1;

    const estadoInicial = (documentos || []).length > 0 ? "NO_INICIADO" : "NO_REQUERIDA";
    const propietariosDocumentales = obtenerPropietariosDocumentos(documentos, adminIdNumerico);

    const reservas = await obtenerReservasActivasPorUsuario(env, adminIdNumerico, Number(solicitante.id || 0));
    if (!reservas.length) {
      resumen.detalle.push({
        centro_usuario_id: Number(solicitante.id || 0),
        email: solicitante.email || "",
        reservas_afectadas: [],
        estado_documental: "NO_REQUERIDA",
        accion: "SIN_RESERVAS"
      });
      continue;
    }

    const enlacePerfil = construirUrlPerfilDocumentacion(baseUrl, adminIdNumerico);
    const configuracionDocumentalPorActividad = await obtenerConfiguracionDocumentalPorActividades(
      env,
      reservas.map((reserva) => Number(reserva.actividad_id || 0))
    );
    const reservasSuspendidas = [];
    const reservasReactivadas = [];
    const reservasEliminadas = [];
    const pendientesPorReserva = new Map();
    const estadosDocumentalesReserva = [];

    for (const reserva of reservas) {
      const estadoReserva = limpiarTexto(reserva.estado).toUpperCase();
      const configuracionActividad = configuracionDocumentalPorActividad.get(Number(reserva.actividad_id || 0)) || null;
      const documentosExigiblesReserva = resolverDocumentosExigiblesActividad(documentos, configuracionActividad);
      const expedientesPorPropietarioReserva = await asegurarExpedientesPropietarios(
        env,
        Number(solicitante.id || 0),
        obtenerPropietariosDocumentos(documentosExigiblesReserva, adminIdNumerico),
        documentosExigiblesReserva,
        estadoInicial,
        {
          actividadId: Number(reserva.actividad_id || 0),
          reservaId: Number(reserva.id || 0)
        }
      );
      const archivosActivosReserva = await obtenerArchivosActivosExpedientes(env, expedientesPorPropietarioReserva);
      const estadoDocumentalReserva = calcularEstadoGlobal(documentosExigiblesReserva, archivosActivosReserva);
      estadosDocumentalesReserva.push(estadoDocumentalReserva);

      for (const propietarioId of obtenerPropietariosDocumentos(documentosExigiblesReserva, adminIdNumerico)) {
        const expedientePropietario = expedientesPorPropietarioReserva.get(Number(propietarioId || 0));
        if (!expedientePropietario?.id) continue;
        const documentosPropietario = (documentosExigiblesReserva || []).filter((doc) =>
          (obtenerPropietarioDocumento(doc) || Number(propietarioId || 0)) === Number(propietarioId || 0)
        );
        const archivosPropietario = archivosActivosReserva.filter((archivo) =>
          Number(archivo?.propietario_documental_id || 0) === Number(propietarioId || 0)
        );
        const estadoPropietario = calcularEstadoGlobal(documentosPropietario, archivosPropietario);
        const versionRequeridaPropietario = documentosPropietario.reduce(
          (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
          0
        );
        const versionAportadaPropietario = archivosPropietario.reduce(
          (max, archivo) => Math.max(max, Number(archivo.version_documental || 0)),
          0
        );
        const fechaUltimaEntregaPropietario = archivosPropietario.reduce((max, archivo) => {
          const actual = parsearFecha(archivo.fecha_subida);
          if (!actual) return max;
          if (!max || actual > max) return actual;
          return max;
        }, null);

        await actualizarExpediente(env, Number(expedientePropietario.id || 0), {
          version_requerida: versionRequeridaPropietario,
          version_aportada: versionAportadaPropietario,
          estado: estadoPropietario,
          fecha_ultima_entrega: fechaUltimaEntregaPropietario
            ? fechaUltimaEntregaPropietario.toISOString().replace("T", " ").slice(0, 19)
            : null,
          fecha_validacion: estadoPropietario === "VALIDADA" ? (expedientePropietario?.fecha_validacion || null) : null
        });
      }

      pendientesPorReserva.set(
        Number(reserva.id || 0),
        construirPendientes(documentosExigiblesReserva, archivosActivosReserva)
      );

      if (estadoDocumentalCompleto(estadoDocumentalReserva)) {
        if (estadoReserva === "EN_REVISION") {
          const estadoDestino = "PENDIENTE";
          await actualizarEstadoReserva(env, Number(reserva.id || 0), estadoDestino);
          await registrarEventoReserva(env, {
            reservaId: Number(reserva.id || 0),
            accion: "REACTIVACION_DOCUMENTAL",
            estadoOrigen: "EN_REVISION",
            estadoDestino,
            observaciones: "La documentación exigible de la actividad vuelve a estar completa y queda pendiente de autorización."
          });
          reservasReactivadas.push({
            ...reserva,
            estado_reactivado: estadoDestino
          });
          resumen.reservas_reactivadas += 1;
        } else if (estadoReserva === "SUSPENDIDA") {
          const estadoDestino = await obtenerEstadoPrevioSuspensionDocumental(env, Number(reserva.id || 0));
          await actualizarEstadoReserva(env, Number(reserva.id || 0), estadoDestino);
          await registrarEventoReserva(env, {
            reservaId: Number(reserva.id || 0),
            accion: "REACTIVACION_DOCUMENTAL",
            estadoOrigen: "SUSPENDIDA",
            estadoDestino,
            observaciones: "La documentación exigible de la actividad vuelve a estar completa."
          });
          reservasReactivadas.push({
            ...reserva,
            estado_reactivado: estadoDestino
          });
          resumen.reservas_reactivadas += 1;
        }
      } else if (reservaEnPlazoCriticoDocumental(reserva)) {
        const eliminada = await eliminarReservaPorDocumentacionCritica(env, Number(reserva.id || 0));
        if (eliminada) {
          await registrarEventoReserva(env, {
            reservaId: Number(reserva.id || 0),
            accion: "ELIMINACION_DOCUMENTAL_CRITICA",
            estadoOrigen: estadoReserva,
            estadoDestino: "ELIMINADA",
            observaciones: "La solicitud no conserva la documentación obligatoria requerida dentro de las 24 horas previas al inicio."
          });
          reservasEliminadas.push(reserva);
          resumen.reservas_eliminadas_plazo_critico += 1;
        }
      } else {
        const estadoDestinoDocumental = estadoDocumentalReserva === "EN_REVISION" ? "EN_REVISION" : "SUSPENDIDA";
        if (estadoReserva === estadoDestinoDocumental) continue;
        await actualizarEstadoReserva(env, Number(reserva.id || 0), estadoDestinoDocumental);
        await registrarEventoReserva(env, {
          reservaId: Number(reserva.id || 0),
          accion: estadoDestinoDocumental === "EN_REVISION" ? "REVISION_DOCUMENTAL" : "SUSPENSION_DOCUMENTAL",
          estadoOrigen: estadoReserva,
          estadoDestino: estadoDestinoDocumental,
          observaciones: estadoDestinoDocumental === "EN_REVISION"
            ? "La actividad tiene documentación remitida pendiente de revisión por sus propietarios documentales."
            : "La actividad exige documentación pendiente, rechazada o desactualizada."
        });
        if (estadoDestinoDocumental === "SUSPENDIDA") {
          reservasSuspendidas.push(reserva);
          resumen.reservas_suspendidas += 1;
        }
      }
    }

    const pendientesSuspendidas = unificarPendientesReservas(
      reservasSuspendidas.map((reserva) => pendientesPorReserva.get(Number(reserva.id || 0)) || [])
    );
    const pendientesSinCambios = unificarPendientesReservas(
      reservas.map((reserva) => pendientesPorReserva.get(Number(reserva.id || 0)) || [])
    );
    const estadoGlobal = resumirEstadosDocumentales(estadosDocumentalesReserva);

    const debeAvisarSinCambios = debeAvisarCambioMarcoSinCambios(motivo, avisarCambioMarcoSinCambios);

    if (reservasSuspendidas.length) {
        const contactoCorreo = resolverContactoReservaParaCorreo(reservasSuspendidas);
      const payloadNotificacion = {
          admin,
          responsable: resolucion.responsable,
          centro: {
            usuario_id: Number(solicitante.id || 0),
            centro: solicitante.centro || "",
            contacto: contactoCorreo.contacto,
            email: contactoCorreo.email
          },
          motivo_texto: motivoImpactoDocumentalTexto(motivo),
          reservas: reservasSuspendidas,
          documentos_pendientes: pendientesSuspendidas,
        enlace_perfil: enlacePerfil
      };
      const resultado = await notificarReservaCondicionada(env, payloadNotificacion);
      if (resultado.ok) resumen.notificaciones_condicionadas += 1;
      try {
        await crearNotificacionReservaCondicionada(env, payloadNotificacion);
      } catch (errorNotificacionInterna) {
        console.error("No se pudo crear la notificación interna de suspensión documental.", {
          admin_id: Number(adminIdNumerico || 0),
          centro_usuario_id: Number(solicitante.id || 0),
          error: errorNotificacionInterna?.message || String(errorNotificacionInterna || "")
        });
      }
    }

    if (reservasEliminadas.length) {
      const contactoCorreo = resolverContactoReservaParaCorreo(reservasEliminadas);
      const payloadNotificacion = {
        admin,
        responsable: resolucion.responsable,
        centro: {
          usuario_id: Number(solicitante.id || 0),
          centro: solicitante.centro || "",
          contacto: contactoCorreo.contacto,
          email: contactoCorreo.email
        },
        motivo_texto: motivoImpactoDocumentalTexto(motivo),
        reservas: reservasEliminadas,
        documentos_pendientes: unificarPendientesReservas(
          reservasEliminadas.map((reserva) => pendientesPorReserva.get(Number(reserva.id || 0)) || [])
        ),
        enlace_perfil: enlacePerfil
      };
      const resultado = await notificarReservaEliminadaDocumentacionCritica(env, payloadNotificacion);
      if (resultado.ok) resumen.notificaciones_condicionadas += 1;
      try {
        await crearNotificacion(env, {
          usuarioId: Number(solicitante.id || 0),
          rolDestino: "SOLICITANTE",
          tipo: "DOCUMENTACION",
          titulo: "Solicitud eliminada por documentación",
          mensaje: `Una o varias solicitudes de ${nombreVisibleAdmin(admin)} han sido eliminadas por no conservar la documentación obligatoria dentro del plazo mínimo previo al inicio.`,
          urlDestino: enlacePerfil
        });
      } catch (errorNotificacionInterna) {
        console.error("No se pudo crear la notificación interna de eliminación documental crítica.", {
          admin_id: Number(adminIdNumerico || 0),
          centro_usuario_id: Number(solicitante.id || 0),
          error: errorNotificacionInterna?.message || String(errorNotificacionInterna || "")
        });
      }
    }

    if (reservasReactivadas.length) {
        const contactoCorreo = resolverContactoReservaParaCorreo(reservasReactivadas);
        const payloadNotificacion = {
          admin,
          responsable: resolucion.responsable,
          centro: {
            usuario_id: Number(solicitante.id || 0),
            centro: solicitante.centro || "",
            contacto: contactoCorreo.contacto,
            email: contactoCorreo.email
          },
          motivo_texto: motivoImpactoDocumentalTexto(motivo),
          reservas: reservasReactivadas,
          estado_destino: reservasReactivadas.some((reserva) => limpiarTexto(reserva.estado_reactivado).toUpperCase() === "PENDIENTE")
            ? "PENDIENTE"
            : "CONFIRMADA",
          enlace_perfil: enlacePerfil
      };
      const resultado = await notificarReservaReactivada(env, payloadNotificacion);
      if (resultado.ok) resumen.notificaciones_reactivadas += 1;
      try {
        await crearNotificacionReservaReactivada(env, payloadNotificacion);
      } catch (errorNotificacionInterna) {
        console.error("No se pudo crear la notificación interna de reactivación documental.", {
          admin_id: Number(adminIdNumerico || 0),
          centro_usuario_id: Number(solicitante.id || 0),
          error: errorNotificacionInterna?.message || String(errorNotificacionInterna || "")
        });
      }
    }

    if (debeAvisarSinCambios && !reservasSuspendidas.length && !reservasReactivadas.length) {
      const contactoCorreo = resolverContactoReservaParaCorreo(reservas);
      const payloadNotificacion = {
        admin,
        responsable: resolucion.responsable,
        centro: {
          usuario_id: Number(solicitante.id || 0),
          centro: solicitante.centro || "",
          contacto: contactoCorreo.contacto,
          email: contactoCorreo.email
        },
        motivo_texto: motivoImpactoDocumentalTexto(motivo),
        reservas,
        documentos_pendientes: pendientesSinCambios,
        estado_documental: estadoGlobal,
        enlace_perfil: enlacePerfil
      };
      const resultado = await notificarCambioMarcoSinCambios(env, payloadNotificacion);
      if (resultado.ok) {
        resumen.notificaciones_condicionadas += 1;
      }
      try {
        await crearNotificacionCambioMarcoSinCambios(env, payloadNotificacion);
      } catch (errorNotificacionInterna) {
        console.error("No se pudo crear la notificación interna de cambio documental sin cambios de reserva.", {
          admin_id: Number(adminIdNumerico || 0),
          centro_usuario_id: Number(solicitante.id || 0),
          error: errorNotificacionInterna?.message || String(errorNotificacionInterna || "")
        });
      }
    }

    resumen.detalle.push({
      centro_usuario_id: Number(solicitante.id || 0),
      email: solicitante.email || "",
      reservas_afectadas: reservas.map((reserva) => {
        const reactivada = reservasReactivadas.find((item) => Number(item.id || 0) === Number(reserva.id || 0));
        return {
          id: Number(reserva.id || 0),
          codigo_reserva: reserva.codigo_reserva || "",
          estado_anterior: reserva.estado || "",
          estado_nuevo: reservasSuspendidas.some((item) => Number(item.id || 0) === Number(reserva.id || 0))
            ? "SUSPENDIDA"
            : reservasEliminadas.some((item) => Number(item.id || 0) === Number(reserva.id || 0))
              ? "ELIMINADA"
              : (reactivada?.estado_reactivado || reserva.estado || "")
        };
      }),
      estado_documental: estadoGlobal,
      pendientes: pendientesSinCambios,
      accion: reservasSuspendidas.length
        ? "SUSPENDIDA"
        : reservasEliminadas.length
          ? "ELIMINADA"
          : reservasReactivadas.length
            ? "REACTIVADA"
            : "SIN_CAMBIOS"
    });
  }

  return resumen;
}
