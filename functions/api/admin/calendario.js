import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";
import { getUserSession } from "../usuario/_auth.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

async function getCalendarSession(request, env) {
  const session = await getUserSession(request, env.SECRET_KEY);
  if (!session) return null;

  const rol = String(session.rol || "").toUpperCase();
  if (!["ADMIN", "SUPERADMIN", "SOLICITANTE"].includes(rol)) {
    return null;
  }

  return {
    username: session.email || "",
    usuario_id: Number(session.id || 0),
    rol
  };
}

function colorEstado(estado) {
  const e = String(estado || "").toUpperCase();
  if (e === "PENDIENTE") return "#d39e00";
  if (e === "CONFIRMADA") return "#198754";
  if (e === "SUSPENDIDA") return "#b7791f";
  if (e === "RECHAZADA") return "#dc3545";
  return "#0b5ed7";
}

function esFranjaFinalizada(fecha, horaFin) {
  if (!fecha || !horaFin) return false;
  const d = new Date(`${fecha}T${horaFin}`);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

function colorActividadProgramada(row, disponibles) {
  const capacidad = Number(row.capacidad || 0);
  if (esFranjaFinalizada(row.fecha, row.hora_fin)) return "#5f6d7a";
  if (capacidad > 0 && Number(disponibles) <= 0) return "#dc3545";
  if (capacidad > 0 && Number(disponibles) > 0 && Number(disponibles) <= Math.ceil(capacidad / 4)) {
    return "#d97706";
  }
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

async function obtenerReservasCalendario(env, filtros, session) {
  const where = [];
  const binds = [];

  where.push("UPPER(TRIM(COALESCE(r.estado, ''))) <> 'CANCELADA'");
  where.push("UPPER(TRIM(COALESCE(r.estado, ''))) <> 'BORRADOR'");
  where.push("(date(f.fecha) >= date('now') OR UPPER(TRIM(COALESCE(r.estado, ''))) = 'CONFIRMADA')");

  if (String(session?.rol || "").toUpperCase() === "SOLICITANTE") {
    where.push("r.usuario_id = ?");
    binds.push(Number(session?.usuario_id || 0));
  }

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
      r.usuario_id,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.actividad_id,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      a.admin_id,
      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_cargados
    FROM reservas r
    INNER JOIN franjas f
      ON f.id = r.franja_id
    INNER JOIN actividades a
      ON a.id = f.actividad_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY f.fecha ASC, f.hora_inicio ASC, r.fecha_solicitud ASC
  `;

  const result = await env.DB.prepare(sql).bind(...binds).all();
  return result.results || [];
}

async function obtenerFranjasProgramadasCalendario(env, filtros, session) {
  const where = [
    "f.fecha IS NOT NULL",
    "f.hora_inicio IS NOT NULL",
    "f.hora_fin IS NOT NULL"
  ];
  const binds = [];

  if (String(session?.rol || "").toUpperCase() === "SOLICITANTE") {
    where.push("(date(f.fecha) > date('now') OR (date(f.fecha) = date('now') AND time(f.hora_fin) >= time('now')))");
  }

  if (filtros.start) {
    where.push("f.fecha >= ?");
    binds.push(filtros.start);
  }

  if (filtros.end) {
    where.push("f.fecha < ?");
    binds.push(filtros.end);
  }

  const sql = `
    SELECT
      f.id,
      f.actividad_id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      a.admin_id,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      COALESCE(a.organizador_publico, '') AS organizador_publico,
      COALESCE(a.lugar, '') AS lugar
    FROM franjas f
    INNER JOIN actividades a
      ON a.id = f.actividad_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY f.fecha ASC, f.hora_inicio ASC, f.id ASC
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
    const session = await getCalendarSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    await ejecutarMantenimientoReservas(env);
    const url = new URL(request.url);

    const filtros = {
      start: limpiarTexto(url.searchParams.get("start") || ""),
      end: limpiarTexto(url.searchParams.get("end") || ""),
      vista: (() => {
        const v = limpiarTexto(url.searchParams.get("vista") || "").toLowerCase();
        return v === "actividades" ? "actividades" : "reservas";
      })(),
      estado: (() => {
        const v = limpiarTexto(url.searchParams.get("estado") || "").toUpperCase();
        return v || null;
      })(),
      incluirRechazadas: url.searchParams.get("incluir_rechazadas") === "1"
    };

    let eventos = [];

    if (filtros.vista === "actividades") {
      const rows = await obtenerFranjasProgramadasCalendario(env, filtros, session);
      const franjaIds = [...new Set(rows.map((r) => Number(r.id)).filter(Boolean))];
      const bloqueoPorFranja = await obtenerBloqueoPorFranja(env, franjaIds);

      eventos = rows.map((row) => {
        const capacidad = Number(row.capacidad || 0);
        const bloqueoFranja = Number(bloqueoPorFranja.get(Number(row.id)) || 0);
        const disponibles = Math.max(capacidad - bloqueoFranja, 0);
        const color = colorActividadProgramada(row, disponibles);
        const editableActividad = session.rol === "SUPERADMIN" || Number(row.admin_id || 0) === Number(session.usuario_id || 0);
        const estadoActividad = esFranjaFinalizada(row.fecha, row.hora_fin)
          ? "FINALIZADA"
          : (capacidad > 0 && disponibles <= 0)
            ? "COMPLETA"
            : (capacidad > 0 && disponibles > 0 && disponibles <= Math.ceil(capacidad / 4))
              ? "ÚLTIMAS PLAZAS"
              : "DISPONIBLE";

        return {
          id: `actividad-${row.id}`,
          title: `${row.actividad_nombre || "Actividad"}${row.lugar ? ` · ${row.lugar}` : ""}`,
          start: construirIsoLocal(row.fecha, row.hora_inicio),
          end: construirIsoLocal(row.fecha, row.hora_fin),
          backgroundColor: color,
          borderColor: color,
          textColor: "#ffffff",
          extendedProps: {
            tipo_evento: "ACTIVIDAD_PROGRAMADA",
            franja_id: Number(row.id || 0),
            actividad_id: Number(row.actividad_id || 0),
            actividad_nombre: row.actividad_nombre || "Actividad",
            organizador_publico: row.organizador_publico || "",
            lugar: row.lugar || "",
            fecha: row.fecha,
            hora_inicio: row.hora_inicio,
            hora_fin: row.hora_fin,
            capacidad,
            disponibles,
            estado_actividad: estadoActividad,
            editable_actividad: editableActividad
          }
        };
      });
    } else {
      const rows = await obtenerReservasCalendario(env, filtros, session);
      const franjaIds = [...new Set(rows.map((r) => Number(r.franja_id)).filter(Boolean))];
      const bloqueoPorFranja = await obtenerBloqueoPorFranja(env, franjaIds);

      eventos = rows.map((row) => {
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
            tipo_evento: "RESERVA",
            id: row.id,
            usuario_id: Number(row.usuario_id || 0),
            actividad_id: Number(row.actividad_id || 0),
            actividad_nombre: row.actividad_nombre || "Actividad",
            admin_id: Number(row.admin_id || 0),
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
    }

    return json({
      ok: true,
      vista: filtros.vista,
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
