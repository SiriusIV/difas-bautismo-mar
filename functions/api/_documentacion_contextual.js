function idPositivo(valor) {
  const numero = Number(valor || 0);
  return Number.isInteger(numero) && numero > 0 ? numero : null;
}

async function agregarColumnaSiFalta(env, tabla, columna, definicion) {
  try {
    await env.DB.prepare(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`).run();
  } catch (error) {
    const mensaje = String(error?.message || error || "").toLowerCase();
    if (!mensaje.includes("duplicate column") && !mensaje.includes("already exists")) {
      throw error;
    }
  }
}

export async function asegurarColumnasContextoDocumental(env) {
  await agregarColumnaSiFalta(env, "centro_admin_documentacion", "actividad_id", "INTEGER");
  await agregarColumnaSiFalta(env, "centro_admin_documentacion", "reserva_id", "INTEGER");
  await agregarColumnaSiFalta(env, "centro_admin_documentacion_archivos", "actividad_id", "INTEGER");
  await agregarColumnaSiFalta(env, "centro_admin_documentacion_archivos", "reserva_id", "INTEGER");

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_cad_contexto_actividad
    ON centro_admin_documentacion (centro_usuario_id, admin_id, actividad_id, reserva_id)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_cada_contexto_reserva
    ON centro_admin_documentacion_archivos (reserva_id, actividad_id, activo)
  `).run();
}

export function normalizarContextoDocumental({ actividadId = null, reservaId = null } = {}) {
  return {
    actividadId: idPositivo(actividadId),
    reservaId: idPositivo(reservaId)
  };
}

export function construirCondicionContextoDocumental(contexto = {}, alias = "") {
  const prefijo = alias ? `${alias}.` : "";
  const { actividadId, reservaId } = normalizarContextoDocumental(contexto);
  const condiciones = [];
  const valores = [];

  if (actividadId) {
    condiciones.push(`${prefijo}actividad_id = ?`);
    valores.push(actividadId);
  } else {
    condiciones.push(`${prefijo}actividad_id IS NULL`);
  }

  if (reservaId) {
    condiciones.push(`${prefijo}reserva_id = ?`);
    valores.push(reservaId);
  } else {
    condiciones.push(`${prefijo}reserva_id IS NULL`);
  }

  return {
    sql: condiciones.join(" AND "),
    valores,
    actividadId,
    reservaId
  };
}

export async function vincularDocumentacionPendienteAReserva(env, {
  usuarioId,
  actividadId,
  reservaId
} = {}) {
  const usuario = idPositivo(usuarioId);
  const actividad = idPositivo(actividadId);
  const reserva = idPositivo(reservaId);

  if (!usuario || !actividad || !reserva) {
    return { ok: false, actualizados: 0 };
  }

  await asegurarColumnasContextoDocumental(env);

  const expedientes = await env.DB.prepare(`
    SELECT id
    FROM centro_admin_documentacion
    WHERE centro_usuario_id = ?
      AND actividad_id = ?
      AND reserva_id IS NULL
  `).bind(usuario, actividad).all();

  const ids = (expedientes?.results || [])
    .map((row) => idPositivo(row.id))
    .filter(Boolean);

  if (!ids.length) {
    return { ok: true, actualizados: 0 };
  }

  const placeholders = ids.map(() => "?").join(", ");

  await env.DB.prepare(`
    UPDATE centro_admin_documentacion
    SET reserva_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id IN (${placeholders})
  `).bind(reserva, ...ids).run();

  await env.DB.prepare(`
    UPDATE centro_admin_documentacion_archivos
    SET reserva_id = ?
    WHERE documentacion_id IN (${placeholders})
  `).bind(reserva, ...ids).run();

  return { ok: true, actualizados: ids.length };
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function extraerKeyDesdeArchivoUrl(archivoUrl) {
  const texto = limpiarTexto(archivoUrl);
  if (!texto) return null;

  try {
    const base = texto.startsWith("http://") || texto.startsWith("https://")
      ? texto
      : `https://local${texto.startsWith("/") ? "" : "/"}${texto}`;
    const url = new URL(base);
    return limpiarTexto(url.searchParams.get("key")) || null;
  } catch {
    return null;
  }
}

async function borrarArchivosFisicos(env, archivos = []) {
  if (!env.DOCS_BUCKET) return 0;
  let borrados = 0;
  for (const archivo of archivos) {
    const key = extraerKeyDesdeArchivoUrl(archivo?.archivo_url);
    if (!key) continue;
    try {
      await env.DOCS_BUCKET.delete(key);
      borrados += 1;
    } catch {
      // La eliminación lógica en base de datos no debe quedar bloqueada por un fallo puntual del bucket.
    }
  }
  return borrados;
}

export async function eliminarDocumentacionDeReserva(env, reservaId) {
  const reserva = idPositivo(reservaId);
  if (!reserva) return { ok: false, expedientes: 0, archivos: 0 };

  await asegurarColumnasContextoDocumental(env);

  const expedientes = await env.DB.prepare(`
    SELECT id
    FROM centro_admin_documentacion
    WHERE reserva_id = ?
  `).bind(reserva).all();

  const ids = (expedientes?.results || [])
    .map((row) => idPositivo(row.id))
    .filter(Boolean);

  if (!ids.length) {
    return { ok: true, expedientes: 0, archivos: 0 };
  }

  const placeholders = ids.map(() => "?").join(", ");
  const archivosExistentes = await env.DB.prepare(`
    SELECT archivo_url
    FROM centro_admin_documentacion_archivos
    WHERE documentacion_id IN (${placeholders})
  `).bind(...ids).all();
  const archivosFisicos = await borrarArchivosFisicos(env, archivosExistentes?.results || []);

  const archivos = await env.DB.prepare(`
    DELETE FROM centro_admin_documentacion_archivos
    WHERE documentacion_id IN (${placeholders})
  `).bind(...ids).run();

  const expedientesEliminados = await env.DB.prepare(`
    DELETE FROM centro_admin_documentacion
    WHERE id IN (${placeholders})
  `).bind(...ids).run();

  return {
    ok: true,
    expedientes: Number(expedientesEliminados?.meta?.changes || 0),
    archivos: Number(archivos?.meta?.changes || 0),
    archivos_fisicos: archivosFisicos
  };
}
