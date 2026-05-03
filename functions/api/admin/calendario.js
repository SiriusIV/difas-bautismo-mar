import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function colorEstado(estado) {
  const e = String(estado || "").toUpperCase();
  if (e === "PENDIENTE") return "#d39e00";
  if (e === "CONFIRMADA") return "#198754";
  if (e === "SUSPENDIDA") return "#b7791f";
  if (e === "RECHAZADA") return "#dc3545";
  return "#0b5ed7";
}

function estadoBloqueaPlazas(estado) {
  return ["PENDIENTE", "CONFIRMADA", "SUSPENDIDA"].includes(String(estado || "").toUpperCase());
}

function esPrereservaVigente(expira) {
  if (!expira) return false;
  const d = new Date(String(expira).replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return false;
  return d >= new Date();
}

function calcularPlazasAsignadas(row) {
  if (!estadoBloqueaPlazas(row.estado)) return 0;
  return Number(row.asistentes_cargados || 0);
}

function calcularPlazasReservadasPendientes(row) {
  if (!estadoBloqueaPlazas(row.estado)) return 0;
  if (!esPrereservaVigente(row.prereserva_expira_en)) return 0;

  const pre = Number(row.plazas_prereservadas || 0);
  const asignadas = Number(row.asistentes_cargados || 0);
  return Math.max(pre - asignadas, 0);
}

function calcularBloqueoActualReserva(row) {
  if (!estadoBloqueaPlazas(row.estado)) return 0;

  if (esPrereservaVigente(row.prereserva_expira_en)) {
    return Math.max(
      Number(row.plazas_prereservadas || 0),
      Number(row.asistentes_cargados || 0)
    );
  }

  return Number(row.asistentes_cargados || 0);
}

async function obtenerReservasCalendario(env, filtros) {
  const where = [];
  const binds = [];

  where.push("UPPER(TRIM(COALESCE(r.estado, ''))) <> 'CANCELADA'");
  where.push("(date(f.fecha) >= date('now') OR UPPER(TRIM(COALESCE(r.estado, ''))) = 'CONFIRMADA')");

  if (filtros.start) {
    where.push("f.fecha >= ?");
    binds.push(filtros.start);
  }

  if (filtros.end) {
    where.push("f.fecha < ?");
    binds.push(filtros.end);
  }

  if (filtros.estado) {
    where.push("r.estado = ?");
    binds.push(filtros.estado);
  } else {
    const estados = ["PENDIENTE", "CONFIRMADA", "SUSPENDIDA"];
    if (filtros.incluirRechazadas) estados.push("RECHAZADA");

    where.push(`r.estado IN (${estados.map(() => "?").join(", ")})`);
    binds.push(...estados);
  }

  const sql = `
    SELECT
      r.id,
      r.franja_id,
      r.codigo_reserva,
      r.token_edicion,
      r.estado,
      r.centro,
      r.contacto,
      r.telefono,
      r.email,
      r.observaciones,
      r.plazas_prereservadas,
      r.prereserva_expira_en,

      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,

      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_cargados

    FROM reservas r
    INNER JOIN franjas f
      ON f.id = r.franja_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY f.fecha ASC, f.hora_inicio ASC, r.fecha_solicitud ASC
  `;

  const result = await env.DB.prepare(sql).bind(...binds).all();
  return result.results || [];
}

async function obtenerBloqueoPorFranja(env, franjaIds) {
  if (!franjaIds.length) return new Map();

  const placeholders = franjaIds.map(() => "?").join(", ");
  const sql = `
    SELECT
      r.franja_id,
      r.estado,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_cargados
    FROM reservas r
    WHERE r.franja_id IN (${placeholders})
  `;

  const result = await env.DB.prepare(sql).bind(...franjaIds).all();
  const rows = result.results || [];

  const map = new Map();

  for (const row of rows) {
    const franjaId = Number(row.franja_id);
    const acumulado = map.get(franjaId) || 0;
    map.set(franjaId, acumulado + calcularBloqueoActualReserva(row));
  }

  return map;
}

function construirIsoLocal(fecha, hora) {
  return `${fecha}T${hora}`;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    await ejecutarMantenimientoReservas(env);
    const url = new URL(request.url);

    const filtros = {
      start: limpiarTexto(url.searchParams.get("start") || ""),
      end: limpiarTexto(url.searchParams.get("end") || ""),
      estado: (() => {
        const v = limpiarTexto(url.searchParams.get("estado") || "").toUpperCase();
        return v || null;
      })(),
      incluirRechazadas: url.searchParams.get("incluir_rechazadas") === "1"
    };

    const rows = await obtenerReservasCalendario(env, filtros);
    const franjaIds = [...new Set(rows.map(r => Number(r.franja_id)).filter(Boolean))];
    const bloqueoPorFranja = await obtenerBloqueoPorFranja(env, franjaIds);

    const eventos = rows.map(row => {
      const capacidad = Number(row.capacidad || 0);
      const bloqueoFranja = Number(bloqueoPorFranja.get(Number(row.franja_id)) || 0);
      const disponibles = Math.max(capacidad - bloqueoFranja, 0);

      const plazasAsignadas = calcularPlazasAsignadas(row);
      const plazasReservadas = calcularPlazasReservadasPendientes(row);

      return {
        id: String(row.id),
        title: `${row.codigo_reserva} · ${row.centro || "Sin centro"}`,
        start: construirIsoLocal(row.fecha, row.hora_inicio),
        end: construirIsoLocal(row.fecha, row.hora_fin),
        backgroundColor: colorEstado(row.estado),
        borderColor: colorEstado(row.estado),
        textColor: "#ffffff",
        extendedProps: {
          id: row.id,
          franja_id: row.franja_id,
          codigo_reserva: row.codigo_reserva,
          token_edicion: row.token_edicion || "",
          estado: row.estado,
          centro: row.centro || "",
          contacto: row.contacto || "",
          telefono: row.telefono || "",
          email: row.email || "",
          observaciones: row.observaciones || "",
          fecha: row.fecha,
          hora_inicio: row.hora_inicio,
          hora_fin: row.hora_fin,
          capacidad,
          prereserva_expira_en: row.prereserva_expira_en,
          plazas_prereservadas_historicas: Number(row.plazas_prereservadas || 0),
          plazas_reservadas: plazasReservadas,
          plazas_asignadas: plazasAsignadas,
          disponibles,
          asistentes_cargados: Number(row.asistentes_cargados || 0)
        }
      };
    });

    return json({
      ok: true,
      eventos
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo cargar el calendario administrativo.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
