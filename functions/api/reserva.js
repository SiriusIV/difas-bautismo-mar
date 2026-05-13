import { ejecutarMantenimientoReservas } from "./_reservas_mantenimiento.js";
import { asegurarColumnaAforoMaximo, obtenerBloqueoActividadSinFranja } from "./_actividades_aforo.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function estadoBloqueaPlazas(estado) {
  return ["PENDIENTE", "CONFIRMADA", "SUSPENDIDA"].includes(String(estado || "").toUpperCase());
}

function esPrereservaVigente(expira) {
  if (!expira) return false;

  const exp = new Date(String(expira).replace(" ", "T") + "Z"); // FORZAR UTC
  const ahora = new Date(); // ya es UTC internamente

  if (Number.isNaN(exp.getTime())) return false;

  return exp.getTime() >= ahora.getTime();
}

function calcularPlazasAsignadas(row) {
  if (!estadoBloqueaPlazas(row.estado)) return 0;
  return Number(row.asistentes_cargados || 0);
}

function calcularPlazasReservadasPendientes(row) {
  if (!estadoBloqueaPlazas(row.estado)) return 0;
  if (!esPrereservaVigente(row.prereserva_expira_en)) return 0;

  const prereservadas = Number(row.plazas_prereservadas || 0);
  const asignadas = Number(row.asistentes_cargados || 0);
  return Math.max(prereservadas - asignadas, 0);
}

function calcularBloqueoReserva(row) {
  if (!estadoBloqueaPlazas(row.estado)) return 0;

  const prereservadas = Number(row.plazas_prereservadas || 0);
  const asignadas = Number(row.asistentes_cargados || 0);

  if (esPrereservaVigente(row.prereserva_expira_en)) {
    return Math.max(prereservadas, asignadas);
  }

  return asignadas;
}

async function obtenerReservaPorToken(env, tokenEdicion) {
  const sql = `
    SELECT
      r.id,
      r.franja_id,
      r.actividad_id,
      r.codigo_reserva,
      r.token_edicion,
      r.usuario_id,
      r.estado,
      r.centro,
      r.contacto,
      r.telefono,
      r.email,
      r.observaciones,
      r.personas,
      r.mayores10,
      r.menores10,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      r.fecha_solicitud,
      r.fecha_modificacion,

      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      COALESCE(a.usa_franjas, 1) AS usa_franjas,
      COALESCE(a.aforo_maximo, 0) AS aforo_maximo,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_titulo_publico,
      COALESCE(a.organizador_publico, '') AS actividad_organizador_publico,
      COALESCE(a.lugar, '') AS actividad_lugar,
      COALESCE(a.imagen_url, '') AS actividad_imagen_url,
      COALESCE(a.tipo, '') AS actividad_tipo,
      COALESCE(a.fecha_inicio, '') AS actividad_fecha_inicio,
      COALESCE(a.fecha_fin, '') AS actividad_fecha_fin,

      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_cargados

    FROM reservas r
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    WHERE r.token_edicion = ?
    LIMIT 1
  `;

  return await env.DB.prepare(sql).bind(tokenEdicion).first();
}

async function obtenerBloqueoTotalFranja(env, franjaId) {
  const sql = `
    SELECT
      r.id,
      r.estado,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_cargados
    FROM reservas r
    WHERE r.franja_id = ?
  `;

  const result = await env.DB.prepare(sql).bind(franjaId).all();
  const rows = result.results || [];

  return rows.reduce((acc, row) => acc + calcularBloqueoReserva(row), 0);
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    await asegurarColumnaAforoMaximo(env);
    await ejecutarMantenimientoReservas(env);
    const url = new URL(request.url);
    const tokenEdicion = limpiarTexto(url.searchParams.get("token"));

    if (!tokenEdicion) {
      return json(
        { ok: false, error: "Falta el token de edición." },
        { status: 400 }
      );
    }

    const reserva = await obtenerReservaPorToken(env, tokenEdicion);

    if (!reserva) {
      return json(
        { ok: false, error: "No existe ninguna solicitud con ese token." },
        { status: 404 }
      );
    }

    const usaFranjas = Number(reserva.usa_franjas || 0) === 1;
    const capacidad = usaFranjas
      ? Number(reserva.capacidad || 0)
      : Number(reserva.aforo_maximo || 0);
    const ocupadas = Number(reserva.franja_id || 0) > 0
      ? await obtenerBloqueoTotalFranja(env, reserva.franja_id)
      : await obtenerBloqueoActividadSinFranja(env, reserva.actividad_id, reserva.id);
    const disponibles = Math.max(capacidad - ocupadas, 0);

    const plazasAsignadas = calcularPlazasAsignadas(reserva);
    const plazasReservadasPendientes = calcularPlazasReservadasPendientes(reserva);
    const plazasBloqueadasActualmente = calcularBloqueoReserva(reserva);

    return json({
      ok: true,
      reserva: {
        id: reserva.id,
        franja_id: reserva.franja_id,
        actividad_id: reserva.actividad_id,
        actividad_nombre: reserva.actividad_nombre || "Actividad",
        actividad_titulo_publico: reserva.actividad_titulo_publico || reserva.actividad_nombre || "Actividad",
        actividad_organizador_publico: reserva.actividad_organizador_publico || "",
        actividad_lugar: reserva.actividad_lugar || "",
        actividad_imagen_url: reserva.actividad_imagen_url || "",
        actividad_tipo: reserva.actividad_tipo || "",
        actividad_fecha_inicio: reserva.actividad_fecha_inicio || "",
        actividad_fecha_fin: reserva.actividad_fecha_fin || "",
        codigo_reserva: reserva.codigo_reserva,
        token_edicion: reserva.token_edicion,
        estado: reserva.estado,
        centro: reserva.centro || "",
        contacto: reserva.contacto || "",
        telefono: reserva.telefono || "",
        email: reserva.email || "",
        observaciones: reserva.observaciones || "",
        personas: Number(reserva.personas || 0),
        mayores10: Number(reserva.mayores10 || 0),
        menores10: Number(reserva.menores10 || 0),
        plazas_prereservadas: Number(reserva.plazas_prereservadas || 0),
        prereserva_expira_en: reserva.prereserva_expira_en,
        prereserva_vigente: esPrereservaVigente(reserva.prereserva_expira_en),

        fecha_solicitud: reserva.fecha_solicitud,
        fecha_modificacion: reserva.fecha_modificacion,

        fecha: reserva.fecha || "",
        hora_inicio: reserva.hora_inicio || "",
        hora_fin: reserva.hora_fin || "",
        capacidad,
        aforo_maximo: Number(reserva.aforo_maximo || 0),
        usa_franjas: Number(reserva.usa_franjas || 0),

        asistentes_cargados: Number(reserva.asistentes_cargados || 0),
        plazas_asignadas: plazasAsignadas,
        plazas_reservadas: plazasReservadasPendientes,
        plazas_bloqueadas_actualmente: plazasBloqueadasActualmente,

        ocupadas,
        disponibles
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo cargar la reserva.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
