import { getUserSession } from "./_auth.js";
import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function estadoBloqueaPlazas(estado) {
  return ["PENDIENTE", "CONFIRMADA", "SUSPENDIDA"].includes(String(estado || "").toUpperCase());
}

function esErrorColumnaDuplicada(error) {
  const texto = String(error?.message || error || "").trim().toLowerCase();
  return texto.includes("duplicate column name") || texto.includes("duplicate column");
}

async function asegurarColumnaObservacionesAdmin(env) {
  try {
    await env.DB.prepare(`
      ALTER TABLE reservas
      ADD COLUMN observaciones_admin TEXT
    `).run();
  } catch (error) {
    if (!esErrorColumnaDuplicada(error)) {
      throw error;
    }
  }
}

function normalizarEstadoReserva(estado) {
  const valor = String(estado || "").trim().toUpperCase();
  if (valor === "CONDICIONADA_DOCUMENTACION") return "SUSPENDIDA";
  return valor;
}

function esPrereservaVigente(row) {
  if (!row?.prereserva_expira_en) return false;
  if (!estadoBloqueaPlazas(row.estado)) return false;

  return Number(row.prereserva_vigente || 0) === 1;
}

function calcularPlazasAsignadas(row) {
  if (!estadoBloqueaPlazas(row.estado)) return 0;
  return Number(row.asistentes_cargados || 0);
}

function calcularPlazasReservadasPendientes(row) {
  if (!estadoBloqueaPlazas(row.estado)) return 0;
  if (!esPrereservaVigente(row)) return 0;

  const pre = Number(row.plazas_prereservadas || 0);
  const asignadas = Number(row.asistentes_cargados || 0);

  return Math.max(pre - asignadas, 0);
}

function tieneProgramacionValida(row) {
  const estado = normalizarEstadoReserva(row?.estado);
  const usaFranjas = Number(row?.usa_franjas || 0) === 1;
  if (estado === "BORRADOR") return true;
  if (!usaFranjas) return true;
  return !!(
    String(row?.fecha || "").trim() &&
    String(row?.hora_inicio || "").trim() &&
    String(row?.hora_fin || "").trim()
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    await ejecutarMantenimientoReservas(env);
    await asegurarColumnaObservacionesAdmin(env);
    const user = await getUserSession(request, env.SECRET_KEY);

    if (!user || !user.id) {
      return json({ ok: false, authenticated: false }, 401);
    }

    const db = typeof env?.DB?.withSession === "function"
      ? env.DB.withSession("first-primary")
      : env.DB;

    const result = await db.prepare(`
      SELECT
        r.id,
        r.codigo_reserva,
        r.estado,
        r.token_edicion,
        r.observaciones,
        COALESCE(r.observaciones_admin, '') AS observaciones_admin,
        r.fecha_solicitud,
        r.fecha_modificacion,
        r.actividad_id,
        r.franja_id,
        a.admin_id,
        COALESCE(a.usa_franjas, 1) AS usa_franjas,
        r.plazas_prereservadas,
        r.prereserva_expira_en,
        CASE
          WHEN r.prereserva_expira_en IS NOT NULL
               AND datetime('now') <= datetime(r.prereserva_expira_en)
            THEN 1
          ELSE 0
        END AS prereserva_vigente,
        f.fecha,
        f.hora_inicio,
        f.hora_fin,
        COALESCE((
          SELECT COUNT(*)
          FROM visitantes v
          WHERE v.reserva_id = r.id
        ), 0) AS asistentes_cargados,
        COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad
      FROM reservas r
      LEFT JOIN franjas f ON r.franja_id = f.id
      LEFT JOIN actividades a ON r.actividad_id = a.id
      WHERE r.usuario_id = ?
        AND UPPER(TRIM(COALESCE(r.estado, ''))) <> 'CANCELADA'
      ORDER BY
        CASE WHEN UPPER(TRIM(COALESCE(r.estado, ''))) = 'BORRADOR' THEN 0 ELSE 1 END ASC,
        f.fecha DESC,
        f.hora_inicio DESC,
        r.fecha_solicitud DESC,
        r.id DESC
    `).bind(user.id).all();

    const rows = (result.results || []).filter(tieneProgramacionValida);

    const data = rows.map(row => ({
      id: row.id,
      codigo_reserva: row.codigo_reserva,
      estado: normalizarEstadoReserva(row.estado),
      token_edicion: row.token_edicion || "",
      actividad_id: Number(row.actividad_id || 0),
      franja_id: Number(row.franja_id || 0) || null,
      observaciones: row.observaciones || "",
      observaciones_admin: row.observaciones_admin || "",
      admin_id: Number(row.admin_id || 0),
      actividad: row.actividad || "Actividad",
      usa_franjas: Number(row.usa_franjas || 0),
      fecha_solicitud: row.fecha_solicitud || "",
      fecha_modificacion: row.fecha_modificacion || "",
      fecha: row.fecha || "",
      hora_inicio: row.hora_inicio || "",
      hora_fin: row.hora_fin || "",
      plazas_reservadas_historicas: Number(row.plazas_prereservadas || 0),
      prereserva_expira_en: row.prereserva_expira_en || "",
      prereserva_vigente: esPrereservaVigente(row),
      plazas_pendientes: calcularPlazasReservadasPendientes(row),
      plazas_asignadas: calcularPlazasAsignadas(row)
    }));

    return json({ ok: true, data });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
