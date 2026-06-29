function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarRol(valor) {
  return limpiarTexto(valor).toUpperCase();
}

export async function asegurarTablaPropietariosDocumentalesAdmin(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_documentacion_propietarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      propietario_id INTEGER NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (admin_id, propietario_id)
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_admin_documentacion_propietarios_admin
    ON admin_documentacion_propietarios (admin_id, activo)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_admin_documentacion_propietarios_propietario
    ON admin_documentacion_propietarios (propietario_id, activo)
  `).run();
}

export async function listarPropietariosDocumentalesDisponibles(env) {
  const rows = await env.DB.prepare(`
    SELECT
      u.id,
      u.rol,
      u.nombre,
      u.nombre_publico,
      u.email,
      u.localidad,
      COUNT(d.id) AS total_documentos
    FROM usuarios u
    INNER JOIN admin_documentos_comunes d
      ON d.admin_id = u.id
      AND COALESCE(d.activo, 1) = 1
    WHERE UPPER(COALESCE(u.rol, '')) IN ('ADMIN', 'SECRETARIA')
      AND COALESCE(u.activo, 1) = 1
    GROUP BY u.id, u.rol, u.nombre, u.nombre_publico, u.email, u.localidad
    ORDER BY
      CASE
        WHEN u.nombre_publico IS NOT NULL AND TRIM(u.nombre_publico) <> '' THEN TRIM(u.nombre_publico)
        WHEN u.nombre IS NOT NULL AND TRIM(u.nombre) <> '' THEN TRIM(u.nombre)
        ELSE TRIM(u.email)
      END COLLATE NOCASE ASC,
      u.id ASC
  `).all();

  return (rows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    rol: normalizarRol(row.rol),
    nombre: limpiarTexto(row.nombre),
    nombre_publico: limpiarTexto(row.nombre_publico),
    email: limpiarTexto(row.email),
    localidad: limpiarTexto(row.localidad),
    total_documentos: Number(row.total_documentos || 0)
  })).filter((row) => row.id > 0);
}

export async function listarPropietariosDocumentalesVinculados(env, adminId) {
  await asegurarTablaPropietariosDocumentalesAdmin(env);

  const admin = Number(adminId || 0);
  if (!(admin > 0)) return [];

  const rows = await env.DB.prepare(`
    SELECT
      u.id,
      u.rol,
      u.nombre,
      u.nombre_publico,
      u.email,
      u.localidad,
      COUNT(d.id) AS total_documentos
    FROM admin_documentacion_propietarios v
    INNER JOIN usuarios u ON u.id = v.propietario_id
    INNER JOIN admin_documentos_comunes d
      ON d.admin_id = u.id
      AND COALESCE(d.activo, 1) = 1
    WHERE v.admin_id = ?
      AND COALESCE(v.activo, 1) = 1
      AND UPPER(COALESCE(u.rol, '')) IN ('ADMIN', 'SECRETARIA')
      AND COALESCE(u.activo, 1) = 1
    GROUP BY u.id, u.rol, u.nombre, u.nombre_publico, u.email, u.localidad
    ORDER BY v.id ASC
  `).bind(admin).all();

  return (rows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    rol: normalizarRol(row.rol),
    nombre: limpiarTexto(row.nombre),
    nombre_publico: limpiarTexto(row.nombre_publico),
    email: limpiarTexto(row.email),
    localidad: limpiarTexto(row.localidad),
    total_documentos: Number(row.total_documentos || 0)
  })).filter((row) => row.id > 0);
}

export async function guardarPropietariosDocumentalesVinculados(env, adminId, propietariosEntrada = []) {
  await asegurarTablaPropietariosDocumentalesAdmin(env);

  const admin = Number(adminId || 0);
  if (!(admin > 0)) return [];

  const permitidos = new Set((await listarPropietariosDocumentalesDisponibles(env)).map((item) => item.id));
  const propietarios = Array.from(
    new Set((Array.isArray(propietariosEntrada) ? propietariosEntrada : [])
      .map((id) => Number(id || 0))
      .filter((id) => id > 0 && permitidos.has(id)))
  );

  if (!propietarios.includes(admin) && permitidos.has(admin)) {
    propietarios.unshift(admin);
  }

  await env.DB.prepare(`
    UPDATE admin_documentacion_propietarios
    SET activo = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE admin_id = ?
  `).bind(admin).run();

  for (let i = 0; i < propietarios.length; i += 1) {
    await env.DB.prepare(`
      INSERT INTO admin_documentacion_propietarios (
        admin_id,
        propietario_id,
        activo,
        updated_at
      )
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(admin_id, propietario_id) DO UPDATE SET
        activo = 1,
        updated_at = CURRENT_TIMESTAMP
    `).bind(admin, propietarios[i]).run();
  }

  return listarPropietariosDocumentalesVinculados(env, admin);
}

export async function obtenerCatalogoDocumentosPropietarios(env, propietarios = []) {
  const ids = Array.from(
    new Set((Array.isArray(propietarios) ? propietarios : [])
      .map((item) => Number(typeof item === "object" ? item?.id : item || 0))
      .filter((id) => id > 0))
  );

  if (!ids.length) return [];

  const placeholders = ids.map(() => "?").join(", ");
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
    INNER JOIN usuarios u ON u.id = d.admin_id
    WHERE d.admin_id IN (${placeholders})
      AND COALESCE(d.activo, 1) = 1
      AND UPPER(COALESCE(u.rol, '')) IN ('ADMIN', 'SECRETARIA')
      AND COALESCE(u.activo, 1) = 1
    ORDER BY propietario_nombre COLLATE NOCASE ASC, d.orden ASC, d.id ASC
  `).bind(...ids).all();

  return (rows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    propietario_id: Number(row.admin_id || 0),
    propietario_rol: normalizarRol(row.propietario_rol),
    propietario_nombre: limpiarTexto(row.propietario_nombre),
    nombre: limpiarTexto(row.nombre),
    descripcion: limpiarTexto(row.descripcion),
    archivo_url: row.archivo_url || "",
    orden: Number(row.orden || 0),
    version_documental: Number(row.version_documental || 0),
    fecha_actualizacion: row.fecha_actualizacion || ""
  })).filter((row) => row.id > 0 && row.nombre);
}

export async function obtenerCatalogoDocumentalVinculadoAdmin(env, adminId, catalogoFallback = []) {
  const vinculados = await listarPropietariosDocumentalesVinculados(env, adminId);
  if (vinculados.length) {
    return obtenerCatalogoDocumentosPropietarios(env, vinculados);
  }
  const catalogoPropio = await obtenerCatalogoDocumentosPropietarios(env, [adminId]);
  if (catalogoPropio.length) {
    return catalogoPropio;
  }
  return Array.isArray(catalogoFallback) ? catalogoFallback : [];
}
