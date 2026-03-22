import { getUserSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function estadoBloqueaPlazas(estado) {
  return ["PENDIENTE", "CONFIRMADA"].includes(String(estado || "").toUpperCase());
}

function esPrereservaVigente(expira) {
  if (!expira) return false;

  const d = new Date(String(expira).replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return false;

  return d.getTime() >= Date.now();
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

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const user = await getUserSession(request, env.SECRET_KEY);

    if (!user || !user.id) {
      return json({ ok: false, authenticated: false }, 401);
    }

    const result = await env.DB.prepare(`
      SELECT
        r.id,
        r.codigo_reserva,
        r.estado,
        r.token_edicion,
        r.observaciones,
        r.plazas_prereservadas,
        r.prereserva_expira_en,
        f.fecha,
        f.hora_inicio,
        f.hora_fin,
        COALESCE((
          SELECT COUNT(*)
          FROM visitantes v
          WHERE v.reserva_id = r.id
        ), 0) AS asistentes_cargados,
        COALESCE(a.nombre, 'Actividad') AS actividad
      FROM reservas r
      LEFT JOIN franjas f ON r.franja_id = f.id
      LEFT JOIN actividades a ON r.actividad_id = a.id
      WHERE r.usuario_id = ?
      ORDER BY f.fecha DESC, f.hora_inicio DESC
    `).bind(user.id).all();

    const rows = result.results || [];

    const data = rows.map(row => ({
      id: row.id,
      codigo_reserva: row.codigo_reserva,
      estado: row.estado,
      token_edicion: row.token_edicion || "",
      observaciones: row.observaciones || "",
      actividad: row.actividad || "Actividad",
      fecha: row.fecha,
      hora_inicio: row.hora_inicio,
      hora_fin: row.hora_fin,
      plazas_reservadas_historicas: Number(row.plazas_prereservadas || 0),
      plazas_pendientes: calcularPlazasReservadasPendientes(row),
      plazas_asignadas: calcularPlazasAsignadas(row)
    }));

    return json({ ok: true, data });
  } catch (error) {
    return json({ ok: false, error: error.message }, 500);
  }
}
