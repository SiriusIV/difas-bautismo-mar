import { getUserSession } from "./usuario/_auth.js";
import { crearNotificacion } from "./_notificaciones.js";
import { asegurarTablaHistorialReservas, registrarEventoReserva } from "./_reservas_historial.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function estadoReactivable(estado) {
  const normalizado = limpiarTexto(estado).toUpperCase();
  return normalizado === "CONFIRMADA" || normalizado === "PENDIENTE";
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    await asegurarTablaHistorialReservas(env);
    const user = await getUserSession(request, env.SECRET_KEY);
    if (!user?.id) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const reservaId = Number(body?.reserva_id || 0);
    if (!Number.isInteger(reservaId) || reservaId <= 0) {
      return json({ ok: false, error: "Falta el identificador de la solicitud." }, 400);
    }

    const db = typeof env?.DB?.withSession === "function"
      ? env.DB.withSession("first-primary")
      : env.DB;

    const reserva = await db.prepare(`
      SELECT
        r.id,
        r.usuario_id,
        r.estado,
        r.codigo_reserva,
        r.actividad_id,
        COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
        a.admin_id,
        (
          SELECT h.accion
          FROM reservas_historial_estados h
          WHERE h.reserva_id = r.id
          ORDER BY h.fecha_evento DESC, h.id DESC
          LIMIT 1
        ) AS ultima_accion,
        (
          SELECT h.estado_origen
          FROM reservas_historial_estados h
          WHERE h.reserva_id = r.id
          ORDER BY h.fecha_evento DESC, h.id DESC
          LIMIT 1
        ) AS ultimo_estado_origen,
        (
          SELECT h.observaciones
          FROM reservas_historial_estados h
          WHERE h.reserva_id = r.id
          ORDER BY h.fecha_evento DESC, h.id DESC
          LIMIT 1
        ) AS ultima_observacion
      FROM reservas r
      LEFT JOIN actividades a
        ON a.id = r.actividad_id
      WHERE r.id = ?
        AND r.usuario_id = ?
      LIMIT 1
    `).bind(reservaId, user.id).first();

    if (!reserva) {
      return json({ ok: false, error: "No se ha encontrado la solicitud." }, 404);
    }

    const estadoActual = limpiarTexto(reserva.estado).toUpperCase();
    const ultimaAccion = limpiarTexto(reserva.ultima_accion).toUpperCase();
    const estadoOrigen = limpiarTexto(reserva.ultimo_estado_origen).toUpperCase();

    if (estadoActual !== "SUSPENDIDA" || ultimaAccion !== "CAMBIO_FRANJA" || !estadoReactivable(estadoOrigen)) {
      return json({
        ok: false,
        error: "La solicitud no puede confirmarse por esta vía porque no está suspendida por un cambio de franja horaria."
      }, 400);
    }

    const update = await db.prepare(`
      UPDATE reservas
      SET estado = ?,
          fecha_modificacion = datetime('now')
      WHERE id = ?
        AND usuario_id = ?
        AND UPPER(TRIM(COALESCE(estado, ''))) = 'SUSPENDIDA'
    `).bind(estadoOrigen, reservaId, user.id).run();

    if ((update?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo confirmar el cambio de franja." }, 500);
    }

    await registrarEventoReserva(env, {
      reservaId,
      accion: "CONFIRMA_CAMBIO_FRANJA",
      estadoOrigen: "SUSPENDIDA",
      estadoDestino: estadoOrigen,
      observaciones: limpiarTexto(reserva.ultima_observacion) || "El solicitante confirma que acepta la nueva franja horaria.",
      actorUsuarioId: user.id,
      actorRol: "SOLICITANTE",
      actorNombre: user.centro || user.nombre || user.email || "Solicitante"
    });

    try {
      const adminId = Number(reserva.admin_id || 0);
      if (adminId > 0) {
        await crearNotificacion(env, {
          usuarioId: adminId,
          rolDestino: "ADMIN",
          tipo: "RESERVA",
          titulo: "Cambio de franja confirmado",
          mensaje: `${limpiarTexto(user.centro || user.nombre || "Un solicitante")} ha confirmado el cambio de franja de ${limpiarTexto(reserva.actividad_nombre || "una actividad")}${limpiarTexto(reserva.codigo_reserva) ? ` (${limpiarTexto(reserva.codigo_reserva)})` : ""}.`,
          urlDestino: Number(reserva.actividad_id || 0) > 0
            ? `/admin-reservas.html?actividad_id=${encodeURIComponent(String(reserva.actividad_id))}`
            : "/admin-reservas.html"
        });
      }
    } catch (_) {}

    return json({
      ok: true,
      mensaje: estadoOrigen === "CONFIRMADA"
        ? "Solicitud confirmada de nuevo correctamente."
        : "Solicitud devuelta a pendiente correctamente.",
      estado: estadoOrigen
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error interno al confirmar el cambio de franja.",
      detalle: error?.message || String(error || "")
    }, 500);
  }
}
