import {
  obtenerCatalogoDocumentosActivosAdmin,
  leerConfiguracionDocumentalActividad,
  resolverDocumentosExigiblesActividad
} from "./_actividad_documentacion.js";

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarEstadoDocumento(estado) {
  const valor = limpiarTexto(estado).toUpperCase();
  return valor || "EN_REVISION";
}

function calcularEstadoDocumento(doc, entrega) {
  if (!entrega) {
    return "NO_ENVIADO";
  }

  if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) {
    return "NO_ACTUALIZADO";
  }

  return normalizarEstadoDocumento(entrega.estado);
}

function calcularEstadoGlobal(documentosActivos, archivosActivos) {
  if (!Array.isArray(documentosActivos) || documentosActivos.length === 0) {
    return "NO_REQUERIDA";
  }

  const archivosPorNombre = new Map(
    (archivosActivos || []).map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo])
  );

  const estados = documentosActivos.map((doc) => {
    const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;
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

function construirDocumentosPendientes(documentosActivos, archivosActivos) {
  const archivosPorNombre = new Map(
    (archivosActivos || []).map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo])
  );

  return (documentosActivos || [])
    .map((doc) => {
      const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;
      const estado = calcularEstadoDocumento(doc, entrega);
      return {
        id: Number(doc.id || 0),
        nombre: limpiarTexto(doc.nombre),
        estado
      };
    })
    .filter((doc) => doc.estado !== "VALIDADO");
}

async function obtenerExpediente(env, centroUsuarioId, adminId) {
  return await env.DB.prepare(`
    SELECT
      id
    FROM centro_admin_documentacion
    WHERE centro_usuario_id = ?
      AND admin_id = ?
    LIMIT 1
  `).bind(centroUsuarioId, adminId).first();
}

async function obtenerArchivosActivos(env, documentacionId) {
  if (!documentacionId) return [];

  const rows = await env.DB.prepare(`
    SELECT
      id,
      nombre_documento,
      version_documental,
      estado
    FROM centro_admin_documentacion_archivos
    WHERE documentacion_id = ?
      AND activo = 1
    ORDER BY id ASC
  `).bind(documentacionId).all();

  return rows?.results || [];
}

export async function validarDocumentacionReserva(env, {
  usuarioId,
  adminId,
  actividadId
} = {}) {
  const usuario = Number(usuarioId || 0);
  const admin = Number(adminId || 0);
  const actividad = Number(actividadId || 0);

  if (!(usuario > 0) || !(admin > 0) || !(actividad > 0)) {
    return {
      ok: false,
      error: "Faltan datos para validar la documentación de la solicitud."
    };
  }

  const catalogo = await obtenerCatalogoDocumentosActivosAdmin(env, admin);
  const configuracion = await leerConfiguracionDocumentalActividad(env, actividad);
  const documentosExigibles = resolverDocumentosExigiblesActividad(catalogo, configuracion);

  if (!documentosExigibles.length) {
    return {
      ok: true,
      requiere_documentacion: false,
      estado_documental: "NO_REQUERIDA",
      documentos_pendientes: []
    };
  }

  const expediente = await obtenerExpediente(env, usuario, admin);
  const archivosActivos = expediente?.id ? await obtenerArchivosActivos(env, expediente.id) : [];
  const estadoDocumental = calcularEstadoGlobal(documentosExigibles, archivosActivos);
  const documentosPendientes = construirDocumentosPendientes(documentosExigibles, archivosActivos);

  return {
    ok: estadoDocumentalCompleto(estadoDocumental),
    requiere_documentacion: true,
    estado_documental: estadoDocumental,
    documentos_pendientes: documentosPendientes,
    error: estadoDocumentalCompleto(estadoDocumental)
      ? ""
      : "Para poder solicitar esta actividad debes remitir la documentación obligatoria vinculada a ella."
  };
}
