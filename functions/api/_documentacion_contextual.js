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
    SELECT DISTINCT cad.id
    FROM centro_admin_documentacion cad
    WHERE cad.centro_usuario_id = ?
      AND cad.reserva_id IS NULL
      AND (
        cad.actividad_id = ?
        OR EXISTS (
          SELECT 1
          FROM centro_admin_documentacion_archivos a
          WHERE a.documentacion_id = cad.id
            AND a.actividad_id = ?
            AND a.reserva_id IS NULL
            AND COALESCE(a.activo, 1) = 1
        )
      )
  `).bind(usuario, actividad, actividad).all();

  const ids = (expedientes?.results || [])
    .map((row) => idPositivo(row.id))
    .filter(Boolean);

  if (!ids.length) {
    return { ok: true, actualizados: 0 };
  }

  const placeholders = ids.map(() => "?").join(", ");

  await env.DB.prepare(`
    UPDATE centro_admin_documentacion
    SET reserva_id = CASE
          WHEN actividad_id = ? OR actividad_id IS NOT NULL THEN ?
          ELSE reserva_id
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id IN (${placeholders})
  `).bind(actividad, reserva, ...ids).run();

  await env.DB.prepare(`
    UPDATE centro_admin_documentacion_archivos
    SET reserva_id = ?,
        actividad_id = COALESCE(actividad_id, ?)
    WHERE documentacion_id IN (${placeholders})
      AND (actividad_id = ? OR actividad_id IS NULL)
      AND reserva_id IS NULL
  `).bind(reserva, actividad, ...ids, actividad).run();

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

  const contextoReserva = await env.DB.prepare(`
    SELECT usuario_id, actividad_id
    FROM reservas
    WHERE id = ?
    LIMIT 1
  `).bind(reserva).first();

  const usuario = idPositivo(contextoReserva?.usuario_id);
  const actividad = idPositivo(contextoReserva?.actividad_id);

  const expedientes = await env.DB.prepare(`
    SELECT id
    FROM centro_admin_documentacion
    WHERE reserva_id = ?
      OR (
        ? IS NOT NULL
        AND ? IS NOT NULL
        AND centro_usuario_id = ?
        AND actividad_id = ?
        AND reserva_id IS NULL
      )
  `).bind(
    reserva,
    usuario,
    actividad,
    usuario,
    actividad
  ).all();

  const idsExpediente = (expedientes?.results || [])
    .map((row) => idPositivo(row.id))
    .filter(Boolean);

  const archivosContextuales = await env.DB.prepare(`
    SELECT id, documentacion_id, archivo_url
    FROM centro_admin_documentacion_archivos
    WHERE reserva_id = ?
      OR (
        ? IS NOT NULL
        AND ? IS NOT NULL
        AND actividad_id = ?
        AND reserva_id IS NULL
        AND documentacion_id IN (
          SELECT id
          FROM centro_admin_documentacion
          WHERE centro_usuario_id = ?
        )
      )
  `).bind(
    reserva,
    usuario,
    actividad,
    actividad,
    usuario
  ).all();

  const archivosRows = archivosContextuales?.results || [];
  const idsDesdeArchivos = archivosRows
    .map((row) => idPositivo(row.documentacion_id))
    .filter(Boolean);
  const ids = Array.from(new Set([...idsExpediente, ...idsDesdeArchivos]));

  if (!ids.length && !archivosRows.length) {
    return { ok: true, expedientes: 0, archivos: 0 };
  }

  const placeholdersArchivos = archivosRows.map(() => "?").join(", ");
  const placeholdersExpedientes = ids.map(() => "?").join(", ");
  const archivosExistentes = archivosRows.length
    ? archivosRows
    : (await env.DB.prepare(`
        SELECT archivo_url
        FROM centro_admin_documentacion_archivos
        WHERE documentacion_id IN (${placeholdersExpedientes})
      `).bind(...ids).all())?.results || [];
  const archivosFisicos = await borrarArchivosFisicos(env, archivosExistentes);

  let archivos = { meta: { changes: 0 } };
  if (archivosRows.length) {
    archivos = await env.DB.prepare(`
      DELETE FROM centro_admin_documentacion_archivos
      WHERE id IN (${placeholdersArchivos})
    `).bind(...archivosRows.map((row) => row.id)).run();
  } else if (ids.length) {
    archivos = await env.DB.prepare(`
      DELETE FROM centro_admin_documentacion_archivos
      WHERE documentacion_id IN (${placeholdersExpedientes})
    `).bind(...ids).run();
  }

  const expedientesContextuales = idsExpediente.filter((id) => ids.includes(id));
  const placeholdersContextuales = expedientesContextuales.map(() => "?").join(", ");
  const expedientesEliminados = expedientesContextuales.length
    ? await env.DB.prepare(`
        DELETE FROM centro_admin_documentacion
        WHERE id IN (${placeholdersContextuales})
      `).bind(...expedientesContextuales).run()
    : { meta: { changes: 0 } };

  const expedientesGlobales = ids.filter((id) => !expedientesContextuales.includes(id));
  if (expedientesGlobales.length) {
    const placeholdersGlobales = expedientesGlobales.map(() => "?").join(", ");
    await env.DB.prepare(`
      UPDATE centro_admin_documentacion
      SET estado = 'NO_INICIADO',
          version_aportada = 0,
          fecha_ultima_entrega = NULL,
          fecha_validacion = NULL,
          validado_por_admin_id = NULL,
          observaciones_admin = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholdersGlobales})
        AND NOT EXISTS (
          SELECT 1
          FROM centro_admin_documentacion_archivos a
          WHERE a.documentacion_id = centro_admin_documentacion.id
            AND COALESCE(a.activo, 1) = 1
        )
    `).bind(...expedientesGlobales).run();
  }

  return {
    ok: true,
    expedientes: Number(expedientesEliminados?.meta?.changes || 0),
    archivos: Number(archivos?.meta?.changes || 0),
    archivos_fisicos: archivosFisicos
  };
}
