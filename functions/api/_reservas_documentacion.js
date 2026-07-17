import {
  obtenerCatalogoDocumentosActivosAdmin,
  leerConfiguracionDocumentalActividad,
  resolverDocumentosExigiblesActividad
} from "./_actividad_documentacion.js";
import { obtenerCatalogoDocumentalVinculadoAdmin } from "./_documentacion_propietarios.js";
import {
  asegurarColumnasContextoDocumental,
  construirCondicionContextoDocumental,
  normalizarContextoDocumental
} from "./_documentacion_contextual.js";

function limpiarTexto(valor) {
  return String(valor || "").trim();
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

function obtenerPropietarioDocumentalDocumento(doc) {
  return Number(doc?.propietario_id || doc?.admin_id || 0);
}

function claveDocumento(nombre, propietarioId = 0) {
  const nombreNormalizado = limpiarTexto(nombre).toUpperCase();
  const propietario = Number(propietarioId || 0);
  return propietario > 0
    ? `${propietario}::${nombreNormalizado}`
    : nombreNormalizado;
}

function parsearFechaComparable(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return null;
  const fecha = new Date(texto.replace(" ", "T"));
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function calcularEstadoDocumento(doc, entrega) {
  if (!entrega) {
    return "NO_ENVIADO";
  }

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

function esMejorEntregaDocumento(candidata, actual) {
  if (!actual) return true;
  const prioridadCandidata = Number(candidata?.prioridad_contexto || 0);
  const prioridadActual = Number(actual?.prioridad_contexto || 0);
  if (prioridadCandidata !== prioridadActual) {
    return prioridadCandidata > prioridadActual;
  }
  return Number(candidata?.id || 0) > Number(actual?.id || 0);
}

function indexarArchivosPorDocumento(archivosActivos = []) {
  const porDocumento = new Map();

  for (const archivo of Array.isArray(archivosActivos) ? archivosActivos : []) {
    const nombre = limpiarTexto(archivo?.nombre_documento);
    if (!nombre) continue;
    const propietarioId = Number(archivo?.propietario_documental_id || archivo?.admin_id || 0);
    const keyPropietario = claveDocumento(nombre, propietarioId);
    const keyLegacy = claveDocumento(nombre);
    const existente = porDocumento.get(keyPropietario);
    if (esMejorEntregaDocumento(archivo, existente)) {
      porDocumento.set(keyPropietario, archivo);
      if (esMejorEntregaDocumento(archivo, porDocumento.get(keyLegacy))) {
        porDocumento.set(keyLegacy, archivo);
      }
    }
  }

  return porDocumento;
}

function obtenerEntregaDocumento(doc, archivosPorDocumento) {
  const nombre = limpiarTexto(doc?.nombre);
  if (!nombre || !archivosPorDocumento) return null;
  const propietarioId = obtenerPropietarioDocumentalDocumento(doc);
  return archivosPorDocumento.get(claveDocumento(nombre, propietarioId)) ||
    archivosPorDocumento.get(claveDocumento(nombre)) ||
    null;
}

function calcularEstadoGlobal(documentosActivos, archivosActivos) {
  if (!Array.isArray(documentosActivos) || documentosActivos.length === 0) {
    return "NO_REQUERIDA";
  }

  const archivosPorDocumento = indexarArchivosPorDocumento(archivosActivos);

  const estados = documentosActivos.map((doc) => {
    const entrega = obtenerEntregaDocumento(doc, archivosPorDocumento);
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

function normalizarEstadoExpediente(estado) {
  const valor = normalizarEstadoDocumento(estado);
  if (valor === "VALIDADO") return "VALIDADA";
  return valor;
}

function expedientesDocumentalesCompletos(propietarios = [], expedientesPorPropietario = new Map()) {
  const ids = (Array.isArray(propietarios) ? propietarios : [])
    .map((id) => Number(id || 0))
    .filter((id) => id > 0);
  if (!ids.length) return false;

  return ids.every((propietarioId) => {
    const expediente = expedientesPorPropietario.get(propietarioId);
    if (!expediente) return false;
    return normalizarEstadoExpediente(expediente.estado) === "VALIDADA";
  });
}

function construirDocumentosPendientes(documentosActivos, archivosActivos) {
  const archivosPorDocumento = indexarArchivosPorDocumento(archivosActivos);

  return (documentosActivos || [])
    .map((doc) => {
      const entrega = obtenerEntregaDocumento(doc, archivosPorDocumento);
      const estado = calcularEstadoDocumento(doc, entrega);
      return {
        id: Number(doc.id || 0),
        nombre: limpiarTexto(doc.nombre),
        propietario_documental_id: obtenerPropietarioDocumentalDocumento(doc),
        propietario_documental_nombre: limpiarTexto(doc.propietario_nombre),
        estado
      };
    })
    .filter((doc) => doc.estado !== "VALIDADO");
}

function obtenerPropietariosDocumentales(documentos = []) {
  return Array.from(new Set(
    (Array.isArray(documentos) ? documentos : [])
      .map((doc) => obtenerPropietarioDocumentalDocumento(doc))
      .filter((id) => id > 0)
  ));
}

async function obtenerExpedientesPorPropietario(env, centroUsuarioId, propietarios = [], contexto = {}) {
  const ids = Array.from(new Set(
    (Array.isArray(propietarios) ? propietarios : [])
      .map((id) => Number(id || 0))
      .filter((id) => id > 0)
  ));
  const mapa = new Map();
  if (!ids.length) return mapa;

  const condicion = construirCondicionContextoDocumental(contexto);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await env.DB.prepare(`
    SELECT
      id,
      admin_id,
      actividad_id,
      reserva_id,
      estado
    FROM centro_admin_documentacion
    WHERE centro_usuario_id = ?
      AND admin_id IN (${placeholders})
      AND ${condicion.sql}
  `).bind(centroUsuarioId, ...ids, ...condicion.valores).all();

  for (const row of rows?.results || []) {
    mapa.set(Number(row.admin_id || 0), row);
  }
  return mapa;
}

async function obtenerArchivosActivosPorExpedientes(env, expedientesPorPropietario = new Map()) {
  const expedientes = Array.from(expedientesPorPropietario.values())
    .filter((expediente) => Number(expediente?.id || 0) > 0);
  if (!expedientes.length) return [];

  const propietarioPorExpediente = new Map(
    expedientes.map((expediente) => [Number(expediente.id || 0), Number(expediente.admin_id || 0)])
  );
  const placeholders = expedientes.map(() => "?").join(", ");

  const rows = await env.DB.prepare(`
    SELECT
      id,
      documentacion_id,
      nombre_documento,
      version_documental,
      estado,
      fecha_subida
    FROM centro_admin_documentacion_archivos
    WHERE documentacion_id IN (${placeholders})
      AND activo = 1
    ORDER BY id ASC
  `).bind(...expedientes.map((expediente) => expediente.id)).all();

  return (rows?.results || []).map((row) => ({
    ...row,
    propietario_documental_id: propietarioPorExpediente.get(Number(row.documentacion_id || 0)) || 0,
    prioridad_contexto: 1
  }));
}

async function obtenerArchivosActivosContextoReserva(env, {
  usuarioId,
  actividadId,
  reservaId,
  propietarios
} = {}) {
  const usuario = Number(usuarioId || 0);
  const actividad = Number(actividadId || 0);
  const reserva = Number(reservaId || 0);
  const ids = Array.from(new Set(
    (Array.isArray(propietarios) ? propietarios : [])
      .map((id) => Number(id || 0))
      .filter((id) => id > 0)
  ));

  if (!(usuario > 0) || !(actividad > 0) || !ids.length) return [];

  const placeholders = ids.map(() => "?").join(", ");
  const condicionesReserva = reserva > 0
    ? "(cad.reserva_id = ? OR cad.reserva_id IS NULL)"
    : "cad.reserva_id IS NULL";
  const binds = [
    usuario,
    actividad,
    ...ids,
    ...(reserva > 0 ? [reserva] : [])
  ];

  const rows = await env.DB.prepare(`
    SELECT
      a.id,
      a.documentacion_id,
      a.nombre_documento,
      a.version_documental,
      a.estado,
      a.fecha_subida,
      cad.admin_id AS propietario_documental_id,
      cad.reserva_id,
      CASE
        WHEN ? > 0 AND cad.reserva_id = ? THEN 3
        WHEN cad.reserva_id IS NULL THEN 2
        ELSE 1
      END AS prioridad_contexto
    FROM centro_admin_documentacion cad
    INNER JOIN centro_admin_documentacion_archivos a
      ON a.documentacion_id = cad.id
     AND COALESCE(a.activo, 1) = 1
    WHERE cad.centro_usuario_id = ?
      AND cad.actividad_id = ?
      AND cad.admin_id IN (${placeholders})
      AND ${condicionesReserva}
    ORDER BY prioridad_contexto DESC, a.id ASC
  `).bind(
    reserva,
    reserva,
    ...binds
  ).all();

  return rows?.results || [];
}

export async function validarDocumentacionReserva(env, {
  usuarioId,
  adminId,
  actividadId,
  reservaId = null
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

  await asegurarColumnasContextoDocumental(env);
  const contextoEntrega = normalizarContextoDocumental({
    actividadId: actividad,
    reservaId
  });
  const catalogo = await obtenerCatalogoDocumentalVinculadoAdmin(
    env,
    admin,
    await obtenerCatalogoDocumentosActivosAdmin(env, admin)
  );
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

  const propietarios = obtenerPropietariosDocumentales(documentosExigibles);
  const expedientesPorPropietario = await obtenerExpedientesPorPropietario(env, usuario, propietarios, contextoEntrega);
  if (contextoEntrega.reservaId) {
    const pendientesActividad = await obtenerExpedientesPorPropietario(env, usuario, propietarios, {
      actividadId: contextoEntrega.actividadId,
      reservaId: null
    });
    for (const propietarioId of propietarios) {
      if (!expedientesPorPropietario.has(propietarioId) && pendientesActividad.has(propietarioId)) {
        expedientesPorPropietario.set(propietarioId, pendientesActividad.get(propietarioId));
      }
    }
  }
  const archivosActivos = await obtenerArchivosActivosPorExpedientes(env, expedientesPorPropietario);
  const archivosContextoReserva = await obtenerArchivosActivosContextoReserva(env, {
    usuarioId: usuario,
    actividadId: actividad,
    reservaId: contextoEntrega.reservaId,
    propietarios
  });
  const archivosParaCalculo = [
    ...archivosActivos,
    ...archivosContextoReserva
  ];
  const estadoDocumental = calcularEstadoGlobal(documentosExigibles, archivosParaCalculo);
  const documentosPendientes = construirDocumentosPendientes(documentosExigibles, archivosParaCalculo);
  const expedientesCompletos = expedientesDocumentalesCompletos(propietarios, expedientesPorPropietario);
  const okFinal = estadoDocumentalCompleto(estadoDocumental) || expedientesCompletos;
  const estadosExpedientes = propietarios.map((propietarioId) =>
    normalizarEstadoExpediente(expedientesPorPropietario.get(propietarioId)?.estado || "")
  ).filter(Boolean);

  return {
    ok: okFinal,
    requiere_documentacion: true,
    estado_documental: okFinal ? "VALIDADA" : estadoDocumental,
    estado_expediente: estadosExpedientes.includes("EN_REVISION")
      ? "EN_REVISION"
      : (estadosExpedientes[0] || ""),
    documentos_pendientes: okFinal ? [] : documentosPendientes,
    error: okFinal
      ? ""
      : "Para poder solicitar esta actividad debes remitir la documentación obligatoria vinculada a ella."
  };
}

