function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarClaveTexto(valor) {
  return limpiarTexto(valor)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function obtenerPropietarioDocumento(doc = {}) {
  return Number(doc?.propietario_id || doc?.propietario_documental_id || doc?.admin_id || 0);
}

function claveDocumento(nombre, propietarioId = 0) {
  const nombreNormalizado = normalizarClaveTexto(nombre);
  const propietario = Number(propietarioId || 0);
  return propietario > 0
    ? `${propietario}::${nombreNormalizado}`
    : nombreNormalizado;
}

function claveDocumentoId(documentoId) {
  const id = Number(documentoId || 0);
  return id > 0 ? `ID:${id}` : "";
}

function normalizarEstadoDocumento(estado) {
  const valor = normalizarClaveTexto(estado);
  if (valor === "VALIDADA" || valor === "APROBADO" || valor === "APROBADA") return "VALIDADO";
  if (valor === "EN REVISION") return "EN_REVISION";
  return valor || "EN_REVISION";
}

function esEntregaMaterializada(archivo = {}) {
  if (!limpiarTexto(archivo?.nombre_documento)) return false;
  if (!limpiarTexto(archivo?.archivo_url)) return false;
  return normalizarEstadoDocumento(archivo?.estado) !== "NO_ENVIADO";
}

function esMejorEntrega(candidata, actual) {
  if (!actual) return true;
  const prioridadCandidata = Number(candidata?.prioridad_contexto || 0);
  const prioridadActual = Number(actual?.prioridad_contexto || 0);
  if (prioridadCandidata !== prioridadActual) {
    return prioridadCandidata > prioridadActual;
  }
  return Number(candidata?.id || 0) > Number(actual?.id || 0);
}

function indexarEntregas(archivos = []) {
  const mapa = new Map();
  const legacyPorPropietario = new Map();
  for (const archivo of Array.isArray(archivos) ? archivos : []) {
    if (!esEntregaMaterializada(archivo)) continue;
    const nombre = limpiarTexto(archivo.nombre_documento);
    const propietarioId = obtenerPropietarioDocumento(archivo);
    if (propietarioId > 0 && !(Number(archivo?.documento_id || 0) > 0)) {
      if (!legacyPorPropietario.has(propietarioId)) legacyPorPropietario.set(propietarioId, []);
      legacyPorPropietario.get(propietarioId).push(archivo);
    }
    const claves = [
      claveDocumentoId(archivo.documento_id),
      claveDocumento(nombre, propietarioId),
      claveDocumento(nombre)
    ];
    for (const clave of claves) {
      if (!clave) continue;
      if (esMejorEntrega(archivo, mapa.get(clave))) {
        mapa.set(clave, archivo);
      }
    }
  }
  mapa.legacyPorPropietario = legacyPorPropietario;
  return mapa;
}

function entregaParaDocumento(doc, entregas) {
  const nombre = limpiarTexto(doc?.nombre);
  const documentoId = Number(doc?.id || doc?.documento_id || 0);
  if (!nombre && !(documentoId > 0)) return null;
  const propietarioId = obtenerPropietarioDocumento(doc);
  return entregas.get(claveDocumentoId(documentoId)) ||
    entregas.get(claveDocumento(nombre, propietarioId)) ||
    entregas.get(claveDocumento(nombre)) ||
    null;
}

function idEntrega(archivo = {}) {
  return Number(archivo?.id || 0) || limpiarTexto(archivo?.archivo_url) || limpiarTexto(archivo?.nombre_documento);
}

function entregaLegacyDisponibleParaDocumento(doc, entregas, usadas, nombresVigentesPorPropietario) {
  const propietarioId = obtenerPropietarioDocumento(doc);
  if (!(propietarioId > 0)) return null;
  const candidatas = entregas?.legacyPorPropietario?.get(propietarioId) || [];
  const nombresVigentes = nombresVigentesPorPropietario.get(propietarioId) || new Set();
  return candidatas.find((archivo) =>
    !usadas.has(idEntrega(archivo)) &&
    !nombresVigentes.has(normalizarClaveTexto(archivo?.nombre_documento))
  ) || null;
}

function construirDocumentoCongeladoDesdeEntrega(archivo = {}, docBase = null) {
  const archivoId = Number(archivo?.id || 0);
  const propietarioId = obtenerPropietarioDocumento(archivo) || obtenerPropietarioDocumento(docBase);
  return {
    id: Number(docBase?.id || archivo?.documento_id || 0) > 0 ? Number(docBase?.id || archivo.documento_id) : 1000000000 + archivoId,
    admin_id: propietarioId,
    propietario_id: propietarioId,
    propietario_rol: limpiarTexto(docBase?.propietario_rol),
    propietario_nombre: limpiarTexto(docBase?.propietario_nombre),
    nombre: limpiarTexto(archivo?.nombre_documento || docBase?.nombre),
    descripcion: limpiarTexto(docBase?.descripcion),
    archivo_url: docBase?.archivo_url || "",
    orden: Number(docBase?.orden || 0),
    version_documental: Number(archivo?.version_documental || docBase?.version_documental || 0),
    fecha_actualizacion: "",
    congelado_por_entrega: true
  };
}

export function resolverDocumentosSolicitudConEntregas(documentosVigentes = [], archivosActivos = []) {
  const entregas = indexarEntregas(archivosActivos);
  const salida = [];
  const vistos = new Set();
  const entregasUsadas = new Set();
  const nombresVigentesPorPropietario = new Map();

  for (const doc of Array.isArray(documentosVigentes) ? documentosVigentes : []) {
    const propietarioId = obtenerPropietarioDocumento(doc);
    const nombreNormalizado = normalizarClaveTexto(doc?.nombre);
    if (!(propietarioId > 0) || !nombreNormalizado) continue;
    if (!nombresVigentesPorPropietario.has(propietarioId)) {
      nombresVigentesPorPropietario.set(propietarioId, new Set());
    }
    nombresVigentesPorPropietario.get(propietarioId).add(nombreNormalizado);
  }

  for (const doc of Array.isArray(documentosVigentes) ? documentosVigentes : []) {
    const nombre = limpiarTexto(doc?.nombre);
    if (!nombre) continue;
    const propietarioId = obtenerPropietarioDocumento(doc);
    const entregaDirecta = entregaParaDocumento(doc, entregas);
    const entrega = entregaDirecta && !entregasUsadas.has(idEntrega(entregaDirecta))
      ? entregaDirecta
      : entregaLegacyDisponibleParaDocumento(doc, entregas, entregasUsadas, nombresVigentesPorPropietario);
    const documento = entrega
      ? construirDocumentoCongeladoDesdeEntrega(entrega, doc)
      : doc;
    const clave = claveDocumentoId(doc?.id) || claveDocumento(documento.nombre, propietarioId || obtenerPropietarioDocumento(documento));
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    if (entrega) entregasUsadas.add(idEntrega(entrega));
    salida.push(documento);
  }

  for (const archivo of Array.isArray(archivosActivos) ? archivosActivos : []) {
    if (!esEntregaMaterializada(archivo)) continue;
    if (entregasUsadas.has(idEntrega(archivo))) continue;
    const clave = claveDocumentoId(archivo.documento_id) ||
      claveDocumento(archivo.nombre_documento, obtenerPropietarioDocumento(archivo));
    if (!clave || vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(construirDocumentoCongeladoDesdeEntrega(archivo));
  }

  return salida;
}
