import {
  obtenerCatalogoDocumentosActivosAdmin,
  obtenerConfiguracionDocumentalPorActividades,
  resolverDocumentosExigiblesActividad
} from "./_actividad_documentacion.js";

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarEstadoDocumento(estado) {
  const valor = String(estado || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (valor === "VALIDADA" || valor === "APROBADA") return "VALIDADO";
  if (valor === "EN REVISION") return "EN_REVISION";
  return valor || "EN_REVISION";
}

function calcularEstadoDocumento(doc, entrega) {
  if (!entrega) return "NO_ENVIADO";
  if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) return "NO_ACTUALIZADO";
  return normalizarEstadoDocumento(entrega.estado);
}

function documentoCumple(doc, entrega) {
  return calcularEstadoDocumento(doc, entrega) === "VALIDADO";
}

export async function construirResumenActividadesSolicitables(env, {
  adminId,
  documentacionId
} = {}) {
  const admin = Number(adminId || 0);
  const docId = Number(documentacionId || 0);
  if (!(admin > 0) || !(docId > 0)) {
    return {
      total_activas: 0,
      solicitables_total: 0,
      bloqueadas_total: 0,
      puede_todas: false,
      solicitables: [],
      bloqueadas: []
    };
  }

  const [catalogo, actividadesRows, archivosRows] = await Promise.all([
    obtenerCatalogoDocumentosActivosAdmin(env, admin),
    env.DB.prepare(`
      SELECT id, COALESCE(NULLIF(TRIM(titulo_publico), ''), NULLIF(TRIM(nombre), ''), 'Actividad') AS nombre
      FROM actividades
      WHERE admin_id = ?
        AND activo = 1
      ORDER BY id DESC
    `).bind(admin).all(),
    env.DB.prepare(`
      SELECT nombre_documento, version_documental, estado
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
    `).bind(docId).all()
  ]);

  const actividades = (actividadesRows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    nombre: limpiarTexto(row.nombre || "Actividad")
  })).filter((row) => row.id > 0);

  if (!actividades.length) {
    return {
      total_activas: 0,
      solicitables_total: 0,
      bloqueadas_total: 0,
      puede_todas: false,
      solicitables: [],
      bloqueadas: []
    };
  }

  const configuraciones = await obtenerConfiguracionDocumentalPorActividades(
    env,
    actividades.map((item) => item.id)
  );

  const archivos = archivosRows?.results || [];
  const archivosPorNombre = new Map(
    archivos.map((item) => [limpiarTexto(item.nombre_documento).toUpperCase(), item])
  );

  const solicitables = [];
  const bloqueadas = [];
  for (const actividad of actividades) {
    const config = configuraciones.get(actividad.id) || { modo: "HEREDADA", documentos: [] };
    const docsExigibles = resolverDocumentosExigiblesActividad(catalogo, config);
    const cumple = docsExigibles.every((doc) => {
      const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre).toUpperCase()) || null;
      return documentoCumple(doc, entrega);
    });
    if (cumple) solicitables.push(actividad.nombre);
    else bloqueadas.push(actividad.nombre);
  }

  return {
    total_activas: actividades.length,
    solicitables_total: solicitables.length,
    bloqueadas_total: bloqueadas.length,
    puede_todas: actividades.length > 0 && solicitables.length === actividades.length,
    solicitables,
    bloqueadas
  };
}
