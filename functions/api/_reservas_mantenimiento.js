function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function estadoIncluidoEnHistorico(estado) {
  return ["CONFIRMADA"].includes(String(estado || "").toUpperCase());
}

async function asegurarTablaHistorico(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS reservas_estadisticas_historico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reserva_id INTEGER NOT NULL UNIQUE,
      actividad_id INTEGER,
      actividad_nombre TEXT,
      admin_id INTEGER,
      admin_nombre TEXT,
      fecha_referencia TEXT,
      anio INTEGER,
      estado_final TEXT,
      asistentes_total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function rechazarReservasSuspendidasVencidas(env) {
  const rows = await env.DB.prepare(`
    SELECT r.id
    FROM reservas r
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    WHERE UPPER(TRIM(COALESCE(r.estado, ''))) = 'SUSPENDIDA'
      AND datetime(
        COALESCE(
          CASE
            WHEN f.fecha IS NOT NULL AND f.hora_inicio IS NOT NULL
              THEN f.fecha || ' ' || f.hora_inicio
            ELSE NULL
          END,
          CASE
            WHEN a.fecha_inicio IS NOT NULL
              THEN a.fecha_inicio || ' 00:00:00'
            ELSE NULL
          END
        )
      ) <= datetime('now')
  `).all();

  const ids = (rows?.results || []).map((row) => Number(row.id || 0)).filter(Boolean);
  if (!ids.length) return 0;

  const sentencias = ids.map((id) => env.DB.prepare(`
    UPDATE reservas
    SET estado = 'RECHAZADA',
        fecha_modificacion = datetime('now')
    WHERE id = ?
  `).bind(id));

  await env.DB.batch(sentencias);
  return ids.length;
}

async function obtenerReservasFinalizadas(env) {
  const rows = await env.DB.prepare(`
    SELECT
      r.id,
      r.estado,
      r.actividad_id,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      a.admin_id,
      COALESCE(u.nombre_publico, u.nombre, u.email, 'Administrador') AS admin_nombre,
      COALESCE(f.fecha, a.fecha_fin) AS fecha_referencia,
      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_total
    FROM reservas r
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios u
      ON u.id = a.admin_id
    WHERE datetime(
      COALESCE(
        CASE
          WHEN f.fecha IS NOT NULL AND f.hora_fin IS NOT NULL
            THEN f.fecha || ' ' || f.hora_fin
          ELSE NULL
        END,
        CASE
          WHEN a.fecha_fin IS NOT NULL
            THEN a.fecha_fin || ' 23:59:59'
          ELSE NULL
        END
      )
    ) <= datetime('now')
  `).all();

  return rows?.results || [];
}

async function guardarHistorico(env, reservas) {
  const candidatas = (reservas || []).filter((row) => estadoIncluidoEnHistorico(row.estado));
  if (!candidatas.length) return 0;

  const sentencias = candidatas.map((row) => env.DB.prepare(`
    INSERT OR IGNORE INTO reservas_estadisticas_historico (
      reserva_id,
      actividad_id,
      actividad_nombre,
      admin_id,
      admin_nombre,
      fecha_referencia,
      anio,
      estado_final,
      asistentes_total
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    Number(row.id || 0),
    Number(row.actividad_id || 0) || null,
    limpiarTexto(row.actividad_nombre) || "Actividad",
    Number(row.admin_id || 0) || null,
    limpiarTexto(row.admin_nombre) || "Administrador",
    limpiarTexto(row.fecha_referencia) || null,
    row.fecha_referencia ? Number(String(row.fecha_referencia).slice(0, 4)) || null : null,
    limpiarTexto(row.estado).toUpperCase(),
    Number(row.asistentes_total || 0)
  ));

  await env.DB.batch(sentencias);
  return candidatas.length;
}

async function borrarReservasFinalizadas(env, reservas) {
  const ids = (reservas || []).map((row) => Number(row.id || 0)).filter(Boolean);
  if (!ids.length) return 0;

  const sentenciasVisitantes = ids.map((id) => env.DB.prepare(`
    DELETE FROM visitantes
    WHERE reserva_id = ?
  `).bind(id));
  await env.DB.batch(sentenciasVisitantes);

  const sentenciasReservas = ids.map((id) => env.DB.prepare(`
    DELETE FROM reservas
    WHERE id = ?
  `).bind(id));
  await env.DB.batch(sentenciasReservas);

  return ids.length;
}

async function borrarFranjasDeActividadesVencidas(env) {
  const result = await env.DB.prepare(`
    DELETE FROM franjas
    WHERE actividad_id IN (
      SELECT id
      FROM actividades
      WHERE UPPER(TRIM(COALESCE(tipo, ''))) = 'TEMPORAL'
        AND fecha_fin IS NOT NULL
        AND date(fecha_fin) < date('now')
    )
  `).run();

  return Number(result?.meta?.changes || 0);
}

export async function ejecutarMantenimientoReservas(env) {
  await asegurarTablaHistorico(env);
  const rechazadasAutomaticamente = await rechazarReservasSuspendidasVencidas(env);
  const finalizadas = await obtenerReservasFinalizadas(env);
  const archivadas = await guardarHistorico(env, finalizadas);
  const eliminadas = await borrarReservasFinalizadas(env, finalizadas);
  const franjasEliminadas = await borrarFranjasDeActividadesVencidas(env);

  return {
    ok: true,
    rechazadas_automaticamente: rechazadasAutomaticamente,
    archivadas,
    eliminadas,
    franjas_eliminadas_por_fin_actividad: franjasEliminadas
  };
}
