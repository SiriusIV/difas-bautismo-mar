function normalizarTexto(valor) {
  return String(valor || "").trim();
}

function esErrorColumnaDuplicada(error) {
  const texto = normalizarTexto(error?.message || error || "").toLowerCase();
  return texto.includes("duplicate column name") || texto.includes("duplicate column");
}

export async function asegurarEstructuraRecurrenciaFranjas(env) {
  const columnas = [
    ["activa", "INTEGER NOT NULL DEFAULT 1"],
    ["recurrencia_origen_id", "INTEGER"],
    ["recurrencia_tipo", "TEXT"],
    ["recurrencia_intervalo", "INTEGER NOT NULL DEFAULT 1"],
    ["recurrencia_weekday", "INTEGER"],
    ["recurrencia_weekdays", "TEXT"],
    ["recurrencia_ordinal", "INTEGER"],
    ["recurrencia_monthday", "INTEGER"],
    ["recurrencia_month", "INTEGER"],
    ["recurrencia_inicio", "TEXT"],
    ["recurrencia_fin", "TEXT"],
    ["recurrencia_fin_tipo", "TEXT"],
    ["recurrencia_repeticiones", "INTEGER"]
  ];

  for (const [nombre, definicion] of columnas) {
    try {
      await env.DB.prepare(`ALTER TABLE franjas ADD COLUMN ${nombre} ${definicion}`).run();
    } catch (error) {
      if (!esErrorColumnaDuplicada(error)) throw error;
    }
  }

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS franja_recurrencia_excepciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recurrencia_origen_id INTEGER NOT NULL,
      actividad_id INTEGER NOT NULL,
      fecha TEXT NOT NULL,
      hora_inicio TEXT NOT NULL,
      hora_fin TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_franja_recurrencia_excepcion_unica
    ON franja_recurrencia_excepciones (
      recurrencia_origen_id,
      actividad_id,
      fecha,
      hora_inicio,
      COALESCE(hora_fin, '')
    )
  `).run();
}

function fechaIsoLocal(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function crearFechaLocal(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return null;
  const [y, m, d] = String(iso).split("-").map(Number);
  const fecha = new Date(y, m - 1, d);
  return fecha.getFullYear() === y && fecha.getMonth() === m - 1 && fecha.getDate() === d ? fecha : null;
}

function normalizarListaWeekdays(valor) {
  const valores = Array.isArray(valor)
    ? valor
    : String(valor || "").split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(valores
    .map((item) => parseInt(item, 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))]
    .sort((a, b) => a - b);
}

function sumarDias(fecha, dias) {
  const siguiente = new Date(fecha);
  siguiente.setDate(siguiente.getDate() + dias);
  return siguiente;
}

function sumarMeses(fecha, meses) {
  const siguiente = new Date(fecha);
  siguiente.setMonth(siguiente.getMonth() + meses);
  return siguiente;
}

function inicioMes(fecha) {
  return new Date(fecha.getFullYear(), fecha.getMonth(), 1);
}

function finMes(fecha) {
  return new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0);
}

function finVentanaRecurrencia() {
  return finMes(sumarMeses(inicioMes(new Date()), 1));
}

function nthWeekdayOfMonth(year, monthIndex, weekday, ordinal) {
  if (Number(ordinal) === -1) {
    const fecha = new Date(year, monthIndex + 1, 0);
    while (fecha.getDay() !== Number(weekday)) fecha.setDate(fecha.getDate() - 1);
    return fecha;
  }
  const fecha = new Date(year, monthIndex, 1);
  while (fecha.getDay() !== Number(weekday)) fecha.setDate(fecha.getDate() + 1);
  fecha.setDate(fecha.getDate() + (Number(ordinal) - 1) * 7);
  return fecha.getMonth() === monthIndex ? fecha : null;
}

function generarFechasRecurrencia(patron = {}, hasta = finVentanaRecurrencia()) {
  const inicio = crearFechaLocal(patron.recurrencia_inicio);
  if (!inicio) return [];
  const finTipo = normalizarTexto(patron.recurrencia_fin_tipo || (patron.recurrencia_fin ? "FECHA" : "NUNCA")).toUpperCase();
  const finRegla = finTipo === "FECHA" && patron.recurrencia_fin ? crearFechaLocal(patron.recurrencia_fin) : null;
  const finActividad = crearFechaLocal(patron.actividad_fecha_fin);
  const limiteRegla = finRegla && finRegla < hasta ? finRegla : hasta;
  const limite = finActividad && finActividad < limiteRegla ? finActividad : limiteRegla;
  const inicioActividad = crearFechaLocal(patron.actividad_fecha_inicio);
  const minimo = inicioActividad && inicioActividad > inicio ? inicioActividad : inicio;
  const tipo = normalizarTexto(patron.recurrencia_tipo).toUpperCase();
  const intervalo = Math.max(Number(patron.recurrencia_intervalo || 1), 1);
  const maxRepeticiones = finTipo === "REPETICIONES" ? Number(patron.recurrencia_repeticiones || 0) : null;
  const fechas = [];
  const agregarFecha = (fecha) => {
    if (maxRepeticiones && fechas.length >= maxRepeticiones) return false;
    if (fecha < minimo || fecha > limite) return true;
    fechas.push(fechaIsoLocal(fecha));
    return !(maxRepeticiones && fechas.length >= maxRepeticiones);
  };

  if (tipo === "DIARIA") {
    for (let actual = new Date(inicio); actual <= limite; actual = sumarDias(actual, intervalo)) {
      if (!agregarFecha(actual)) break;
    }
  } else if (tipo === "SEMANAL") {
    const weekdays = normalizarListaWeekdays(patron.recurrencia_weekdays || patron.recurrencia_weekday);
    for (let semanaBase = new Date(inicio); semanaBase <= limite; semanaBase = sumarDias(semanaBase, 7 * intervalo)) {
      const inicioSemana = sumarDias(semanaBase, -semanaBase.getDay());
      for (const weekday of weekdays) {
        const fecha = sumarDias(inicioSemana, weekday);
        if (!agregarFecha(fecha)) return [...new Set(fechas)].sort();
      }
    }
  } else if (tipo === "MENSUAL_DIA_SEMANA") {
    for (let cursor = inicioMes(inicio); cursor <= limite; cursor = sumarMeses(cursor, intervalo)) {
      const fecha = nthWeekdayOfMonth(cursor.getFullYear(), cursor.getMonth(), patron.recurrencia_weekday, patron.recurrencia_ordinal);
      if (fecha && !agregarFecha(fecha)) break;
    }
  } else if (tipo === "MENSUAL_DIA_MES") {
    for (let cursor = inicioMes(inicio); cursor <= limite; cursor = sumarMeses(cursor, intervalo)) {
      const fecha = new Date(cursor.getFullYear(), cursor.getMonth(), Number(patron.recurrencia_monthday));
      if (fecha.getMonth() === cursor.getMonth() && !agregarFecha(fecha)) break;
    }
  } else if (tipo === "ANUAL") {
    for (let year = inicio.getFullYear(); year <= limite.getFullYear(); year += intervalo) {
      const fecha = new Date(year, Number(patron.recurrencia_month) - 1, Number(patron.recurrencia_monthday));
      if (fecha.getMonth() === Number(patron.recurrencia_month) - 1 && !agregarFecha(fecha)) break;
    }
  }

  return [...new Set(fechas)].sort();
}

async function insertarFranjaMaterializada(env, patron, fecha) {
  const existente = await env.DB.prepare(`
    SELECT id
    FROM franjas
    WHERE actividad_id = ?
      AND fecha = ?
      AND hora_inicio = ?
      AND COALESCE(hora_fin, '') = COALESCE(?, '')
      AND COALESCE(es_recurrente, 0) = 0
    LIMIT 1
  `).bind(patron.actividad_id, fecha, patron.hora_inicio, patron.hora_fin).first();

  if (existente) return false;

  const excepcion = await env.DB.prepare(`
    SELECT id
    FROM franja_recurrencia_excepciones
    WHERE recurrencia_origen_id = ?
      AND actividad_id = ?
      AND fecha = ?
      AND hora_inicio = ?
      AND COALESCE(hora_fin, '') = COALESCE(?, '')
    LIMIT 1
  `).bind(patron.id, patron.actividad_id, fecha, patron.hora_inicio, patron.hora_fin).first();

  if (excepcion) return false;

  await env.DB.prepare(`
    INSERT INTO franjas (
      fecha, hora_inicio, hora_fin, capacidad, actividad_id, activa, es_recurrente, patron_recurrencia,
      recurrencia_origen_id, recurrencia_tipo, recurrencia_intervalo, recurrencia_weekday, recurrencia_weekdays, recurrencia_ordinal,
      recurrencia_monthday, recurrencia_month, recurrencia_inicio, recurrencia_fin, recurrencia_fin_tipo, recurrencia_repeticiones
    )
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fecha,
    patron.hora_inicio,
    patron.hora_fin,
    patron.capacidad,
    patron.actividad_id,
    patron.patron_recurrencia,
    patron.id,
    patron.recurrencia_tipo,
    Number(patron.recurrencia_intervalo || 1),
    patron.recurrencia_weekday,
    patron.recurrencia_weekdays,
    patron.recurrencia_ordinal,
    patron.recurrencia_monthday,
    patron.recurrencia_month,
    patron.recurrencia_inicio,
    patron.recurrencia_fin,
    patron.recurrencia_fin_tipo,
    patron.recurrencia_repeticiones
  ).run();

  return true;
}

async function limpiarDuplicadosExactosFuturosActividad(env, actividadId) {
  const grupos = await env.DB.prepare(`
    SELECT
      fecha,
      hora_inicio,
      COALESCE(hora_fin, '') AS hora_fin_norm,
      COUNT(*) AS total
    FROM franjas
    WHERE actividad_id = ?
      AND COALESCE(es_recurrente, 0) = 0
      AND fecha IS NOT NULL
      AND datetime(fecha || ' ' || COALESCE(NULLIF(hora_inicio, ''), '00:00')) > datetime('now')
    GROUP BY fecha, hora_inicio, COALESCE(hora_fin, '')
    HAVING COUNT(*) > 1
  `).bind(actividadId).all();

  let eliminadas = 0;
  for (const grupo of grupos?.results || []) {
    const filas = await env.DB.prepare(`
      SELECT
        f.id,
        COUNT(r.id) AS reservas
      FROM franjas f
      LEFT JOIN reservas r ON r.franja_id = f.id
      WHERE f.actividad_id = ?
        AND COALESCE(f.es_recurrente, 0) = 0
        AND f.fecha = ?
        AND f.hora_inicio = ?
        AND COALESCE(f.hora_fin, '') = ?
      GROUP BY f.id
      ORDER BY COUNT(r.id) DESC, f.id ASC
    `).bind(actividadId, grupo.fecha, grupo.hora_inicio, grupo.hora_fin_norm).all();

    const rows = filas?.results || [];
    const conservar = rows[0]?.id;
    for (const row of rows.slice(1)) {
      if (Number(row.reservas || 0) > 0) continue;
      const borrado = await env.DB.prepare(`
        DELETE FROM franjas
        WHERE id = ?
      `).bind(row.id).run();
      eliminadas += Number(borrado?.meta?.changes || 0);
    }

    if (!conservar && rows.length) {
      continue;
    }
  }

  return eliminadas;
}

export async function materializarPatronesActividad(env, actividadId) {
  await asegurarEstructuraRecurrenciaFranjas(env);
  await limpiarDuplicadosExactosFuturosActividad(env, actividadId);
  const result = await env.DB.prepare(`
    SELECT
      f.*,
      a.fecha_inicio AS actividad_fecha_inicio,
      a.fecha_fin AS actividad_fecha_fin
    FROM franjas f
    LEFT JOIN actividades a ON a.id = f.actividad_id
    WHERE f.actividad_id = ?
      AND COALESCE(f.es_recurrente, 0) = 1
      AND f.recurrencia_tipo IS NOT NULL
  `).bind(actividadId).all();

  let creadas = 0;
  for (const patron of result?.results || []) {
    for (const fecha of generarFechasRecurrencia(patron)) {
      if (await insertarFranjaMaterializada(env, patron, fecha)) creadas += 1;
    }
  }
  await limpiarDuplicadosExactosFuturosActividad(env, actividadId);
  return creadas;
}

export async function materializarPatronesGlobales(env) {
  await asegurarEstructuraRecurrenciaFranjas(env);
  const result = await env.DB.prepare(`
    SELECT DISTINCT actividad_id
    FROM franjas
    WHERE COALESCE(es_recurrente, 0) = 1
      AND recurrencia_tipo IS NOT NULL
  `).all();

  let creadas = 0;
  for (const row of result?.results || []) {
    creadas += await materializarPatronesActividad(env, row.actividad_id);
  }
  return creadas;
}
