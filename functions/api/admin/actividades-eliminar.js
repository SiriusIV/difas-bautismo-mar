import { getAdminSession } from "./_auth.js";
import { crearNotificacion } from "../_notificaciones.js";
import { crearAvisoUsuario } from "../_avisos_usuario.js";
import { enviarEmail } from "../_email.js";
import { asegurarTablaHistorialReservas, borrarHistorialReservas, registrarEventoReserva } from "../_reservas_historial.js";
import { eliminarDocumentacionDeReserva } from "../_documentacion_contextual.js";
import { asegurarColumnaRechazoBloqueado } from "../_reservas_rechazo_plazo.js";

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

function dbPrimaria(env) {
  if (typeof env?.DB?.withSession === "function") {
    return env.DB.withSession("first-primary");
  }
  return env.DB;
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
  const result = await dbPrimaria(env).prepare(`
    SELECT
      r.id,
      r.estado
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.actividad_id = ?
      AND (
        (f.id IS NOT NULL AND f.fecha IS NOT NULL AND datetime(f.fecha || ' ' || COALESCE(NULLIF(f.hora_inicio, ''), '00:00')) > datetime('now'))
        OR (f.id IS NULL AND a.fecha_inicio IS NOT NULL AND date(a.fecha_inicio) >= date('now'))
        OR (f.id IS NULL AND a.fecha_inicio IS NULL)
      )
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
    resumen.totalAfectables += 1;
  }

  return resumen;
}

async function obtenerReservasAfectablesActividad(env, actividadId) {
  const result = await dbPrimaria(env).prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.codigo_reserva,
      r.contacto,
      COALESCE(NULLIF(TRIM(r.email), ''), NULLIF(TRIM(us.email), '')) AS email,
      r.estado,
      COALESCE(a.organizador_publico, 'Organizador') AS organizador_nombre,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN usuarios us
      ON us.id = r.usuario_id
    WHERE r.actividad_id = ?
      AND (
        (f.id IS NOT NULL AND f.fecha IS NOT NULL AND datetime(f.fecha || ' ' || COALESCE(NULLIF(f.hora_inicio, ''), '00:00')) > datetime('now'))
        OR (f.id IS NULL AND a.fecha_inicio IS NOT NULL AND date(a.fecha_inicio) >= date('now'))
        OR (f.id IS NULL AND a.fecha_inicio IS NULL)
      )
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
    ? "[Reservas] Actividad anulada y borrador eliminado"
    : "[Reservas] Actividad desactivada y solicitud rechazada";
  const mensaje = esBorrador
    ? `Tu borrador para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido eliminado porque la actividad ha sido anulada por ${organizador}.`
    : `Tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido rechazada porque la actividad ha sido desactivada por ${organizador}.`;

  const texto = [
    saludo,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Organiza: ${organizador}`,
    motivo ? `Motivo de la anulación: ${motivo}` : "",
    "",
    esBorrador
      ? "Ya no es necesario realizar ninguna otra accin sobre este borrador."
      : "Esta solicitud no puede reenviarse porque la actividad ya no está ofertada."
  ].filter(Boolean).join("\n");

  const html = `
    <p>${escaparHtml(saludo)}</p>
    <p>${escaparHtml(mensaje)}</p>
    <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
    ${codigo ? `<p><strong>Código de solicitud:</strong> ${escaparHtml(codigo)}</p>` : ""}
    <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
    ${motivo ? `<p><strong>Motivo de la anulación:</strong> ${escaparHtml(motivo)}</p>` : ""}
    <p>${escaparHtml(esBorrador
      ? "Ya no es necesario realizar ninguna otra accin sobre este borrador."
      : "Esta solicitud no puede reenviarse porque la actividad ya no está ofertada.")}</p>
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
    ? `La actividad ${actividad}${codigo ? ` asociada a tu borrador (${codigo})` : ""} ha sido anulada por el organizador y tu borrador ha sido eliminado.`
    : `La actividad ${actividad}${codigo ? ` asociada a tu solicitud (${codigo})` : ""} ha sido desactivada por el organizador y tu solicitud ha quedado rechazada. No puede reenviarse porque la actividad ya no está ofertada.`;
  const mensaje = motivo ? `${mensajeBase} Motivo: ${motivo}` : mensajeBase;

  const payload = {
    usuarioId,
    rolDestino: "SOLICITANTE",
    tipo: "RESERVA",
    titulo: esBorrador ? "Actividad anulada" : "Solicitud rechazada por desactivación de actividad",
    mensaje,
    urlDestino: "/usuario-panel.html"
  };

  const resultado = await crearNotificacion(env, payload);
  if (resultado?.ok || resultado?.skipped) {
    return resultado;
  }

  try {
    const db = dbPrimaria(env);
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS notificaciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER NOT NULL,
        rol_destino TEXT,
        tipo TEXT,
        titulo TEXT NOT NULL,
        mensaje TEXT,
        url_destino TEXT,
        leida INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        leida_at TEXT
      )
    `).run();

    const insert = await db.prepare(`
      INSERT INTO notificaciones (
        usuario_id,
        rol_destino,
        tipo,
        titulo,
        mensaje,
        url_destino,
        leida,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
    `).bind(
      usuarioId,
      "SOLICITANTE",
      "RESERVA",
      esBorrador ? "Actividad anulada" : "Solicitud rechazada por desactivación de actividad",
      mensaje,
      "/usuario-panel.html"
    ).run();

    if (Number(insert?.meta?.changes || 0) > 0) {
      return { ok: true, fallback: true };
    }
  } catch (fallbackError) {
    return {
      ok: false,
      skipped: false,
      error: `${resultado?.error || "No se pudo crear la notificacin."} Fallback: ${fallbackError?.message || String(fallbackError || "")}`
    };
  }

  return resultado;
}

async function crearAvisoOperativoBorradorEliminado(env, reserva, observacionesAdmin) {
  const usuarioId = Number(reserva?.usuario_id || 0);
  if (!(usuarioId > 0)) {
    return { ok: false, skipped: true, error: "Borrador sin usuario asociado." };
  }

  const actividad = limpiarTexto(reserva?.actividad_nombre || "la actividad");
  const codigo = limpiarTexto(reserva?.codigo_reserva || "");
  const motivo = limpiarTexto(observacionesAdmin);
  const mensajeBase = `La actividad ${actividad}${codigo ? ` asociada a tu borrador (${codigo})` : ""} ha sido anulada por el organizador y tu borrador ha sido eliminado.`;
  const mensaje = motivo ? `${mensajeBase} Motivo: ${motivo}` : mensajeBase;

  return await crearAvisoUsuario(env, {
    usuarioId,
    tipo: "RESERVA",
    titulo: "Borrador eliminado por anulacin de actividad",
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
  const db = typeof env?.DB?.withSession === "function"
    ? env.DB.withSession("first-primary")
    : env.DB;
  await asegurarColumnaRechazoBloqueado(env);
  const reservas = await obtenerReservasAfectablesActividad(env, actividadId);
  const resultado = {
    total: reservas.length,
    actualizadas: 0,
    borradores_eliminados: 0,
    reservas_eliminadas: 0,
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

      if (esBorrador) {
        await borrarHistorialReservas(env, [reserva.id]);
        await eliminarDocumentacionDeReserva(env, reserva.id);
        await db.prepare(`
          DELETE FROM visitantes
          WHERE reserva_id = ?
        `).bind(reserva.id).run();

        const borrado = await db.prepare(`
          DELETE FROM reservas
          WHERE id = ?
        `).bind(reserva.id).run();

        if ((borrado?.meta?.changes || 0) > 0) {
          resultado.actualizadas += 1;
          resultado.borradores_eliminados += 1;
        } else {
          resultado.incidencias.push(`Reserva ${reserva.id}: no se pudo eliminar el borrador tras la anulación de la actividad.`);
          continue;
        }
      } else {
        const actualizado = await db.prepare(`
          UPDATE reservas
          SET estado = 'RECHAZADA',
              observaciones_admin = ?,
              rechazo_elimina_en = NULL,
              rechazo_bloqueado = 1,
              fecha_modificacion = datetime('now')
          WHERE id = ?
        `).bind(observacionesAdmin, reserva.id).run();

        if ((actualizado?.meta?.changes || 0) > 0) {
          resultado.actualizadas += 1;
        } else {
          resultado.incidencias.push(`Reserva ${reserva.id}: no se pudo marcar como rechazada tras la desactivación de la actividad.`);
          continue;
        }

        await registrarEventoReserva(env, {
          reservaId: reserva.id,
          accion: "ANULACION_ACTIVIDAD",
          estadoOrigen,
          estadoDestino: "RECHAZADA",
          observaciones: observacionesAdmin,
          actorUsuarioId: actor?.actorUsuarioId || null,
          actorRol: actor?.actorRol || "ADMIN",
          actorNombre: reserva?.organizador_nombre || "Organizador"
        });

        try {
          const notificacion = await crearNotificacionActividadAnulada(env, { ...reserva, estado: "RECHAZADA" }, observacionesAdmin);
          if (notificacion?.ok) resultado.notificaciones_creadas += 1;
          else if (!notificacion?.skipped) resultado.incidencias.push(`Notificación reserva ${reserva.id}: ${notificacion?.error || "error desconocido"}`);
        } catch (errorNotificacion) {
          resultado.incidencias.push(`Notificación reserva ${reserva.id}: ${errorNotificacion?.message || String(errorNotificacion || "")}`);
        }
      }

      try {
        const correo = await enviarCorreoActividadAnulada(env, reserva, observacionesAdmin);
        if (correo?.ok) {
          resultado.correos_enviados += 1;
        } else if (!correo?.skipped) {
          resultado.incidencias.push(`Correo reserva ${reserva.id}: ${correo?.error || "error desconocido"}`);
        }
      } catch (errorCorreo) {
        resultado.incidencias.push(`Correo reserva ${reserva.id}: ${errorCorreo?.message || String(errorCorreo || "")}`);
      }
    } catch (error) {
      resultado.incidencias.push(`Reserva ${reserva.id}: ${error?.message || String(error || "")}`);
    }
  }

  return resultado;
}

async function borrarActividadFisicamente(env, actividadId) {
  await asegurarTablaHistorialReservas(env);
  const reservasProtegidas = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.actividad_id = ?
      AND (
        (f.id IS NOT NULL AND f.fecha IS NOT NULL AND datetime(f.fecha || ' ' || COALESCE(NULLIF(f.hora_inicio, ''), '00:00')) <= datetime('now'))
        OR (f.id IS NULL AND a.fecha_inicio IS NOT NULL AND date(a.fecha_inicio) < date('now'))
      )
  `).bind(actividadId).first();

  if (Number(reservasProtegidas?.total || 0) > 0) {
    const result = await env.DB.prepare(`
      UPDATE actividades
      SET activa = 0,
          visible_portal = 0
      WHERE id = ?
    `).bind(actividadId).run();
    return {
      ...result,
      preservada_por_historico: true
    };
  }

  const reservasActividad = await env.DB.prepare(`
    SELECT id
    FROM reservas
    WHERE actividad_id = ?
  `).bind(actividadId).all();
  const reservaIds = (reservasActividad?.results || []).map((row) => Number(row.id || 0)).filter(Boolean);
  await borrarHistorialReservas(env, reservaIds);
  for (const reservaId of reservaIds) {
    await eliminarDocumentacionDeReserva(env, reservaId);
  }

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
    // La tabla puede no existir todavía en entornos sin requisitos particulares.
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
      return json({ ok: false, error: "ID de actividad no válido." }, 400);
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
        mensaje: "Si continúas, los borradores futuros vinculados a esta actividad se eliminarán y el resto de solicitudes futuras pasarán a estar rechazadas sin posibilidad de reenvío. Se enviará un correo individual a cada solicitante afectado."
      }, 200);
    }

    if (hayReservasAfectables && !observacionesAdmin) {
      return json({
        ok: false,
        error: "Debes indicar el motivo de la anulación para rechazar las solicitudes futuras afectadas."
      }, 400);
    }

    if (hayReservasAfectables) {
      const rechazoMasivo = await rechazarReservasPorAnulacionActividad(env, id, observacionesAdmin, {
        actorUsuarioId: session.usuario_id,
        actorRol: rol
      });
      const result = await dbPrimaria(env).prepare(`
        UPDATE actividades
        SET activa = 0,
            visible_portal = 0
        WHERE id = ?
      `).bind(id).run();

      if ((result?.meta?.changes || 0) === 0) {
        return json({ ok: false, error: "No se pudo desactivar la actividad." }, 500);
      }

      return json({
        ok: true,
        actividad_anulada: true,
        actividad_eliminada: false,
        actividad_preservada_historico: true,
        mensaje: "Actividad desactivada y ocultada para preservar el histórico. Las solicitudes futuras afectadas han sido rechazadas y se han enviado los correos correspondientes.",
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
      actividad_eliminada: !result?.preservada_por_historico,
      actividad_preservada_historico: !!result?.preservada_por_historico,
      mensaje: result?.preservada_por_historico
        ? "Actividad desactivada y ocultada para preservar el histórico."
        : "Actividad eliminada correctamente."
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al eliminar o anular la actividad.", detalle: error.message },
      500
    );
  }
}
