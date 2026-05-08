import { getUserSession } from "./usuario/_auth.js";
import { ejecutarMantenimientoReservas } from "./_reservas_mantenimiento.js";
import { crearNotificacion } from "./_notificaciones.js";
import { registrarEventoReserva } from "./_reservas_historial.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim().replace(/\s+/g, " ");
}

function normalizarCentroComparacion(valor) {
  return limpiarTexto(valor).toUpperCase();
}

function esEmailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generarCodigoReserva() {
  const ahora = new Date();
  const yyyy = ahora.getFullYear();
  const mm = String(ahora.getMonth() + 1).padStart(2, "0");
  const dd = String(ahora.getDate()).padStart(2, "0");
  const hh = String(ahora.getHours()).padStart(2, "0");
  const mi = String(ahora.getMinutes()).padStart(2, "0");
  const ss = String(ahora.getSeconds()).padStart(2, "0");
  const aleatorio = Math.floor(Math.random() * 9000) + 1000;
  return `R-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${aleatorio}`;
}

function generarToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function calcularMinutosConsolidacion(plazasReservadas) {
  const plazas = Number(plazasReservadas || 0);
  return 20 + (plazas * 3);
}

function accionEsGuardarBorrador(valor) {
  return limpiarTexto(valor).toLowerCase() === "guardar_borrador";
}

async function obtenerFechaExpiracionSQLite(env, minutos) {
  const row = await env.DB.prepare(`
    SELECT datetime('now', '+' || ? || ' minutes') AS expira
  `).bind(minutos).first();

  return row?.expira || null;
}


async function obtenerActividad(env, actividadId) {
  return await env.DB.prepare(`
    SELECT
      id,
      admin_id,
      COALESCE(titulo_publico, nombre, 'Actividad') AS actividad_nombre,
      activa,
      requiere_reserva,
      usa_franjas,
      aforo_limitado
    FROM actividades
    WHERE id = ?
    LIMIT 1
  `).bind(actividadId).first();
}

async function crearNotificacionNuevaSolicitudAdmin(env, {
  adminId,
  actividadId,
  actividadNombre,
  centro,
  codigoReserva
} = {}) {
  const idAdmin = Number(adminId || 0);
  if (!(idAdmin > 0)) return { ok: false, skipped: true, error: "Administrador no válido." };

  return await crearNotificacion(env, {
    usuarioId: idAdmin,
    rolDestino: "ADMIN",
    tipo: "RESERVA",
    titulo: "Nueva solicitud de actividad",
    mensaje: `${centro || "Un centro"} ha solicitado ${actividadNombre || "una actividad"}${codigoReserva ? ` (${codigoReserva})` : ""}.`,
    urlDestino: actividadId ? `/admin-reservas.html?actividad_id=${encodeURIComponent(String(actividadId))}` : "/admin-reservas.html"
  });
}

async function obtenerFranja(env, franjaId) {
  return await env.DB.prepare(`
    SELECT
      id,
      actividad_id,
      fecha,
      hora_inicio,
      hora_fin,
      capacidad
    FROM franjas
    WHERE id = ?
    LIMIT 1
  `).bind(franjaId).first();
}

async function obtenerBloqueoActualFranja(env, franjaId) {
  const sql = `
    SELECT
      COALESCE(SUM(
        CASE
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN
            CASE
              WHEN r.prereserva_expira_en IS NOT NULL
                   AND datetime('now') <= datetime(r.prereserva_expira_en)
                THEN MAX(
                  COALESCE(r.plazas_prereservadas, 0),
                  COALESCE((
                    SELECT COUNT(*)
                    FROM visitantes v
                    WHERE v.reserva_id = r.id
                  ), 0)
                )
              ELSE COALESCE((
                SELECT COUNT(*)
                FROM visitantes v
                WHERE v.reserva_id = r.id
              ), 0)
            END
          ELSE 0
        END
      ), 0) AS ocupadas
    FROM reservas r
    WHERE r.franja_id = ?
  `;

  const row = await env.DB.prepare(sql).bind(franjaId).first();
  return Number(row?.ocupadas || 0);
}

async function existeSolicitudActivaMismoCentroFranja(env, franjaId, centroComparacion) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado
    FROM reservas r
    WHERE r.franja_id = ?
      AND UPPER(TRIM(r.centro)) = ?
      AND (
        r.estado = 'CONFIRMADA'
        OR (
          r.estado = 'PENDIENTE'
          AND (
            (
              r.prereserva_expira_en IS NOT NULL
              AND datetime('now') <= datetime(r.prereserva_expira_en)
            )
            OR EXISTS (
              SELECT 1
              FROM visitantes v
              WHERE v.reserva_id = r.id
              LIMIT 1
            )
          )
        )
      )
    LIMIT 1
  `;

  return await env.DB.prepare(sql)
    .bind(franjaId, centroComparacion)
    .first();
}

async function existeSolicitudActivaMismoCentroActividadSinFranja(env, actividadId, centroComparacion) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado
    FROM reservas r
    WHERE r.actividad_id = ?
      AND r.franja_id IS NULL
      AND UPPER(TRIM(r.centro)) = ?
      AND (
        r.estado = 'CONFIRMADA'
        OR (
          r.estado = 'PENDIENTE'
          AND (
            (
              r.prereserva_expira_en IS NOT NULL
              AND datetime('now') <= datetime(r.prereserva_expira_en)
            )
            OR EXISTS (
              SELECT 1
              FROM visitantes v
              WHERE v.reserva_id = r.id
              LIMIT 1
            )
          )
        )
      )
    LIMIT 1
  `;

  return await env.DB.prepare(sql)
    .bind(actividadId, centroComparacion)
    .first();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    await ejecutarMantenimientoReservas(env);
    const sessionUser = await getUserSession(request, env.SECRET_KEY);
    const usuarioId = sessionUser?.id || null;

    const data = await request.json();

    const actividadId = parseInt(data.actividad_id, 10);
    const centro = limpiarTexto(data.centro);
    const contacto = limpiarTexto(data.contacto);
    const telefono = limpiarTexto(data.telefono);
    const email = limpiarTexto(data.email);
    const observaciones = limpiarTexto(data.observaciones);
    const guardarComoBorrador = accionEsGuardarBorrador(data.accion);
    const franjaRaw = data.franja;
    const franjaId = franjaRaw == null || String(franjaRaw).trim() === ""
      ? null
      : parseInt(franjaRaw, 10);
    const plazasReservadas = parseInt(data.plazas_solicitadas, 10);

    if (!Number.isInteger(actividadId) || actividadId <= 0) {   
      return json(
        { ok: false, error: "La actividad indicada no es válida." },
        { status: 400 }
      );
    }

const actividad = await obtenerActividad(env, actividadId);

if (!actividad) {
  return json(
    { ok: false, error: "La actividad indicada no existe." },
    { status: 404 }
  );
}

if (Number(actividad.requiere_reserva || 0) !== 1) {
  return json(
    { ok: false, error: "Esta actividad no admite reservas." },
    { status: 400 }
  );
}
if (Number(actividad.activa || 0) !== 1) {
  return json(
    { ok: false, error: "Esta actividad estÃ¡ desactivada y no admite nuevas solicitudes." },
    { status: 400 }
  );
}
    const usaFranjas = Number(actividad.usa_franjas || 0) === 1;

    if (!centro || !contacto || !telefono || !email) {
      return json(
        { ok: false, error: "Faltan datos obligatorios del solicitante." },
        { status: 400 }
      );
    }

    if (!esEmailValido(email)) {
      return json(
        { ok: false, error: "El correo electrónico no tiene un formato válido." },
        { status: 400 }
      );
    }

    if (usaFranjas && (!Number.isInteger(franjaId) || franjaId <= 0)) {
      return json(
        { ok: false, error: "La franja horaria indicada no es válida." },
        { status: 400 }
      );
    }

    if (!Number.isInteger(plazasReservadas) || plazasReservadas <= 0) {
      return json(
        { ok: false, error: "Debe indicar un número válido de plazas a reservar." },
        { status: 400 }
      );
    }

    const centroComparacion = normalizarCentroComparacion(centro);
    let franja = null;
    let duplicada = null;
    let capacidad = null;
    let disponibles = null;

    if (usaFranjas) {
      franja = await obtenerFranja(env, franjaId);

      if (!franja) {
        return json(
          { ok: false, error: "La franja seleccionada no existe." },
          { status: 404 }
        );
      }

      if (Number(franja.actividad_id || 0) !== actividadId) {
        return json(
          { ok: false, error: "La franja seleccionada no pertenece a la actividad indicada." },
          { status: 400 }
        );
      }

      duplicada = await existeSolicitudActivaMismoCentroFranja(env, franjaId, centroComparacion);
      const ocupadas = await obtenerBloqueoActualFranja(env, franjaId);
      capacidad = Number(franja.capacidad || 0);
      disponibles = Math.max(capacidad - ocupadas, 0);
    } else {
      duplicada = await existeSolicitudActivaMismoCentroActividadSinFranja(env, actividadId, centroComparacion);
    }

    if (!guardarComoBorrador && duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe una solicitud activa para este centro en la franja seleccionada. Debe modificar la existente, no crear una segunda."
        },
        { status: 409 }
      );
    }

    if (usaFranjas && plazasReservadas > disponibles) {
      return json(
        {
          ok: false,
          error: `No hay plazas suficientes en la franja seleccionada. Disponibles: ${disponibles}. Solicitadas: ${plazasReservadas}.`
        },
        { status: 400 }
      );
    }

    const codigoReserva = generarCodigoReserva();
    const tokenEdicion = generarToken();
    const minutosConsolidacion = calcularMinutosConsolidacion(plazasReservadas);
    const prereservaExpiraEn = guardarComoBorrador
      ? null
      : await obtenerFechaExpiracionSQLite(env, minutosConsolidacion);

    if (!guardarComoBorrador && !prereservaExpiraEn) {
      return json(
        { ok: false, error: "No se pudo calcular la expiración de la prereserva." },
        { status: 500 }
      );
    }

    const sqlInsert = `
      INSERT INTO reservas (
        franja_id,
        actividad_id,
        codigo_reserva,
        token_edicion,
        estado,
        centro,
        contacto,
        telefono,
        email,
        observaciones,
        plazas_prereservadas,
        prereserva_expira_en,
        fecha_solicitud,
        fecha_modificacion,
        usuario_id
      )
      VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        datetime('now'),
        datetime('now'),
        ?
      )
    `;

    const result = await env.DB.prepare(sqlInsert)
      .bind(
        franjaId,
        actividadId,
        codigoReserva,
        tokenEdicion,
        guardarComoBorrador ? "BORRADOR" : "PENDIENTE",
        centro,
        contacto,
        telefono,
        email,
        observaciones,
        plazasReservadas,
        prereservaExpiraEn,
        usuarioId
      )
      .run();

    if ((result?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo crear la solicitud." },
        { status: 500 }
      );
    }

    const reservaCreada = await env.DB.prepare(`
      SELECT
        id,
        codigo_reserva,
        token_edicion,
        estado,
        franja_id,
        actividad_id,
        plazas_prereservadas,
        prereserva_expira_en,
        usuario_id
      FROM reservas
      WHERE token_edicion = ?
      LIMIT 1
    `).bind(tokenEdicion).first();

    if (!guardarComoBorrador) {
      await registrarEventoReserva(env, {
        reservaId: reservaCreada?.id,
        accion: "SOLICITUD_PRESENTADA",
        estadoOrigen: null,
        estadoDestino: "PENDIENTE",
        observaciones,
        actorUsuarioId: usuarioId,
        actorRol: "SOLICITANTE",
        actorNombre: contacto || centro || "Solicitante"
      });
    }

    let notificacionAdmin = { ok: false, skipped: true, error: "" };
    if (!guardarComoBorrador) {
      try {
        notificacionAdmin = await crearNotificacionNuevaSolicitudAdmin(env, {
          adminId: actividad.admin_id,
          actividadId,
          actividadNombre: actividad.actividad_nombre || "Actividad",
          centro,
          codigoReserva: reservaCreada?.codigo_reserva || codigoReserva
        });
      } catch (errorNotificacion) {
        notificacionAdmin = {
          ok: false,
          skipped: true,
          error: errorNotificacion?.message || String(errorNotificacion || "")
        };
      }
    }

    return json({
      ok: true,
      mensaje: guardarComoBorrador ? "Borrador guardado correctamente." : "Solicitud creada correctamente.",
      codigo_reserva: reservaCreada.codigo_reserva,
      token_edicion: reservaCreada.token_edicion,
      estado: reservaCreada.estado,
      franja: franja ? {
        id: franja.id,
        actividad_id: franja.actividad_id,
        fecha: franja.fecha,
        hora_inicio: franja.hora_inicio,
        hora_fin: franja.hora_fin,
        capacidad
      } : null,
      plazas_reservadas: plazasReservadas,
      plazas_disponibles_restantes: usaFranjas ? Math.max(disponibles - plazasReservadas, 0) : null,
      minutos_consolidacion: guardarComoBorrador ? 0 : minutosConsolidacion,
      prereserva_expira_en: reservaCreada.prereserva_expira_en,
      usuario_id: reservaCreada.usuario_id,
      notificacion_admin: {
        creada: !!notificacionAdmin.ok,
        error: notificacionAdmin.ok ? "" : (notificacionAdmin.error || "")
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error interno al crear la solicitud.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
