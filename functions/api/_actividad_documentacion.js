import { resolverResponsableDocumental } from "./_documentacion_responsable.js";

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

export function normalizarModoDocumentacionActividad(valor) {
  return String(valor || "").trim().toUpperCase() === "PERSONALIZADA"
    ? "PERSONALIZADA"
    : "HEREDADA";
}

export function normalizarNombresDocumentosActividad(lista) {
  const vistos = new Set();
  const salida = [];

  for (const item of Array.isArray(lista) ? lista : []) {
    const nombre = limpiarTexto(typeof item === "string" ? item : item?.nombre || item?.texto || "");
    if (!nombre) continue;
    const key = nombre.toUpperCase();
    if (vistos.has(key)) continue;
    vistos.add(key);
    salida.push(nombre);
  }

  return salida;
}

export async function asegurarTablasDocumentacionActividad(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS actividad_documentacion_config (
      actividad_id INTEGER PRIMARY KEY,
      modo TEXT NOT NULL DEFAULT 'HEREDADA',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS actividad_documentacion_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actividad_id INTEGER NOT NULL,
      nombre_documento TEXT NOT NULL,
      orden INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  await env.DB.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_actividad_documentacion_documentos_unq
    ON actividad_documentacion_documentos (actividad_id, nombre_documento)
  `).run();
}

async function obtenerPropietarioDocumentalId(env, adminId) {
  const resolucion = await resolverResponsableDocumental(env, adminId);
  if (!resolucion) return null;

  if (String(resolucion.modo || "").toUpperCase() === "SECRETARIA_EXTERNA") {
    return Number(resolucion.responsable?.id || 0) || null;
  }

  return Number(resolucion.admin?.id || 0) || null;
}

export async function obtenerCatalogoDocumentosActivosAdmin(env, adminId) {
  const propietarioDocumentalId = await obtenerPropietarioDocumentalId(env, adminId);
  if (!propietarioDocumentalId) return [];

  const rows = await env.DB.prepare(`
    SELECT
      id,
      admin_id,
      nombre,
      descripcion,
      archivo_url,
      orden,
      version_documental
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND activo = 1
    ORDER BY orden ASC, id ASC
  `).bind(propietarioDocumentalId).all();

  return (rows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    nombre: limpiarTexto(row.nombre),
    descripcion: limpiarTexto(row.descripcion),
    archivo_url: row.archivo_url || "",
    orden: Number(row.orden || 0),
    version_documental: Number(row.version_documental || 0)
  })).filter((row) => row.nombre);
}

export async function leerConfiguracionDocumentalActividad(env, actividadId) {
  await asegurarTablasDocumentacionActividad(env);

  const id = Number(actividadId || 0);
  if (!(id > 0)) {
    return {
      modo: "HEREDADA",
      documentos: []
    };
  }

  const configRow = await env.DB.prepare(`
    SELECT modo
    FROM actividad_documentacion_config
    WHERE actividad_id = ?
    LIMIT 1
  `).bind(id).first();

  const docsRows = await env.DB.prepare(`
    SELECT nombre_documento
    FROM actividad_documentacion_documentos
    WHERE actividad_id = ?
    ORDER BY orden ASC, id ASC
  `).bind(id).all();

  return {
    modo: normalizarModoDocumentacionActividad(configRow?.modo),
    documentos: normalizarNombresDocumentosActividad(
      (docsRows?.results || []).map((row) => row.nombre_documento)
    )
  };
}

export async function obtenerConfiguracionDocumentalPorActividades(env, actividadIds) {
  await asegurarTablasDocumentacionActividad(env);

  const ids = Array.from(
    new Set((actividadIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))
  );

  const mapa = new Map();
  if (!ids.length) return mapa;

  const placeholders = ids.map(() => "?").join(", ");

  const configsResult = await env.DB.prepare(`
    SELECT actividad_id, modo
    FROM actividad_documentacion_config
    WHERE actividad_id IN (${placeholders})
  `).bind(...ids).all();

  for (const row of configsResult?.results || []) {
    mapa.set(Number(row.actividad_id || 0), {
      modo: normalizarModoDocumentacionActividad(row.modo),
      documentos: []
    });
  }

  const docsResult = await env.DB.prepare(`
    SELECT actividad_id, nombre_documento
    FROM actividad_documentacion_documentos
    WHERE actividad_id IN (${placeholders})
    ORDER BY actividad_id ASC, orden ASC, id ASC
  `).bind(...ids).all();

  for (const row of docsResult?.results || []) {
    const actividadId = Number(row.actividad_id || 0);
    if (!mapa.has(actividadId)) {
      mapa.set(actividadId, {
        modo: "HEREDADA",
        documentos: []
      });
    }
    mapa.get(actividadId).documentos.push(row.nombre_documento);
  }

  for (const id of ids) {
    if (!mapa.has(id)) {
      mapa.set(id, {
        modo: "HEREDADA",
        documentos: []
      });
      continue;
    }

    const actual = mapa.get(id);
    actual.documentos = normalizarNombresDocumentosActividad(actual.documentos);
    actual.modo = normalizarModoDocumentacionActividad(actual.modo);
  }

  return mapa;
}

export function resolverDocumentosExigiblesActividad(catalogo = [], configuracion = null) {
  const docs = Array.isArray(catalogo) ? catalogo : [];
  const config = configuracion || { modo: "HEREDADA", documentos: [] };
  const modo = normalizarModoDocumentacionActividad(config.modo);

  if (modo !== "PERSONALIZADA") {
    return docs;
  }

  const nombresPermitidos = new Set(
    normalizarNombresDocumentosActividad(config.documentos).map((nombre) => nombre.toUpperCase())
  );

  if (!nombresPermitidos.size) {
    return [];
  }

  return docs.filter((doc) => nombresPermitidos.has(limpiarTexto(doc.nombre).toUpperCase()));
}

export function construirResumenDocumentacionActividad(catalogo = [], configuracion = null) {
  const config = configuracion || { modo: "HEREDADA", documentos: [] };
  const documentosConfigurados = normalizarNombresDocumentosActividad(config.documentos);
  const documentosExigibles = resolverDocumentosExigiblesActividad(catalogo, config);

  return {
    modo: normalizarModoDocumentacionActividad(config.modo),
    documentos_configurados: documentosConfigurados,
    documentos_exigidos: documentosExigibles.map((doc) => ({
      id: Number(doc.id || 0),
      nombre: limpiarTexto(doc.nombre),
      descripcion: limpiarTexto(doc.descripcion),
      orden: Number(doc.orden || 0),
      version_documental: Number(doc.version_documental || 0)
    })),
    requiere_documentacion: documentosExigibles.length > 0
  };
}

export async function guardarConfiguracionDocumentalActividad(env, actividadId, modoEntrada, nombresEntrada) {
  await asegurarTablasDocumentacionActividad(env);

  const id = Number(actividadId || 0);
  if (!(id > 0)) return;

  const modo = normalizarModoDocumentacionActividad(modoEntrada);
  const nombres = normalizarNombresDocumentosActividad(nombresEntrada);

  await env.DB.prepare(`
    DELETE FROM actividad_documentacion_documentos
    WHERE actividad_id = ?
  `).bind(id).run();

  if (modo === "HEREDADA") {
    await env.DB.prepare(`
      DELETE FROM actividad_documentacion_config
      WHERE actividad_id = ?
    `).bind(id).run();
    return;
  }

  await env.DB.prepare(`
    INSERT INTO actividad_documentacion_config (
      actividad_id,
      modo,
      updated_at
    )
    VALUES (?, 'PERSONALIZADA', CURRENT_TIMESTAMP)
    ON CONFLICT(actividad_id) DO UPDATE SET
      modo = excluded.modo,
      updated_at = CURRENT_TIMESTAMP
  `).bind(id).run();

  for (let i = 0; i < nombres.length; i += 1) {
    await env.DB.prepare(`
      INSERT INTO actividad_documentacion_documentos (
        actividad_id,
        nombre_documento,
        orden
      )
      VALUES (?, ?, ?)
    `).bind(id, nombres[i], i + 1).run();
  }
}

export async function borrarConfiguracionDocumentalActividad(env, actividadId) {
  await asegurarTablasDocumentacionActividad(env);

  const id = Number(actividadId || 0);
  if (!(id > 0)) return;

  await env.DB.prepare(`
    DELETE FROM actividad_documentacion_documentos
    WHERE actividad_id = ?
  `).bind(id).run();

  await env.DB.prepare(`
    DELETE FROM actividad_documentacion_config
    WHERE actividad_id = ?
  `).bind(id).run();
}
