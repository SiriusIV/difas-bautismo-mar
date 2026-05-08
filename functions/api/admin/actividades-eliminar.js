import { getAdminSession } from "./_auth.js";
import { crearNotificacion } from "../_notificaciones.js";
import { enviarEmail } from "../_email.js";
import { asegurarTablaHistorialReservas, borrarHistorialReservas, registrarEventoReserva } from "../_reservas_historial.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function esErrorColumnaDuplicada(error) {
  const texto = limpiarTexto(error?.message || error || "").toLowerCase();
  return texto.includes("duplicate column name") || texto.includes("duplicate column");
}

export async function asegurarColumnaObservacionesAdmin(env) {
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

async function obtenerRol(env, usuario_id) {
  const row = await env.DB.prepare(`
    SELECT rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(usuario_id).first();

  return row?.rol || null;
}

async function obtenerActividad(env, id) {
  return await env.DB.prepare(`
    SELECT *
    FROM actividades
    WHERE id = ?
    LIMIT 1
  `).bind(id).first();
}

export async function obtenerSituacionReservasActividad(env, actividadId) {
  const result = await env.DB.prepare(`
    SELECT
      r.id,
      r.estado
    FROM reservas r
    WHERE r.actividad_id = ?
  `).bind(actividadId).all();

  const rows = result?.results || [];
  const resumen = {
    borradores: 0,
    pendientes: 0,
    confirmadas: 0,
    suspendidas: 0,
    canceladas: 0,
    rechazadas: 0,
    totalAfectables: 0,
    totalReservas: rows.length
  };

  for (const row of rows) {
    const estado = limpiarTexto(row.estado).toUpperCase();
    if (estado === "BORRADOR") resumen.borradores += 1;
    if (estado === "PENDIENTE") resumen.pendientes += 1;
    if (estado === "CONFIRMADA") resumen.confirmadas += 1;
    if (estado === "SUSPENDIDA") resumen.suspendidas += 1;
    if (estado === "CANCELADA") resumen.canceladas += 1;
    if (estado === "RECHAZADA") resumen.rechazadas += 1;
    if (["BORRADOR", "PENDIENTE", "CONFIRMADA", "SUSPENDIDA"].includes(estado)) {
      resumen.totalAfectables += 1;
    }
  }

  return resumen;
}

async function obtenerReservasAfectablesActividad(env, actividadId) {
  const result = await env.DB.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.codigo_reserva,
      r.contacto,
      r.email,
      r.estado,
      COALESCE(a.organizador_publico, 'Organizador') AS organizador_nombre,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    WHERE r.actividad_id = ?
      AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('BORRADOR', 'PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
    ORDER BY r.id ASC
  `).bind(actividadId).all();

  return result?.results || [];
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function construirCorreoActividadAnulada(contexto = {}, observacionesAdmin = "") {
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const organizador = limpiarTexto(contexto?.organizador_nombre || "el organizador");
  const contacto = limpiarTexto(contexto?.contacto || "");
  const motivo = limpiarTexto(observacionesAdmin);
  const estado = limpiarTexto(contexto?.estado).toUpperCase();
  const esBorrador = estado === "BORRADOR";
  const saludo = contacto ? `Hola ${contacto},` : "Hola,";
  const asunto = esBorrador
    ? "[Reservas] Actividad anulada y borrador afectado"
    : "[Reservas] Actividad anulada y solicitud rechazada";
  const mensaje = esBorrador
    ? `Tu borrador para ${actividad}${codigo ? ` (${codigo})` : ""} ya no puede enviarse mientras la actividad permanezca anulada por ${organizador}.`
    : `Tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido rechazada porque la actividad ha sido anulada por ${organizador}.`;

  const texto = [
    saludo,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `CÃ³digo de solicitud: ${codigo}` : "",
    `Organiza: ${organizador}`,
    motivo ? `Motivo de la anulaciÃ³n: ${motivo}` : "",
    "",
    "Puedes consultar el estado actualizado desde tu panel de usuario."
  ].filter(Boolean).join("\n");

  const html = `
    <p>${escaparHtml(saludo)}</p>
    <p>${escaparHtml(mensaje)}</p>
    <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
    ${codigo ? `<p><strong>CÃ³digo de solicitud:</strong> ${escaparHtml(codigo)}</p>` : ""}
    <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
    ${motivo ? `<p><strong>Motivo de la anulaciÃ³n:</strong> ${escaparHtml(motivo)}</p>` : ""}
    <p>Puedes consultar el estado actualizado desde tu panel de usuario.</p>
  `;

  return { asunto, texto, html };
}

async function crearNotificacionActividadAnulada(env, reserva, observacionesAdmin) {
  const usuarioId = Number(reserva?.usuario_id || 0);
  if (!(usuarioId > 0)) {
    return { ok: false, skipped: true, error: "Solicitud sin usuario asociado." };
  }

  const actividad = limpiarTexto(reserva?.actividad_nombre || "la actividad");
  const codigo = limpiarTexto(reserva?.codigo_reserva || "");
  const motivo = limpiarTexto(observacionesAdmin);
  const estado = limpiarTexto(reserva?.estado).toUpperCase();
  const esBorrador = estado === "BORRADOR";
  const mensajeBase = esBorrador
    ? `La actividad ${actividad}${codigo ? ` asociada a tu borrador (${codigo})` : ""} ha sido anulada por el organizador. Tu borrador queda afectado y no podrÃ¡ enviarse mientras la actividad permanezca anulada.`
    : `La actividad ${actividad}${codigo ? ` asociada a tu solicitud (${codigo})` : ""} ha sido anulada por el organizador y tu solicitud ha pasado a rechazada.`;
  const mensaje = motivo ? `${mensajeBase} Motivo: ${motivo}` : mensajeBase;

  return await crearNotificacion(env, {
    usuarioId,
    rolDestino: "SOLICITANTE",
    tipo: "RESERVA",
    titulo: "Actividad anulada",
    mensaje,
    urlDestino: "/usuario-panel.html"
  });
}

async function enviarCorreoActividadAnulada(env, reserva, observacionesAdmin) {
  const destinatario = limpiarTexto(reserva?.email || "");
  if (!destinatario) {
    return { ok: false, skipped: true, error: "La solicitud no tiene correo de contacto." };
  }

  const correo = construirCorreoActividadAnulada(reserva, observacionesAdmin);
  return await enviarEmail(env, {
    to: destinatario,
    subject: correo.asunto,
    text: correo.texto,
    html: correo.html
  });
}

export async function rechazarReservasPorAnulacionActividad(env, actividadId, observacionesAdmin, actor = {}) {
  const reservas = await obtenerReservasAfectablesActividad(env, actividadId);
  const resultado = {
    total: reservas.length,
    actualizadas: 0,
    notificaciones_creadas: 0,
    correos_enviados: 0,
    incidencias: []
  };

  if (!reservas.length) {
    return resultado;
  }

  for (const reserva of reservas) {
    try {
      const estadoOrigen = limpiarTexto(reserva?.estado).toUpperCase();
      const esBorrador = estadoOrigen === "BORRADOR";
      const update = await env.DB.prepare(`
        UPDATE reservas
        SET estado = CASE
              WHEN UPPER(TRIM(COALESCE(estado, ''))) = 'BORRADOR' THEN 'BORRADOR'
              ELSE 'RECHAZADA'
            END,
            observaciones_admin = ?,
            fecha_modificacion = datetime('now')
        WHERE id = ?
          AND UPPER(TRIM(COALESCE(estado, ''))) IN ('BORRADOR', 'PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
      `).bind(observacionesAdmin, reserva.id).run();

      if ((update?.meta?.changes || 0) > 0) {
        resultado.actualizadas += 1;
        if (!esBorrador) {
          await registrarEventoReserva(env, {
            reservaId: reserva.id,
            accion: "ANULACION_ACTIVIDAD",
            estadoOrigen: reserva.estado,
            estadoDestino: "RECHAZADA",
            observaciones: observacionesAdmin,
            actorUsuarioId: actor.actorUsuarioId,
            actorRol: actor.actorRol,
            actorNombre: actor.actorNombre
          });
        }
      }

      const [notificacion, correo] = await Promise.all([
        crearNotificacionActividadAnulada(env, reserva, observacionesAdmin),
        enviarCorreoActividadAnulada(env, reserva, observacionesAdmin)
      ]);

      if (notificacion?.ok) resultado.notificaciones_creadas += 1;
      if (correo?.ok) resultado.correos_enviados += 1;

      if (!notificacion?.ok && !notificacion?.skipped) {
        resultado.incidencias.push(`NotificaciÃ³n reserva ${reserva.id}: ${notificacion?.error || "error desconocido"}`);
      }
      if (!correo?.ok && !correo?.skipped) {
        resultado.incidencias.push(`Correo reserva ${reserva.id}: ${correo?.error || "error desconocido"}`);
      }
    } catch (error) {
      resultado.incidencias.push(`Reserva ${reserva.id}: ${error?.message || String(error || "")}`);
    }
  }

  return resultado;
}

async function borrarActividadFisicamente(env, actividadId) {
  await asegurarTablaHistorialReservas(env);
  const reservasActividad = await env.DB.prepare(`
    SELECT id
    FROM reservas
    WHERE actividad_id = ?
  `).bind(actividadId).all();
  const reservaIds = (reservasActividad?.results || []).map((row) => Number(row.id || 0)).filter(Boolean);
  await borrarHistorialReservas(env, reservaIds);

  await env.DB.prepare(`
    DELETE FROM visitantes
    WHERE reserva_id IN (
      SELECT id
      FROM reservas
      WHERE actividad_id = ?
    )
  `).bind(actividadId).run();

  await env.DB.prepare(`
    DELETE FROM reservas
    WHERE actividad_id = ?
  `).bind(actividadId).run();

  await env.DB.prepare(`
    DELETE FROM franjas
    WHERE actividad_id = ?
  `).bind(actividadId).run();

  try {
    await env.DB.prepare(`
      DELETE FROM actividad_requisitos
      WHERE actividad_id = ?
    `).bind(actividadId).run();
  } catch (_) {
    // La tabla puede no existir todavÃ­a en entornos sin requisitos particulares.
  }

  return await env.DB.prepare(`
    DELETE FROM actividades
    WHERE id = ?
  `).bind(actividadId).run();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    await asegurarColumnaObservacionesAdmin(env);
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const id = parsearIdPositivo(body.id);
    const confirmado = body.confirmado === true || body.confirmado === 1 || body.confirmado === "1";
    const observacionesAdmin = limpiarTexto(body.observaciones_admin || "");

    if (!id) {
      return json({ ok: false, error: "ID de actividad no vÃ¡lido." }, 400);
    }

    const actividad = await obtenerActividad(env, id);
    if (!actividad) {
      return json({ ok: false, error: "La actividad no existe." }, 404);
    }

    const rol = await obtenerRol(env, session.usuario_id);
    if (rol !== "SUPERADMIN" && Number(actividad.admin_id || 0) !== Number(session.usuario_id)) {
      return json({ ok: false, error: "No autorizado para eliminar esta actividad." }, 403);
    }

    const situacion = await obtenerSituacionReservasActividad(env, id);
    const hayReservasAfectables = situacion.totalAfectables > 0;

    if (hayReservasAfectables && !confirmado) {
      return json({
        ok: false,
        requiere_confirmacion: true,
        requiere_observaciones: true,
        resumen: situacion,
        mensaje: `La actividad tiene ${situacion.totalAfectables} solicitud(es) afectada(s) en estado borrador, pendiente, aceptada o suspendida. Si continÃºas, todas pasarÃ¡n automÃ¡ticamente a rechazada y se notificarÃ¡ individualmente a cada solicitante afectado.`
      }, 200);
    }

    if (hayReservasAfectables && !observacionesAdmin) {
      return json({
        ok: false,
        error: "Debes indicar el motivo de la anulaciÃ³n para rechazar automÃ¡ticamente las solicitudes afectadas."
      }, 400);
    }

    if (hayReservasAfectables) {
      const rechazoMasivo = await rechazarReservasPorAnulacionActividad(env, id, observacionesAdmin, {
        actorUsuarioId: session.usuario_id,
        actorRol: rol
      });
      const result = await borrarActividadFisicamente(env, id);

      if ((result?.meta?.changes || 0) === 0) {
        return json({ ok: false, error: "No se pudo eliminar la actividad." }, 500);
      }

      return json({
        ok: true,
        actividad_anulada: true,
        actividad_eliminada: true,
        mensaje: "Actividad eliminada correctamente. Las solicitudes afectadas han sido anuladas y se han emitido las notificaciones correspondientes.",
        resumen_reservas: rechazoMasivo
      });
    }

    const result = await borrarActividadFisicamente(env, id);
    if ((result?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo eliminar la actividad." }, 500);
    }

    return json({
      ok: true,
      actividad_anulada: false,
      mensaje: situacion.totalReservas > 0
        ? "Actividad eliminada correctamente."
        : "Actividad eliminada correctamente."
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al eliminar o anular la actividad.", detalle: error.message },
      500
    );
  }
}

