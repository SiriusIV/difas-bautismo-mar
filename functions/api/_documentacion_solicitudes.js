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
  for (const archivo of Array.isArray(archivos) ? archivos : []) {
    if (!esEntregaMaterializada(archivo)) continue;
    const nombre = limpiarTexto(archivo.nombre_documento);
    const propietarioId = obtenerPropietarioDocumento(archivo);
    const claves = [
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
  return mapa;
}

function entregaParaDocumento(doc, entregas) {
  const nombre = limpiarTexto(doc?.nombre);
  if (!nombre) return null;
  const propietarioId = obtenerPropietarioDocumento(doc);
  return entregas.get(claveDocumento(nombre, propietarioId)) ||
    entregas.get(claveDocumento(nombre)) ||
    null;
}

function construirDocumentoCongeladoDesdeEntrega(archivo = {}, docBase = null) {
  const archivoId = Number(archivo?.id || 0);
  const propietarioId = obtenerPropietarioDocumento(archivo) || obtenerPropietarioDocumento(docBase);
  return {
    id: Number(docBase?.id || 0) > 0 ? Number(docBase.id) : 1000000000 + archivoId,
    admin_id: propietarioId,
    propietario_id: propietarioId,
    propietario_rol: limpiarTexto(docBase?.propietario_rol),
    propietario_nombre: limpiarTexto(docBase?.propietario_nombre),
    nombre: limpiarTexto(docBase?.nombre || archivo?.nombre_documento),
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

  for (const doc of Array.isArray(documentosVigentes) ? documentosVigentes : []) {
    const nombre = limpiarTexto(doc?.nombre);
    if (!nombre) continue;
    const propietarioId = obtenerPropietarioDocumento(doc);
    const entrega = entregaParaDocumento(doc, entregas);
    const documento = entrega
      ? construirDocumentoCongeladoDesdeEntrega(entrega, doc)
      : doc;
    const clave = claveDocumento(documento.nombre, propietarioId || obtenerPropietarioDocumento(documento));
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(documento);
  }

  for (const archivo of Array.isArray(archivosActivos) ? archivosActivos : []) {
    if (!esEntregaMaterializada(archivo)) continue;
    const clave = claveDocumento(archivo.nombre_documento, obtenerPropietarioDocumento(archivo));
    if (!clave || vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(construirDocumentoCongeladoDesdeEntrega(archivo));
  }

  return salida;
}
