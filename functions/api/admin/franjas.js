import { requireAdminSession, getAdminSession } from "./_auth.js";
import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";
import { checkAdminActividad } from "./_permisos.js";
import { crearNotificacion } from "../_notificaciones.js";
import { enviarEmail } from "../_email.js";
import { borrarHistorialReservas, registrarEventoReserva } from "../_reservas_historial.js";
import { obtenerInicioReserva } from "../_reservas_rechazo_plazo.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function normalizarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarFecha(valor) {
  return normalizarTexto(valor);
}

function normalizarHora(valor) {
  return normalizarTexto(valor);
}

function normalizarHoraFinOpcional(valor) {
  const hora = normalizarHora(valor);
  return hora || null;
}

function parsearCapacidad(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === "") return null;
  const n = parseInt(valor, 10);
  return Number.isInteger(n) ? n : NaN;
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsearFlag(valor, defecto = 0) {
  if (valor === true || valor === 1 || valor === "1") return 1;
  if (valor === false || valor === 0 || valor === "0") return 0;
  return defecto;
}

function esErrorColumnaDuplicada(error) {
  const texto = normalizarTexto(error?.message || error || "").toLowerCase();
  return texto.includes("duplicate column name") || texto.includes("duplicate column");
}

function dbPrimaria(env) {
  if (typeof env?.DB?.withSession === "function") {
    return env.DB.withSession("first-primary");
  }
  return env.DB;
}

async function asegurarEstructuraEstadoFranjas(env) {
  try {
    await env.DB.prepare(`
      ALTER TABLE franjas
      ADD COLUMN activa INTEGER NOT NULL DEFAULT 1
    `).run();
  } catch (error) {
    if (!esErrorColumnaDuplicada(error)) throw error;
  }

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS franja_desactivacion_avisos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      franja_id INTEGER NOT NULL,
      actividad_id INTEGER NOT NULL,
      usuario_id INTEGER,
      email TEXT,
      contacto TEXT,
      actividad_nombre TEXT,
      organizador_nombre TEXT,
      franja_descripcion TEXT,
      notificado_reactivacion INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reactivado_at TEXT
    )
  `).run();
}

function haFinalizadoFranja(row, ahora = new Date()) {
  const fechaHoraInicio = obtenerInicioReserva(row);
  if (!fechaHoraInicio) return false;
  if (Number.isNaN(fechaHoraInicio.getTime())) return false;
  return fechaHoraInicio.getTime() <= ahora.getTime();
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function descripcionFranja(row = {}) {
  const horaFin = normalizarTexto(row.hora_fin);
  const horario = horaFin
    ? `${normalizarTexto(row.hora_inicio)}-${horaFin}`
    : `Desde las ${normalizarTexto(row.hora_inicio)}`;
  if (Number(row.es_recurrente || 0) === 1) {
    return `${normalizarTexto(row.patron_recurrencia)} - ${horario}`.trim();
  }
  return `${normalizarTexto(row.fecha)} - ${horario}`.trim();
}

function franjaHaCambiado(existente = {}, siguiente = {}) {
  return (
    normalizarTexto(existente.fecha) !== normalizarTexto(siguiente.fecha) ||
    normalizarTexto(existente.hora_inicio) !== normalizarTexto(siguiente.hora_inicio) ||
    normalizarTexto(existente.hora_fin) !== normalizarTexto(siguiente.hora_fin) ||
    String(Number(existente.capacidad ?? "")) !== String(Number(siguiente.capacidad ?? "")) ||
    Number(existente.es_recurrente || 0) !== Number(siguiente.es_recurrente || 0) ||
    normalizarTexto(existente.patron_recurrencia) !== normalizarTexto(siguiente.patron_recurrencia)
  );
}

async function obtenerReservasAfectadasFranja(env, franjaId) {
  const result = await env.DB.prepare(`
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
    LEFT JOIN usuarios us
      ON us.id = r.usuario_id
    WHERE r.franja_id = ?
      AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA', 'RECHAZADA')
    ORDER BY r.id ASC
  `).bind(franjaId).all();

  return result?.results || [];
}

async function aplicarCambiosYNotificarFranja(env, reservas = [], franjaAnterior = {}, franjaNueva = {}, actor = {}) {
  const resumen = {
    total: reservas.length,
    suspendidas: 0,
    notificaciones_creadas: 0,
    correos_enviados: 0,
    incidencias: []
  };

  for (const reserva of reservas) {
    try {
      const descripcionAnterior = descripcionFranja(franjaAnterior);
      const descripcionNueva = descripcionFranja(franjaNueva);
      const actividad = normalizarTexto(reserva.actividad_nombre || "la actividad");
      const codigo = normalizarTexto(reserva.codigo_reserva || "");
      const contacto = normalizarTexto(reserva.contacto || "");
      const organizador = normalizarTexto(reserva.organizador_nombre || "el organizador");
      const estadoActual = normalizarTexto(reserva.estado).toUpperCase();
      let mensajeFinal = "";
      const mensaje = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Revisa la nueva programación y confirma que sigue encajando con tu solicitud.`;

      mensajeFinal = mensaje;
      if (estadoActual === "PENDIENTE" || estadoActual === "CONFIRMADA") {
        const update = await env.DB.prepare(`
          UPDATE reservas
          SET estado = 'SUSPENDIDA',
              fecha_modificacion = datetime('now')
          WHERE id = ?
            AND UPPER(TRIM(COALESCE(estado, ''))) IN ('PENDIENTE', 'CONFIRMADA')
        `).bind(reserva.id).run();

        if ((update?.meta?.changes || 0) > 0) {
          resumen.suspendidas += 1;
          await registrarEventoReserva(env, {
            reservaId: reserva.id,
            accion: "CAMBIO_FRANJA",
            estadoOrigen: estadoActual,
            estadoDestino: "SUSPENDIDA",
            observaciones: `Programación modificada: ${descripcionAnterior} -> ${descripcionNueva}`,
            actorUsuarioId: actor.actorUsuarioId,
            actorRol: actor.actorRol,
            actorNombre: actor.actorNombre
          });
        }

        mensajeFinal = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Tu solicitud ha pasado a estado suspendida hasta que revises la nueva programación.`;
      } else if (estadoActual === "SUSPENDIDA") {
        await registrarEventoReserva(env, {
          reservaId: reserva.id,
          accion: "CAMBIO_FRANJA",
          estadoOrigen: "SUSPENDIDA",
          estadoDestino: "SUSPENDIDA",
          observaciones: `Programación modificada: ${descripcionAnterior} -> ${descripcionNueva}`,
          actorUsuarioId: actor.actorUsuarioId,
          actorRol: actor.actorRol,
          actorNombre: actor.actorNombre
        });
        mensajeFinal = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Tu solicitud continúa suspendida y debes revisar la nueva programación.`;
      } else if (estadoActual === "RECHAZADA") {
        await registrarEventoReserva(env, {
          reservaId: reserva.id,
          accion: "CAMBIO_FRANJA",
          estadoOrigen: "RECHAZADA",
          estadoDestino: "RECHAZADA",
          observaciones: `Programación modificada: ${descripcionAnterior} -> ${descripcionNueva}`,
          actorUsuarioId: actor.actorUsuarioId,
          actorRol: actor.actorRol,
          actorNombre: actor.actorNombre
        });
        mensajeFinal = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Tu solicitud continúa rechazada, pero te avisamos para que conozcas el cambio.`;
      }

      const notificacion = await crearNotificacion(env, {
        usuarioId: Number(reserva.usuario_id || 0),
        rolDestino: "SOLICITANTE",
        tipo: "RESERVA",
        titulo: "Cambio en la franja horaria",
        mensaje: mensajeFinal,
        urlDestino: "/usuario-panel.html"
      });

      if (notificacion?.ok) {
        resumen.notificaciones_creadas += 1;
      }

      const destinatario = normalizarTexto(reserva.email || "");
      if (destinatario) {
        const saludo = contacto ? `Hola ${contacto},` : "Hola,";
        const text = [
          saludo,
          "",
          mensajeFinal,
          "",
          `Franja anterior: ${descripcionAnterior}`,
          `Franja actualizada: ${descripcionNueva}`,
          `Organiza: ${organizador}`,
          "",
          "Puedes revisar el cambio desde tu panel de usuario y decidir como proceder con tu solicitud."
        ].join("\n");

        const html = `
          <p>${escaparHtml(saludo)}</p>
          <p>${escaparHtml(mensajeFinal)}</p>
          <p><strong>Franja anterior:</strong> ${escaparHtml(descripcionAnterior)}</p>
          <p><strong>Franja actualizada:</strong> ${escaparHtml(descripcionNueva)}</p>
          <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
          <p>Puedes revisar el cambio desde tu panel de usuario y decidir como proceder con tu solicitud.</p>
        `;

        const correo = await enviarEmail(env, {
          to: destinatario,
          subject: "[Reservas] Cambio en la franja horaria de tu solicitud",
          text,
          html
        });

        if (correo?.ok) {
          resumen.correos_enviados += 1;
        } else if (!correo?.skipped) {
          resumen.incidencias.push(`Correo reserva ${reserva.id}: ${correo?.error || "error desconocido"}`);
        }
      }
    } catch (error) {
      resumen.incidencias.push(`Reserva ${reserva.id}: ${error?.message || String(error || "")}`);
    }
  }

  return resumen;
}

async function obtenerReservasFuturasFranja(env, franjaId) {
  const result = await env.DB.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.codigo_reserva,
      r.contacto,
      COALESCE(NULLIF(TRIM(r.email), ''), NULLIF(TRIM(us.email), '')) AS email,
      r.estado,
      COALESCE(a.organizador_publico, 'Organizador') AS organizador_nombre,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.es_recurrente,
      f.patron_recurrencia
    FROM reservas r
    JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios us
      ON us.id = r.usuario_id
    WHERE r.franja_id = ?
      AND (
        f.fecha IS NULL
        OR datetime(f.fecha || ' ' || COALESCE(NULLIF(f.hora_inicio, ''), '00:00')) > datetime('now')
      )
    ORDER BY r.id ASC
  `).bind(franjaId).all();

  return result?.results || [];
}

async function contarReservasHistoricasFranja(env, franjaId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM reservas r
    JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.franja_id = ?
      AND f.fecha IS NOT NULL
      AND datetime(f.fecha || ' ' || COALESCE(NULLIF(f.hora_inicio, ''), '00:00')) <= datetime('now')
  `).bind(franjaId).first();

  return Number(row?.total || 0);
}

async function obtenerFranjasDisponiblesAlternativas(env, actividadId, franjaExcluidaId) {
  const actividad = await obtenerActividad(env, actividadId);
  const aforoLimitado = Number(actividad?.aforo_limitado || 0) === 1;
  const franjas = await obtenerResumenFranjas(env, actividadId);

  return franjas
    .filter((franja) => Number(franja.id || 0) !== Number(franjaExcluidaId || 0))
    .filter((franja) => Number(franja.activa ?? 1) === 1)
    .filter((franja) => !haFinalizadoFranja(franja))
    .filter((franja) => !aforoLimitado || Number(franja.disponibles || 0) > 0)
    .map((franja) => ({
      descripcion: descripcionFranja(franja),
      disponibles: aforoLimitado ? Number(franja.disponibles || 0) : null
    }));
}

function construirTextoFranjasAlternativas(franjas = []) {
  if (!franjas.length) {
    return "Actualmente no constan otras franjas horarias con plazas disponibles para esta actividad.";
  }

  return [
    "Franjas horarias disponibles para volver a solicitar esta actividad:",
    ...franjas.map((franja) => {
      const plazas = franja.disponibles === null ? "aforo no limitado" : `${franja.disponibles} plaza(s) disponible(s)`;
      return `- ${franja.descripcion} (${plazas})`;
    })
  ].join("\n");
}

function construirHtmlFranjasAlternativas(franjas = []) {
  if (!franjas.length) {
    return "<p>Actualmente no constan otras franjas horarias con plazas disponibles para esta actividad.</p>";
  }

  return `
    <p><strong>Franjas horarias disponibles para volver a solicitar esta actividad:</strong></p>
    <ul>
      ${franjas.map((franja) => {
        const plazas = franja.disponibles === null ? "aforo no limitado" : `${franja.disponibles} plaza(s) disponible(s)`;
        return `<li>${escaparHtml(franja.descripcion)} (${escaparHtml(plazas)})</li>`;
      }).join("")}
    </ul>
  `;
}

async function eliminarReservasPorEliminacionFranja(env, reservas = [], franjaEliminada = {}, franjasAlternativas = [], motivo = "cancelada") {
  const resumen = {
    total: reservas.length,
    reservas_eliminadas: 0,
    correos_enviados: 0,
    incidencias: []
  };

  for (const reserva of reservas) {
    try {
      const destinatario = normalizarTexto(reserva.email || "");
      const actividad = normalizarTexto(reserva.actividad_nombre || "la actividad");
      const codigo = normalizarTexto(reserva.codigo_reserva || "");
      const contacto = normalizarTexto(reserva.contacto || "");
      const organizador = normalizarTexto(reserva.organizador_nombre || "el organizador");
      const franja = descripcionFranja(franjaEliminada);
      const saludo = contacto ? `Hola ${contacto},` : "Hola,";
      const accionFranja = motivo === "desactivada" ? "desactivada" : "cancelada";
      const mensaje = `La franja horaria ${franja} asociada a tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido ${accionFranja} por el organizador. La actividad continúa activa, pero tu solicitud para esa franja ha sido eliminada del sistema.`;
      const alternativasTexto = construirTextoFranjasAlternativas(franjasAlternativas);
      const alternativasHtml = construirHtmlFranjasAlternativas(franjasAlternativas);

      await borrarHistorialReservas(env, [reserva.id]);
      await env.DB.prepare(`
        DELETE FROM visitantes
        WHERE reserva_id = ?
      `).bind(reserva.id).run();

      const borrado = await env.DB.prepare(`
        DELETE FROM reservas
        WHERE id = ?
      `).bind(reserva.id).run();

      if ((borrado?.meta?.changes || 0) > 0) {
        resumen.reservas_eliminadas += 1;
      } else {
        resumen.incidencias.push(`Reserva ${reserva.id}: no se pudo eliminar tras cancelar la franja.`);
        continue;
      }

      if (destinatario) {
        const text = [
          saludo,
          "",
          mensaje,
          "",
          `Actividad: ${actividad}`,
          codigo ? `Código de solicitud: ${codigo}` : "",
          `Franja ${accionFranja}: ${franja}`,
          `Organiza: ${organizador}`,
          "",
          alternativasTexto,
          "",
          "Puedes realizar una nueva solicitud de esta actividad seleccionando una de las franjas horarias que sigan disponibles."
        ].filter(Boolean).join("\n");

        const html = `
          <p>${escaparHtml(saludo)}</p>
          <p>${escaparHtml(mensaje)}</p>
          <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
          ${codigo ? `<p><strong>Código de solicitud:</strong> ${escaparHtml(codigo)}</p>` : ""}
          <p><strong>Franja ${escaparHtml(accionFranja)}:</strong> ${escaparHtml(franja)}</p>
          <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
          ${alternativasHtml}
          <p>Puedes realizar una nueva solicitud de esta actividad seleccionando una de las franjas horarias que sigan disponibles.</p>
        `;

        const correo = await enviarEmail(env, {
          to: destinatario,
          subject: motivo === "desactivada"
            ? "[Reservas] Franja horaria desactivada y solicitud eliminada"
            : "[Reservas] Franja horaria cancelada y solicitud eliminada",
          text,
          html
        });

        if (correo?.ok) {
          resumen.correos_enviados += 1;
        } else if (!correo?.skipped) {
          resumen.incidencias.push(`Correo reserva ${reserva.id}: ${correo?.error || "error desconocido"}`);
        }
      }
    } catch (error) {
      resumen.incidencias.push(`Reserva ${reserva.id}: ${error?.message || String(error || "")}`);
    }
  }

  return resumen;
}

async function registrarAvisosReactivacionFranja(env, reservas = [], franja = {}) {
  const descripcion = descripcionFranja(franja);
  for (const reserva of reservas) {
    await env.DB.prepare(`
      INSERT INTO franja_desactivacion_avisos (
        franja_id,
        actividad_id,
        usuario_id,
        email,
        contacto,
        actividad_nombre,
        organizador_nombre,
        franja_descripcion
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      Number(franja.id || 0),
      Number(franja.actividad_id || 0),
      Number(reserva.usuario_id || 0) || null,
      normalizarTexto(reserva.email || ""),
      normalizarTexto(reserva.contacto || ""),
      normalizarTexto(reserva.actividad_nombre || "la actividad"),
      normalizarTexto(reserva.organizador_nombre || "el organizador"),
      descripcion
    ).run();
  }
}

async function notificarReactivacionFranja(env, franja = {}) {
  const avisos = await env.DB.prepare(`
    SELECT *
    FROM franja_desactivacion_avisos
    WHERE franja_id = ?
      AND COALESCE(notificado_reactivacion, 0) = 0
    ORDER BY id ASC
  `).bind(Number(franja.id || 0)).all();

  const rows = avisos?.results || [];
  const resumen = {
    total: rows.length,
    correos_enviados: 0,
    notificaciones_creadas: 0,
    incidencias: []
  };

  if (!rows.length) return resumen;

  const descripcionActual = descripcionFranja(franja);
  for (const aviso of rows) {
    try {
      const actividad = normalizarTexto(aviso.actividad_nombre || "la actividad");
      const organizador = normalizarTexto(aviso.organizador_nombre || "el organizador");
      const contacto = normalizarTexto(aviso.contacto || "");
      const destinatario = normalizarTexto(aviso.email || "");
      const saludo = contacto ? `Hola ${contacto},` : "Hola,";
      const mensaje = `La franja horaria ${descripcionActual} de ${actividad} vuelve a estar disponible. Si lo deseas, puedes realizar una nueva solicitud seleccionando de nuevo esta franja horaria.`;

      const usuarioId = Number(aviso.usuario_id || 0);
      if (usuarioId > 0) {
        const notificacion = await crearNotificacion(env, {
          usuarioId,
          rolDestino: "SOLICITANTE",
          tipo: "RESERVA",
          titulo: "Franja horaria disponible de nuevo",
          mensaje,
          urlDestino: "/portal.html"
        });
        if (notificacion?.ok) resumen.notificaciones_creadas += 1;
      }

      if (destinatario) {
        const text = [
          saludo,
          "",
          mensaje,
          "",
          `Actividad: ${actividad}`,
          `Franja disponible: ${descripcionActual}`,
          `Organiza: ${organizador}`,
          "",
          "La solicitud anterior fue eliminada al desactivarse la franja, por lo que si quieres participar debes iniciar una nueva solicitud."
        ].join("\n");

        const html = `
          <p>${escaparHtml(saludo)}</p>
          <p>${escaparHtml(mensaje)}</p>
          <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
          <p><strong>Franja disponible:</strong> ${escaparHtml(descripcionActual)}</p>
          <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
          <p>La solicitud anterior fue eliminada al desactivarse la franja, por lo que si quieres participar debes iniciar una nueva solicitud.</p>
        `;

        const correo = await enviarEmail(env, {
          to: destinatario,
          subject: "[Reservas] Franja horaria disponible de nuevo",
          text,
          html
        });

        if (correo?.ok) {
          resumen.correos_enviados += 1;
        } else if (!correo?.skipped) {
          resumen.incidencias.push(`Aviso ${aviso.id}: ${correo?.error || "error desconocido"}`);
        }
      }

      await env.DB.prepare(`
        UPDATE franja_desactivacion_avisos
        SET notificado_reactivacion = 1,
            reactivado_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(Number(aviso.id || 0)).run();
    } catch (error) {
      resumen.incidencias.push(`Aviso ${aviso.id}: ${error?.message || String(error || "")}`);
    }
  }

  return resumen;
}

async function cambiarEstadoFranja(env, franja = {}, activaNueva = 1, opciones = {}) {
  const activaActual = Number(franja.activa ?? 1) === 1 ? 1 : 0;
  const siguiente = activaNueva === 1 ? 1 : 0;
  if (activaActual === siguiente) {
    return { resumen: null, mensaje: siguiente ? "La franja ya estaba activa." : "La franja ya estaba desactivada." };
  }

  if (siguiente === 0) {
    const reservasAfectadas = await obtenerReservasFuturasFranja(env, franja.id);
    if (reservasAfectadas.length > 0 && !opciones.confirmado) {
      return {
        requiere_confirmacion: true,
        total_afectadas: reservasAfectadas.length,
        mensaje: reservasAfectadas.length === 1
          ? "Existe 1 solicitud futura asociada a esta franja. Si continúas, esa solicitud se eliminará y se enviará un correo al solicitante."
          : `Existen ${reservasAfectadas.length} solicitudes futuras asociadas a esta franja. Si continúas, esas solicitudes se eliminarán y se enviará un correo a cada solicitante.`
      };
    }

    const franjasAlternativas = reservasAfectadas.length > 0
      ? await obtenerFranjasDisponiblesAlternativas(env, franja.actividad_id, franja.id)
      : [];

    if (reservasAfectadas.length > 0) {
      await registrarAvisosReactivacionFranja(env, reservasAfectadas, franja);
    }

    const resumen = reservasAfectadas.length > 0
      ? await eliminarReservasPorEliminacionFranja(env, reservasAfectadas, franja, franjasAlternativas, "desactivada")
      : null;

    await env.DB.prepare(`
      UPDATE franjas
      SET activa = 0
      WHERE id = ?
    `).bind(Number(franja.id || 0)).run();

    return {
      resumen,
      mensaje: reservasAfectadas.length > 0
        ? "Franja desactivada correctamente. Las solicitudes futuras afectadas han sido eliminadas y se han enviado los avisos correspondientes."
        : "Franja desactivada correctamente."
    };
  }

  await env.DB.prepare(`
    UPDATE franjas
    SET activa = 1
    WHERE id = ?
  `).bind(Number(franja.id || 0)).run();

  const franjaActualizada = await obtenerFranjaPorId(env, franja.id);
  const resumen = await notificarReactivacionFranja(env, franjaActualizada || { ...franja, activa: 1 });
  return {
    resumen,
    mensaje: resumen.total > 0
      ? "Franja reactivada correctamente. Se ha avisado a los solicitantes afectados por la desactivación anterior."
      : "Franja reactivada correctamente."
  };
}

function validarDatosFranja({
  fecha,
  hora_inicio,
  hora_fin,
  capacidad,
  es_recurrente,
  patron_recurrencia,
  aforo_limitado
}) {
  if (!hora_inicio) {
    return "La hora de inicio es obligatoria.";
  }

  if (!/^\d{2}:\d{2}$/.test(hora_inicio)) {
    return "La hora de inicio debe tener formato HH:MM.";
  }

  if (hora_fin && !/^\d{2}:\d{2}$/.test(hora_fin)) {
    return "La hora de fin debe tener formato HH:MM.";
  }

  if (hora_fin && hora_inicio >= hora_fin) {
    return "La hora de inicio debe ser anterior a la hora de fin.";
  }

  if (Number(es_recurrente) === 1) {
    if (!patron_recurrencia) {
      return "Debe indicar un patrón de recurrencia.";
    }
  } else {
    if (!fecha) {
      return "La fecha es obligatoria.";
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return "La fecha debe tener formato YYYY-MM-DD.";
    }
  }

  if (Number(aforo_limitado) === 1) {
    if (!(capacidad > 0)) {
      return "La capacidad debe ser un entero mayor que 0.";
    }
  }

  return null;
}

async function obtenerActividad(env, actividad_id) {
  return await dbPrimaria(env).prepare(`
    SELECT
      id,
      nombre,
      tipo,
      fecha_inicio,
      fecha_fin,
      aforo_limitado,
      borrador_tecnico
    FROM actividades
    WHERE id = ?
    LIMIT 1
  `)
    .bind(actividad_id)
    .first();
}

function resolverAforoLimitadoActual(data, actividad) {
  return parsearFlag(data?.aforo_limitado, Number(actividad?.aforo_limitado || 0));
}

function resolverActividadActual(data, actividad = {}) {
  return {
    ...actividad,
    tipo: normalizarTexto(data?.tipo_actividad || actividad?.tipo).toUpperCase() || "PERMANENTE",
    fecha_inicio: normalizarFecha(data?.actividad_fecha_inicio || actividad?.fecha_inicio),
    fecha_fin: normalizarFecha(data?.actividad_fecha_fin || actividad?.fecha_fin)
  };
}

function validarFechaDentroDeActividad(actividad, fecha, es_recurrente) {
  if (!actividad) {
    return "La actividad indicada no existe.";
  }

  if (Number(es_recurrente) === 1) {
    return null;
  }

  if (Number(actividad.borrador_tecnico) === 1) {
    return null;
  }
  
  if (actividad.tipo === "PERMANENTE") {
    return null;
  }

  if (!actividad.fecha_inicio || !actividad.fecha_fin) {
    return "La actividad temporal no tiene definido correctamente su intervalo de fechas.";
  }

  if (fecha < actividad.fecha_inicio || fecha > actividad.fecha_fin) {
    return `La fecha de la franja debe estar dentro del intervalo de la actividad (${actividad.fecha_inicio} a ${actividad.fecha_fin}).`;
  }

  return null;
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

async function obtenerResumenFranjas(env, actividad_id) {
  const actividad = await obtenerActividad(env, actividad_id);
  const aforoLimitado = Number(actividad?.aforo_limitado || 0);

  const sql = `
    SELECT
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.actividad_id,
      COALESCE(f.activa, 1) AS activa,
      f.es_recurrente,
      f.patron_recurrencia,
      COUNT(CASE WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN r.id END) AS numero_reservas,
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
    FROM franjas f
    LEFT JOIN reservas r
      ON f.id = r.franja_id
    WHERE f.actividad_id = ?
    GROUP BY
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.actividad_id,
      f.activa,
      f.es_recurrente,
      f.patron_recurrencia
    ORDER BY
      CASE WHEN f.es_recurrente = 1 THEN 1 ELSE 0 END,
      f.fecha,
      f.patron_recurrencia,
      f.hora_inicio,
      f.hora_fin
  `;

  const result = await dbPrimaria(env).prepare(sql).bind(actividad_id).all();
  const rows = result.results || [];

  let franjas = rows.map(row => {
    const capacidad = row.capacidad === null || row.capacidad === undefined ? null : Number(row.capacidad || 0);
    const ocupadas = aforoLimitado ? Number(row.ocupadas || 0) : 0;

    return {
      ...row,
      activa: Number(row.activa ?? 1) === 1 ? 1 : 0,
      es_recurrente: Number(row.es_recurrente || 0),
      capacidad,
      ocupadas,
      disponibles: aforoLimitado && capacidad !== null ? Math.max(capacidad - ocupadas, 0) : null,
      numero_reservas: aforoLimitado ? Number(row.numero_reservas || 0) : 0
    };
  });

  return franjas;
}

async function obtenerFranjaPorId(env, id) {
  return await dbPrimaria(env).prepare(`
    SELECT
      id,
      actividad_id,
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
      activa,
      es_recurrente,
      patron_recurrencia
    FROM franjas
    WHERE id = ?
    LIMIT 1
  `)
    .bind(id)
    .first();
}

export async function onRequestGet(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    await asegurarEstructuraEstadoFranjas(env);
    await ejecutarMantenimientoReservas(env);
    const session = await getAdminSession(request, env);
    const url = new URL(request.url);
    const actividad_id = parsearIdPositivo(url.searchParams.get("actividad_id"));

    if (!actividad_id) {
      return json({ ok: false, error: "actividad_id es obligatorio." }, { status: 400 });
    }

    await checkAdminActividad(env, session.usuario_id, actividad_id);

    const franjas = await obtenerResumenFranjas(env, actividad_id);

    return json({
      ok: true,
      total: franjas.length,
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al obtener las franjas.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestPost(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    await asegurarEstructuraEstadoFranjas(env);
    const session = await getAdminSession(request, env);
    const data = await request.json();

    const actividad_id = parsearIdPositivo(data.actividad_id);
    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHoraFinOpcional(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);
    const es_recurrente = parsearFlag(data.es_recurrente, 0);
    const patron_recurrencia = normalizarTexto(data.patron_recurrencia);

    if (!actividad_id) {
      return json({ ok: false, error: "actividad_id es obligatorio." }, { status: 400 });
    }

    await checkAdminActividad(env, session.usuario_id, actividad_id);

    const actividadBase = await obtenerActividad(env, actividad_id);

    if (!actividadBase) {
      return json({ ok: false, error: "Actividad no válida." }, { status: 400 });
    }
    
    const actividad = resolverActividadActual(data, actividadBase);
    const aforo_limitado = resolverAforoLimitadoActual(data, actividad);

    const errorValidacion = validarDatosFranja({
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
      es_recurrente,
      patron_recurrencia,
      aforo_limitado
    });

    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, { status: 400 });
    }

    const errorFecha = validarFechaDentroDeActividad(actividad, fecha, es_recurrente);

    if (errorFecha) {
      return json({ ok: false, error: errorFecha }, { status: 400 });
    }

    let duplicada;

    if (es_recurrente === 1) {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND es_recurrente = 1
          AND patron_recurrencia = ?
          AND hora_inicio = ?
          AND COALESCE(hora_fin, '') = COALESCE(?, '')
        LIMIT 1
      `)
        .bind(actividad_id, patron_recurrencia, hora_inicio, hora_fin)
        .first();
    } else {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND COALESCE(es_recurrente, 0) = 0
          AND fecha = ?
          AND hora_inicio = ?
          AND COALESCE(hora_fin, '') = COALESCE(?, '')
        LIMIT 1
      `)
        .bind(actividad_id, fecha, hora_inicio, hora_fin)
        .first();
    }

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe una franja con esos datos para esta actividad."
        },
        { status: 409 }
      );
    }

    const insertResult = await env.DB.prepare(`
      INSERT INTO franjas (
        fecha,
        hora_inicio,
        hora_fin,
        capacidad,
        actividad_id,
        es_recurrente,
        patron_recurrencia
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        es_recurrente === 1 ? null : fecha,
        hora_inicio,
        hora_fin,
        aforo_limitado === 1 ? capacidad : null,
        actividad_id,
        es_recurrente,
        es_recurrente === 1 ? patron_recurrencia : null
      )
      .run();

    if ((insertResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo crear la franja." },
        { status: 500 }
      );
    }

    const franjas = await obtenerResumenFranjas(env, actividad_id);

    return json({
      ok: true,
      mensaje: "Franja creada correctamente.",
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al crear la franja.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestPut(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    await asegurarEstructuraEstadoFranjas(env);
    const session = await getAdminSession(request, env);
    const data = await request.json();

    const id = parsearIdPositivo(data.id);
    const accion = normalizarTexto(data.accion).toLowerCase();
    const confirmarEstado = data.confirmar_estado === true || data.confirmar_estado === 1 || data.confirmar_estado === "1";

    if (!id) {
      return json({ ok: false, error: "ID de franja no válido." }, { status: 400 });
    }

    const existente = await obtenerFranjaPorId(env, id);

    if (!existente) {
      return json(
        { ok: false, error: "La franja indicada no existe." },
        { status: 404 }
      );
    }

    await checkAdminActividad(env, session.usuario_id, existente.actividad_id);

    if (accion === "estado") {
      const activaNueva = parsearFlag(data.activa, Number(existente.activa ?? 1));
      const resultado = await cambiarEstadoFranja(env, existente, activaNueva, { confirmado: confirmarEstado });

      if (resultado?.requiere_confirmacion) {
        return json({ ok: false, ...resultado }, { status: 409 });
      }

      const franjas = await obtenerResumenFranjas(env, existente.actividad_id);
      return json({
        ok: true,
        mensaje: resultado?.mensaje || "Estado de franja actualizado correctamente.",
        resumen_afectacion: resultado?.resumen || null,
        franjas
      });
    }

    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHoraFinOpcional(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);
    const es_recurrente = parsearFlag(data.es_recurrente, 0);
    const patron_recurrencia = normalizarTexto(data.patron_recurrencia);
    const confirmarAfectacion = data.confirmar_afectacion === true || data.confirmar_afectacion === 1 || data.confirmar_afectacion === "1";

    const actividadBase = await obtenerActividad(env, existente.actividad_id);
    const actividad = resolverActividadActual(data, actividadBase);
    const aforo_limitado = resolverAforoLimitadoActual(data, actividad);
    const siguienteFranja = {
      fecha: es_recurrente === 1 ? null : fecha,
      hora_inicio,
      hora_fin,
      capacidad: aforo_limitado === 1 ? capacidad : null,
      es_recurrente,
      patron_recurrencia: es_recurrente === 1 ? patron_recurrencia : null
    };

    const errorValidacion = validarDatosFranja({
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
      es_recurrente,
      patron_recurrencia,
      aforo_limitado
    });

    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, { status: 400 });
    }

    const errorFecha = validarFechaDentroDeActividad(actividad, fecha, es_recurrente);

    if (errorFecha) {
      return json({ ok: false, error: errorFecha }, { status: 400 });
    }

    let duplicada;

    if (es_recurrente === 1) {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND es_recurrente = 1
          AND patron_recurrencia = ?
          AND hora_inicio = ?
          AND COALESCE(hora_fin, '') = COALESCE(?, '')
          AND id <> ?
        LIMIT 1
      `)
        .bind(existente.actividad_id, patron_recurrencia, hora_inicio, hora_fin, id)
        .first();
    } else {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND COALESCE(es_recurrente, 0) = 0
          AND fecha = ?
          AND hora_inicio = ?
          AND COALESCE(hora_fin, '') = COALESCE(?, '')
          AND id <> ?
        LIMIT 1
      `)
        .bind(existente.actividad_id, fecha, hora_inicio, hora_fin, id)
        .first();
    }

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe otra franja con esos datos para esta actividad."
        },
        { status: 409 }
      );
    }

    if (aforo_limitado === 1) {
      const ocupadas = await obtenerBloqueoActualFranja(env, id);

      if (capacidad < ocupadas) {
        return json(
          {
            ok: false,
            error: `La capacidad no puede ser inferior a las plazas ya bloqueadas (${ocupadas}).`
          },
          { status: 400 }
        );
      }
    }

    const hayCambioReal = franjaHaCambiado(existente, siguienteFranja);
    const franjaEstabaActiva = Number(existente.activa ?? 1) === 1;
    const debeNotificarCambios = hayCambioReal && franjaEstabaActiva;
    const reservasAfectadas = debeNotificarCambios ? await obtenerReservasAfectadasFranja(env, id) : [];
    if (debeNotificarCambios && reservasAfectadas.length > 0 && !confirmarAfectacion) {
      return json({
        ok: false,
        requiere_confirmacion_afectacion: true,
        total_afectadas: reservasAfectadas.length,
        mensaje: reservasAfectadas.length === 1
          ? "Existe 1 solicitud vinculada a esta franja. Si continúas, se notificará al solicitante y, si estaba pendiente o confirmada, pasará a suspendida."
          : `Existen ${reservasAfectadas.length} solicitudes vinculadas a esta franja. Si continúas, se notificará a los solicitantes y las que estuvieran pendientes o confirmadas pasarán a suspendida.`
      }, { status: 409 });
    }

    const updateResult = await env.DB.prepare(`
      UPDATE franjas
      SET
        fecha = ?,
        hora_inicio = ?,
        hora_fin = ?,
        capacidad = ?,
        es_recurrente = ?,
        patron_recurrencia = ?
      WHERE id = ?
    `)
      .bind(
        es_recurrente === 1 ? null : fecha,
        hora_inicio,
        hora_fin,
        aforo_limitado === 1 ? capacidad : null,
        es_recurrente,
        es_recurrente === 1 ? patron_recurrencia : null,
        id
      )
      .run();

    if ((updateResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo actualizar la franja." },
        { status: 500 }
      );
    }

    let resumenAfectacion = null;
    if (debeNotificarCambios && reservasAfectadas.length > 0) {
      resumenAfectacion = await aplicarCambiosYNotificarFranja(
        env,
        reservasAfectadas,
        existente,
        siguienteFranja,
        {
          actorUsuarioId: session.usuario_id,
          actorRol: "ADMIN"
        }
      );
    }

    const franjas = await obtenerResumenFranjas(env, existente.actividad_id);

    return json({
      ok: true,
      mensaje: "Franja actualizada correctamente.",
      resumen_afectacion: resumenAfectacion,
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al actualizar la franja.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestDelete(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    await asegurarEstructuraEstadoFranjas(env);
    const session = await getAdminSession(request, env);
    const data = await request.json();
    const id = parsearIdPositivo(data.id);

    if (!id) {
      return json({ ok: false, error: "ID de franja no válido." }, { status: 400 });
    }

    const existente = await obtenerFranjaPorId(env, id);

    if (!existente) {
      return json(
        { ok: false, error: "La franja indicada no existe." },
        { status: 404 }
      );
    }

    await checkAdminActividad(env, session.usuario_id, existente.actividad_id);

    const actividad = await obtenerActividad(env, existente.actividad_id);
    const confirmarEliminacion = data.confirmar === true || data.confirmar === 1 || data.confirmar === "1";
    const reservasHistoricas = await contarReservasHistoricasFranja(env, id);

    if (reservasHistoricas > 0) {
      return json({
        ok: false,
        bloquear: true,
        error: "No se puede eliminar la franja porque tiene solicitudes históricas asociadas. El histórico debe conservarse."
      }, { status: 400 });
    }

    const reservasAfectadas = Number(actividad?.borrador_tecnico || 0) === 1
      ? []
      : await obtenerReservasFuturasFranja(env, id);

    if (reservasAfectadas.length > 0 && !confirmarEliminacion) {
      return json({
        ok: false,
        requiere_confirmacion: true,
        total_afectadas: reservasAfectadas.length,
        mensaje: reservasAfectadas.length === 1
          ? "Existe 1 solicitud futura asociada a esta franja. Si continúas, la solicitud se eliminará automáticamente y se enviará un correo al solicitante."
          : `Existen ${reservasAfectadas.length} solicitudes futuras asociadas a esta franja. Si continúas, esas solicitudes se eliminarán automáticamente y se enviará un correo a cada solicitante.`
      }, { status: 409 });
    }

    const franjasAlternativas = reservasAfectadas.length > 0
      ? await obtenerFranjasDisponiblesAlternativas(env, existente.actividad_id, id)
      : [];

    let resumenAfectacion = null;
    if (reservasAfectadas.length > 0) {
      resumenAfectacion = await eliminarReservasPorEliminacionFranja(
        env,
        reservasAfectadas,
        existente,
        franjasAlternativas
      );
    }
    const deleteResult = await env.DB.prepare(`
      DELETE FROM franjas
      WHERE id = ?
    `)
      .bind(id)
      .run();

    if ((deleteResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo eliminar la franja." },
        { status: 500 }
      );
    }

    const franjas = await obtenerResumenFranjas(env, existente.actividad_id);

    return json({
      ok: true,
      mensaje: "Franja eliminada correctamente.",
      resumen_afectacion: resumenAfectacion,
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al eliminar la franja.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
