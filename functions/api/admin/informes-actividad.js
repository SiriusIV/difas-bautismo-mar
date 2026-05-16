import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  });
}

function dbLectura(env) {
  if (typeof env?.DB?.withSession === "function") {
    return env.DB.withSession("first-primary");
  }
  return env.DB;
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function fechaHoyIso() {
  return new Date().toISOString().slice(0, 10);
}

function fechaInicioAnioIso() {
  const hoy = new Date();
  return `${hoy.getFullYear()}-01-01`;
}

function fechaValidaIso(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(limpiarTexto(valor));
}

function rangoAniosComparativa() {
  const actual = new Date().getFullYear();
  return Array.from({ length: 5 }, (_, index) => actual - 4 + index);
}

async function obtenerFilasBase(db, filtros) {
  const where = [
    "UPPER(TRIM(COALESCE(r.estado, ''))) = 'CONFIRMADA'",
    "date(COALESCE(f.fecha, a.fecha_inicio, substr(r.fecha_solicitud, 1, 10))) >= date(?)",
    "date(COALESCE(f.fecha, a.fecha_inicio, substr(r.fecha_solicitud, 1, 10))) <= date(?)"
  ];
  const binds = [filtros.fechaInicio, filtros.fechaFin];

  if (!filtros.esSuperadmin) {
    where.push("a.admin_id = ?");
    binds.push(filtros.adminId);
  }

  if (filtros.programa) {
    where.push("TRIM(COALESCE(a.subtitulo_publico, '')) = ?");
    binds.push(filtros.programa);
  }

  if (filtros.actividadId) {
    where.push("a.id = ?");
    binds.push(filtros.actividadId);
  }

  const result = await db.prepare(`
    SELECT
      r.id AS reserva_id,
      r.actividad_id,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      date(COALESCE(f.fecha, a.fecha_inicio, substr(r.fecha_solicitud, 1, 10))) AS fecha_realizacion,
      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    WHERE ${where.join(" AND ")}
  `).bind(...binds).all();

  return result.results || [];
}

function construirResumen(rows) {
  const actividades = new Map();
  let totalAsistentes = 0;
  for (const row of rows) {
    const actividadId = Number(row.actividad_id || 0);
    if (actividadId > 0) actividades.set(actividadId, true);
    totalAsistentes += Number(row.asistentes || 0);
  }
  return {
    total_actividades: actividades.size,
    total_realizaciones: rows.length,
    total_asistentes: totalAsistentes
  };
}

function construirDetalle(rows) {
  const mapa = new Map();
  for (const row of rows) {
    const actividadId = Number(row.actividad_id || 0);
    const clave = actividadId > 0 ? `a_${actividadId}` : `s_${limpiarTexto(row.actividad_nombre)}`;
    if (!mapa.has(clave)) {
      mapa.set(clave, {
        actividad_id: actividadId,
        actividad_nombre: limpiarTexto(row.actividad_nombre) || "Actividad",
        total_realizaciones: 0,
        total_asistentes: 0,
        primera_fecha: "",
        ultima_fecha: ""
      });
    }
    const item = mapa.get(clave);
    const fecha = limpiarTexto(row.fecha_realizacion);
    item.total_realizaciones += 1;
    item.total_asistentes += Number(row.asistentes || 0);
    if (fecha && (!item.primera_fecha || fecha < item.primera_fecha)) item.primera_fecha = fecha;
    if (fecha && (!item.ultima_fecha || fecha > item.ultima_fecha)) item.ultima_fecha = fecha;
  }
  return Array.from(mapa.values()).sort((a, b) => {
    if (b.total_asistentes !== a.total_asistentes) return b.total_asistentes - a.total_asistentes;
    return a.actividad_nombre.localeCompare(b.actividad_nombre, "es", { sensitivity: "base" });
  });
}

async function obtenerCatalogoFiltros(db, filtros) {
  const where = [];
  const binds = [];

  if (!filtros.esSuperadmin) {
    where.push("admin_id = ?");
    binds.push(filtros.adminId);
  }

  const result = await db.prepare(`
    SELECT
      id,
      COALESCE(titulo_publico, nombre, 'Actividad') AS actividad_nombre,
      COALESCE(subtitulo_publico, '') AS programa
    FROM actividades
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY actividad_nombre COLLATE NOCASE ASC
  `).bind(...binds).all();

  const actividades = (result.results || []).map((row) => ({
    id: Number(row.id || 0),
    nombre: limpiarTexto(row.actividad_nombre) || "Actividad",
    programa: limpiarTexto(row.programa)
  }));

  const programas = [...new Set(
    actividades
      .map((item) => item.programa)
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

  return { programas, actividades };
}

async function obtenerComparativa(db, filtros) {
  const anios = rangoAniosComparativa();
  const where = [
    "UPPER(TRIM(COALESCE(r.estado, ''))) = 'CONFIRMADA'",
    `CAST(strftime('%Y', COALESCE(f.fecha, a.fecha_inicio, substr(r.fecha_solicitud, 1, 10))) AS INTEGER) IN (${anios.map(() => "?").join(", ")})`
  ];
  const binds = [...anios];

  if (!filtros.esSuperadmin) {
    where.push("a.admin_id = ?");
    binds.push(filtros.adminId);
  }

  if (filtros.programa) {
    where.push("TRIM(COALESCE(a.subtitulo_publico, '')) = ?");
    binds.push(filtros.programa);
  }

  if (filtros.actividadId) {
    where.push("a.id = ?");
    binds.push(filtros.actividadId);
  }

  const result = await db.prepare(`
    SELECT
      r.actividad_id,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      CAST(strftime('%Y', COALESCE(f.fecha, a.fecha_inicio, substr(r.fecha_solicitud, 1, 10))) AS INTEGER) AS anio,
      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    WHERE ${where.join(" AND ")}
  `).bind(...binds).all();

  const mapa = new Map();
  for (const row of result.results || []) {
    const actividadId = Number(row.actividad_id || 0);
    if (!(actividadId > 0)) continue;
    if (!mapa.has(actividadId)) {
      mapa.set(actividadId, {
        actividad_id: actividadId,
        actividad_nombre: limpiarTexto(row.actividad_nombre) || "Actividad",
        series: anios.map((anio) => ({ anio, total_asistentes: 0 }))
      });
    }
    const item = mapa.get(actividadId);
    const anio = Number(row.anio || 0);
    const slot = item.series.find((serie) => serie.anio === anio);
    if (slot) slot.total_asistentes += Number(row.asistentes || 0);
  }

  return {
    anios,
    actividades: Array.from(mapa.values()).sort((a, b) =>
      a.actividad_nombre.localeCompare(b.actividad_nombre, "es", { sensitivity: "base" })
    )
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const rol = await getRolUsuario(env, session.usuario_id);
    const esSuperadmin = rol === "SUPERADMIN";

    const url = new URL(request.url);
    const fechaInicio = fechaValidaIso(url.searchParams.get("fecha_inicio"))
      ? limpiarTexto(url.searchParams.get("fecha_inicio"))
      : fechaInicioAnioIso();
    const fechaFin = fechaValidaIso(url.searchParams.get("fecha_fin"))
      ? limpiarTexto(url.searchParams.get("fecha_fin"))
      : fechaHoyIso();
    const programa = limpiarTexto(url.searchParams.get("programa"));
    const actividadId = Number(url.searchParams.get("actividad_id") || 0);

    if (fechaInicio > fechaFin) {
      return json({ ok: false, error: "La fecha de inicio no puede ser posterior a la fecha final." }, 400);
    }

    const db = dbLectura(env);
    const filtros = {
      adminId: session.usuario_id,
      esSuperadmin,
      fechaInicio,
      fechaFin,
      programa,
      actividadId: actividadId > 0 ? actividadId : 0
    };

    const catalogo = await obtenerCatalogoFiltros(db, filtros);
    const rows = await obtenerFilasBase(db, filtros);
    const resumen = construirResumen(rows);
    const detalle = construirDetalle(rows);
    const comparativa = await obtenerComparativa(db, filtros);

    return json({
      ok: true,
      intervalo: {
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin
      },
      filtros: {
        programa,
        actividad_id: filtros.actividadId || 0,
        catalogo
      },
      resumen,
      actividades: detalle,
      comparativa
    });
  } catch (error) {
    return json({
      ok: false,
      error: error?.message || "No se pudo generar el informe de actividades."
    }, 500);
  }
}
