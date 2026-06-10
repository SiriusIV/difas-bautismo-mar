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
    ["recurrencia_ordinal", "INTEGER"],
    ["recurrencia_monthday", "INTEGER"],
    ["recurrencia_month", "INTEGER"],
    ["recurrencia_inicio", "TEXT"],
    ["recurrencia_fin", "TEXT"]
  ];

  for (const [nombre, definicion] of columnas) {
    try {
      await env.DB.prepare(`ALTER TABLE franjas ADD COLUMN ${nombre} ${definicion}`).run();
    } catch (error) {
      if (!esErrorColumnaDuplicada(error)) throw error;
    }
  }
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
  return finMes(sumarMeses(inicioMes(new Date()), 2));
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
  const finRegla = patron.recurrencia_fin ? crearFechaLocal(patron.recurrencia_fin) : null;
  const limite = finRegla && finRegla < hasta ? finRegla : hasta;
  const tipo = normalizarTexto(patron.recurrencia_tipo).toUpperCase();
  const intervalo = Math.max(Number(patron.recurrencia_intervalo || 1), 1);
  const fechas = [];

  if (tipo === "DIARIA") {
    for (let actual = new Date(inicio); actual <= limite; actual = sumarDias(actual, intervalo)) fechas.push(fechaIsoLocal(actual));
  } else if (tipo === "SEMANAL") {
    let actual = new Date(inicio);
    while (actual.getDay() !== Number(patron.recurrencia_weekday)) actual = sumarDias(actual, 1);
    for (; actual <= limite; actual = sumarDias(actual, 7 * intervalo)) fechas.push(fechaIsoLocal(actual));
  } else if (tipo === "MENSUAL_DIA_SEMANA") {
    for (let cursor = inicioMes(inicio); cursor <= limite; cursor = sumarMeses(cursor, intervalo)) {
      const fecha = nthWeekdayOfMonth(cursor.getFullYear(), cursor.getMonth(), patron.recurrencia_weekday, patron.recurrencia_ordinal);
      if (fecha && fecha >= inicio && fecha <= limite) fechas.push(fechaIsoLocal(fecha));
    }
  } else if (tipo === "MENSUAL_DIA_MES") {
    for (let cursor = inicioMes(inicio); cursor <= limite; cursor = sumarMeses(cursor, intervalo)) {
      const fecha = new Date(cursor.getFullYear(), cursor.getMonth(), Number(patron.recurrencia_monthday));
      if (fecha.getMonth() === cursor.getMonth() && fecha >= inicio && fecha <= limite) fechas.push(fechaIsoLocal(fecha));
    }
  } else if (tipo === "ANUAL") {
    for (let year = inicio.getFullYear(); year <= limite.getFullYear(); year += intervalo) {
      const fecha = new Date(year, Number(patron.recurrencia_month) - 1, Number(patron.recurrencia_monthday));
      if (fecha.getMonth() === Number(patron.recurrencia_month) - 1 && fecha >= inicio && fecha <= limite) fechas.push(fechaIsoLocal(fecha));
    }
  }

  return [...new Set(fechas)].sort();
}

async function insertarFranjaMaterializada(env, patron, fecha) {
  const existente = await env.DB.prepare(`
    SELECT id
    FROM franjas
    WHERE actividad_id = ?
      AND recurrencia_origen_id = ?
      AND fecha = ?
      AND hora_inicio = ?
      AND COALESCE(hora_fin, '') = COALESCE(?, '')
    LIMIT 1
  `).bind(patron.actividad_id, patron.id, fecha, patron.hora_inicio, patron.hora_fin).first();

  if (existente) return false;

  await env.DB.prepare(`
    INSERT INTO franjas (
      fecha, hora_inicio, hora_fin, capacidad, actividad_id, activa, es_recurrente, patron_recurrencia,
      recurrencia_origen_id, recurrencia_tipo, recurrencia_intervalo, recurrencia_weekday, recurrencia_ordinal,
      recurrencia_monthday, recurrencia_month, recurrencia_inicio, recurrencia_fin
    )
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    patron.recurrencia_ordinal,
    patron.recurrencia_monthday,
    patron.recurrencia_month,
    patron.recurrencia_inicio,
    patron.recurrencia_fin
  ).run();

  return true;
}

export async function materializarPatronesActividad(env, actividadId) {
  await asegurarEstructuraRecurrenciaFranjas(env);
  const result = await env.DB.prepare(`
    SELECT *
    FROM franjas
    WHERE actividad_id = ?
      AND COALESCE(es_recurrente, 0) = 1
      AND recurrencia_tipo IS NOT NULL
  `).bind(actividadId).all();

  let creadas = 0;
  for (const patron of result?.results || []) {
    for (const fecha of generarFechasRecurrencia(patron)) {
      if (await insertarFranjaMaterializada(env, patron, fecha)) creadas += 1;
    }
  }
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
