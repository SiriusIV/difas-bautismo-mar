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

export function normalizarIdsDocumentosActividad(lista) {
  const vistos = new Set();
  const salida = [];

  for (const item of Array.isArray(lista) ? lista : []) {
    const id = Number(typeof item === "object" ? item?.id || item?.documento_id : item || 0);
    if (!(id > 0) || vistos.has(id)) continue;
    vistos.add(id);
    salida.push(id);
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

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS actividad_documentos_obligatorios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actividad_id INTEGER NOT NULL,
      documento_id INTEGER NOT NULL,
      propietario_id INTEGER NOT NULL,
      propietario_rol TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (actividad_id, documento_id)
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_actividad_documentos_obligatorios_actividad
    ON actividad_documentos_obligatorios (actividad_id, activo, orden)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_actividad_documentos_obligatorios_propietario
    ON actividad_documentos_obligatorios (propietario_id, activo)
  `).run();
}

export async function obtenerCatalogoDocumentosActivosAdmin(env, adminId) {
  const propietarioDocumentalId = Number(adminId || 0);
  if (!(propietarioDocumentalId > 0)) return [];

  const rows = await env.DB.prepare(`
    SELECT
      d.id,
      d.admin_id,
      d.nombre,
      d.descripcion,
      d.archivo_url,
      d.orden,
      d.version_documental,
      d.fecha_actualizacion,
      u.rol AS propietario_rol,
      COALESCE(NULLIF(TRIM(u.nombre_publico), ''), NULLIF(TRIM(u.nombre), ''), NULLIF(TRIM(u.email), ''), '') AS propietario_nombre
    FROM admin_documentos_comunes d
    LEFT JOIN usuarios u ON u.id = d.admin_id
    WHERE d.admin_id = ?
      AND d.activo = 1
    ORDER BY d.orden ASC, d.id ASC
  `).bind(propietarioDocumentalId).all();

  return (rows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    nombre: limpiarTexto(row.nombre),
    descripcion: limpiarTexto(row.descripcion),
    archivo_url: row.archivo_url || "",
    orden: Number(row.orden || 0),
    version_documental: Number(row.version_documental || 0)
    ,
    fecha_actualizacion: row.fecha_actualizacion || "",
    propietario_id: Number(row.admin_id || 0),
    propietario_rol: limpiarTexto(row.propietario_rol),
    propietario_nombre: limpiarTexto(row.propietario_nombre)
  })).filter((row) => row.nombre);
}

function obtenerDocumentosCatalogoPorNombres(catalogo = [], nombresEntrada = [], idsEntrada = []) {
  const nombres = normalizarNombresDocumentosActividad(nombresEntrada);
  const ids = normalizarIdsDocumentosActividad(idsEntrada);
  const mapaNombres = new Map();
  const mapaIds = new Map();
  for (const doc of Array.isArray(catalogo) ? catalogo : []) {
    const nombre = limpiarTexto(doc?.nombre);
    const id = Number(doc?.id || 0);
    if (!nombre || !(id > 0)) continue;
    mapaIds.set(id, doc);
    const key = nombre.toUpperCase();
    if (!mapaNombres.has(key)) {
      mapaNombres.set(key, doc);
    }
  }

  const salida = [];
  const vistos = new Set();
  for (const id of ids) {
    const doc = mapaIds.get(id);
    if (!doc || vistos.has(Number(doc.id || 0))) continue;
    vistos.add(Number(doc.id || 0));
    salida.push(doc);
  }
  for (const nombre of nombres) {
    const doc = mapaNombres.get(nombre.toUpperCase());
    if (!doc || vistos.has(Number(doc.id || 0))) continue;
    vistos.add(Number(doc.id || 0));
    salida.push(doc);
  }
  return salida;
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

  const docsIdsRows = await env.DB.prepare(`
    SELECT
      ado.documento_id,
      ado.propietario_id,
      ado.propietario_rol,
      d.nombre
    FROM actividad_documentos_obligatorios ado
    INNER JOIN admin_documentos_comunes d ON d.id = ado.documento_id
    WHERE ado.actividad_id = ?
      AND COALESCE(ado.activo, 1) = 1
    ORDER BY ado.orden ASC, ado.id ASC
  `).bind(id).all();

  const documentosRelacionados = docsIdsRows?.results || [];

  return {
    modo: normalizarModoDocumentacionActividad(configRow?.modo),
    documentos: normalizarNombresDocumentosActividad(
      documentosRelacionados.length
        ? documentosRelacionados.map((row) => row.nombre)
        : (docsRows?.results || []).map((row) => row.nombre_documento)
    ),
    documento_ids: documentosRelacionados.map((row) => Number(row.documento_id || 0)).filter((documentoId) => documentoId > 0),
    propietarios: documentosRelacionados.map((row) => ({
      documento_id: Number(row.documento_id || 0),
      propietario_id: Number(row.propietario_id || 0),
      propietario_rol: limpiarTexto(row.propietario_rol)
    })).filter((row) => row.documento_id > 0 && row.propietario_id > 0)
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

  const docsIdsResult = await env.DB.prepare(`
    SELECT
      ado.actividad_id,
      ado.documento_id,
      ado.propietario_id,
      ado.propietario_rol,
      d.nombre
    FROM actividad_documentos_obligatorios ado
    INNER JOIN admin_documentos_comunes d ON d.id = ado.documento_id
    WHERE ado.actividad_id IN (${placeholders})
      AND COALESCE(ado.activo, 1) = 1
    ORDER BY ado.actividad_id ASC, ado.orden ASC, ado.id ASC
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

  for (const row of docsIdsResult?.results || []) {
    const actividadId = Number(row.actividad_id || 0);
    if (!mapa.has(actividadId)) {
      mapa.set(actividadId, {
        modo: "HEREDADA",
        documentos: []
      });
    }
    const actual = mapa.get(actividadId);
    if (!Array.isArray(actual.documento_ids)) actual.documento_ids = [];
    if (!Array.isArray(actual.propietarios)) actual.propietarios = [];
    actual.documento_ids.push(Number(row.documento_id || 0));
    actual.propietarios.push({
      documento_id: Number(row.documento_id || 0),
      propietario_id: Number(row.propietario_id || 0),
      propietario_rol: limpiarTexto(row.propietario_rol)
    });
    actual.documentos.push(row.nombre);
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
    actual.documento_ids = Array.from(
      new Set((actual.documento_ids || []).map((documentoId) => Number(documentoId || 0)).filter((documentoId) => documentoId > 0))
    );
    actual.propietarios = (actual.propietarios || []).filter((row) =>
      Number(row?.documento_id || 0) > 0 && Number(row?.propietario_id || 0) > 0
    );
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
  const idsPermitidos = new Set(
    (Array.isArray(config.documento_ids) ? config.documento_ids : [])
      .map((documentoId) => Number(documentoId || 0))
      .filter((documentoId) => documentoId > 0)
  );

  if (!nombresPermitidos.size && !idsPermitidos.size) {
    return [];
  }

  return docs.filter((doc) =>
    idsPermitidos.has(Number(doc.id || 0)) ||
    nombresPermitidos.has(limpiarTexto(doc.nombre).toUpperCase())
  );
}

export function construirResumenDocumentacionActividad(catalogo = [], configuracion = null) {
  const config = configuracion || { modo: "HEREDADA", documentos: [] };
  const documentosConfigurados = normalizarNombresDocumentosActividad(config.documentos);
  const documentosExigibles = resolverDocumentosExigiblesActividad(catalogo, config);

  return {
    modo: normalizarModoDocumentacionActividad(config.modo),
    documentos_configurados: documentosConfigurados,
    documento_ids_configurados: normalizarIdsDocumentosActividad(config.documento_ids || []),
    documentos_exigidos: documentosExigibles.map((doc) => ({
      id: Number(doc.id || 0),
      nombre: limpiarTexto(doc.nombre),
      descripcion: limpiarTexto(doc.descripcion),
      orden: Number(doc.orden || 0),
      version_documental: Number(doc.version_documental || 0),
      propietario_id: Number(doc.propietario_id || doc.admin_id || 0),
      propietario_rol: limpiarTexto(doc.propietario_rol),
      propietario_nombre: limpiarTexto(doc.propietario_nombre)
    })),
    requiere_documentacion: documentosExigibles.length > 0
  };
}

export async function guardarConfiguracionDocumentalActividad(env, actividadId, modoEntrada, nombresEntrada, catalogoDocumentos = [], idsEntrada = []) {
  await asegurarTablasDocumentacionActividad(env);

  const id = Number(actividadId || 0);
  if (!(id > 0)) return;

  const modo = normalizarModoDocumentacionActividad(modoEntrada);
  const ids = normalizarIdsDocumentosActividad(idsEntrada);
  const documentosSeleccionados = obtenerDocumentosCatalogoPorNombres(catalogoDocumentos, nombresEntrada, ids);
  const nombres = documentosSeleccionados.length
    ? normalizarNombresDocumentosActividad(documentosSeleccionados.map((doc) => doc.nombre))
    : normalizarNombresDocumentosActividad(nombresEntrada);

  await env.DB.prepare(`
    DELETE FROM actividad_documentacion_documentos
    WHERE actividad_id = ?
  `).bind(id).run();

  await env.DB.prepare(`
    DELETE FROM actividad_documentos_obligatorios
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
      INSERT OR IGNORE INTO actividad_documentacion_documentos (
        actividad_id,
        nombre_documento,
        orden
      )
      VALUES (?, ?, ?)
    `).bind(id, nombres[i], i + 1).run();
  }

  for (let i = 0; i < documentosSeleccionados.length; i += 1) {
    const documento = documentosSeleccionados[i];
    const documentoId = Number(documento?.id || 0);
    const propietarioId = Number(documento?.propietario_id || documento?.admin_id || 0);
    if (!(documentoId > 0) || !(propietarioId > 0)) continue;
    await env.DB.prepare(`
      INSERT INTO actividad_documentos_obligatorios (
        actividad_id,
        documento_id,
        propietario_id,
        propietario_rol,
        activo,
        orden,
        updated_at
      )
      VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(actividad_id, documento_id) DO UPDATE SET
        propietario_id = excluded.propietario_id,
        propietario_rol = excluded.propietario_rol,
        activo = 1,
        orden = excluded.orden,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      id,
      documentoId,
      propietarioId,
      limpiarTexto(documento?.propietario_rol),
      i + 1
    ).run();
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
    DELETE FROM actividad_documentos_obligatorios
    WHERE actividad_id = ?
  `).bind(id).run();

  await env.DB.prepare(`
    DELETE FROM actividad_documentacion_config
    WHERE actividad_id = ?
  `).bind(id).run();
}

export async function depurarConfiguracionDocumentalActividadesAdmin(env, adminId, catalogoDocumentos = []) {
  await asegurarTablasDocumentacionActividad(env);

  const admin = Number(adminId || 0);
  if (!(admin > 0)) {
    return {
      actividades_revisadas: 0,
      actividades_actualizadas: 0
    };
  }

  const permitidos = new Set(
    normalizarNombresDocumentosActividad((catalogoDocumentos || []).map((doc) => doc?.nombre || doc))
      .map((nombre) => nombre.toUpperCase())
  );
  const idsPermitidos = new Set(
    (Array.isArray(catalogoDocumentos) ? catalogoDocumentos : [])
      .map((doc) => Number(doc?.id || 0))
      .filter((documentoId) => documentoId > 0)
  );

  const actividades = await env.DB.prepare(`
    SELECT
      c.actividad_id,
      c.modo
    FROM actividad_documentacion_config c
    INNER JOIN actividades a ON a.id = c.actividad_id
    WHERE a.admin_id = ?
      AND UPPER(TRIM(COALESCE(c.modo, 'HEREDADA'))) = 'PERSONALIZADA'
    ORDER BY c.actividad_id ASC
  `).bind(admin).all();

  let actualizadas = 0;
  const filas = actividades?.results || [];

  for (const fila of filas) {
    const actividadId = Number(fila?.actividad_id || 0);
    if (!(actividadId > 0)) continue;

    const config = await leerConfiguracionDocumentalActividad(env, actividadId);
    const filtrados = normalizarNombresDocumentosActividad(config.documentos).filter((nombre) =>
      permitidos.has(String(nombre || "").trim().toUpperCase())
    );
    const idsOriginales = normalizarIdsDocumentosActividad(config.documento_ids || []);
    const idsFiltrados = idsOriginales.filter((documentoId) => idsPermitidos.has(documentoId));

    const original = normalizarNombresDocumentosActividad(config.documentos);
    const igualLongitud = original.length === filtrados.length && idsOriginales.length === idsFiltrados.length;
    const igualContenido = igualLongitud &&
      original.every((nombre, indice) => nombre === filtrados[indice]) &&
      idsOriginales.every((documentoId, indice) => documentoId === idsFiltrados[indice]);
    if (igualContenido) continue;

    await guardarConfiguracionDocumentalActividad(env, actividadId, "PERSONALIZADA", filtrados, catalogoDocumentos, idsFiltrados);
    actualizadas += 1;
  }

  return {
    actividades_revisadas: filas.length,
    actividades_actualizadas: actualizadas
  };
}
