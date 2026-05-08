import { getAdminSession } from "./_auth.js";
import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";
import {
  asegurarColumnaObservacionesAdmin,
  obtenerSituacionReservasActividad,
  rechazarReservasPorAnulacionActividad
} from "./actividades-eliminar.js";
import { crearNotificacion } from "../_notificaciones.js";
import { enviarEmail } from "../_email.js";
import { registrarEventoReserva } from "../_reservas_historial.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarNullable(valor) {
  const v = String(valor || "").trim();
  return v === "" ? null : v;
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsearEntero(valor, defecto = 0) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) ? n : defecto;
}

function parsearFlag(valor, defecto = 0) {
  if (valor === true || valor === 1 || valor === "1") return 1;
  if (valor === false || valor === 0 || valor === "0") return 0;
  return defecto;
}

function normalizarRequisitosEntrada(valor) {
  const lista = Array.isArray(valor) ? valor : [];
  return lista
    .map((item) => {
      if (typeof item === "string") return item.trim();
      return String(item?.texto || "").trim();
    })
    .filter(Boolean);
}

async function asegurarTablaRequisitos(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS actividad_requisitos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actividad_id INTEGER NOT NULL,
      texto TEXT NOT NULL,
      orden INTEGER NOT NULL DEFAULT 0
    )
  `).run();
}

async function guardarRequisitosActividad(env, actividadId, requisitos) {
  await asegurarTablaRequisitos(env);

  await env.DB.prepare(`
    DELETE FROM actividad_requisitos
    WHERE actividad_id = ?
  `).bind(actividadId).run();

  for (let i = 0; i < requisitos.length; i += 1) {
    await env.DB.prepare(`
      INSERT INTO actividad_requisitos (
        actividad_id,
        texto,
        orden
      )
      VALUES (?, ?, ?)
    `).bind(actividadId, requisitos[i], i + 1).run();
  }
}

function requisitosSonIguales(listaA = [], listaB = []) {
  if (listaA.length !== listaB.length) return false;
  for (let i = 0; i < listaA.length; i += 1) {
    if (String(listaA[i] || "").trim() !== String(listaB[i] || "").trim()) {
      return false;
    }
  }
  return true;
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function obtenerRequisitosActividad(env, actividadId) {
  await asegurarTablaRequisitos(env);
  const result = await env.DB.prepare(`
    SELECT texto
    FROM actividad_requisitos
    WHERE actividad_id = ?
    ORDER BY orden ASC, id ASC
  `).bind(actividadId).all();

  return (result?.results || [])
    .map((row) => limpiarTexto(row.texto))
    .filter(Boolean);
}

async function obtenerReservasAfectadasActividad(env, actividadId) {
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
      AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA', 'RECHAZADA')
    ORDER BY r.id ASC
  `).bind(actividadId).all();

  return result?.results || [];
}

async function notificarCambioRequisitosActividad(env, reservas = [], actividadNombre = "", actor = {}) {
  const resumen = {
    total: reservas.length,
    suspendidas: 0,
    notificaciones_creadas: 0,
    correos_enviados: 0,
    incidencias: []
  };

  for (const reserva of reservas) {
    try {
      const actividad = limpiarTexto(actividadNombre || reserva.actividad_nombre || "la actividad");
      const codigo = limpiarTexto(reserva.codigo_reserva || "");
      const contacto = limpiarTexto(reserva.contacto || "");
      const organizador = limpiarTexto(reserva.organizador_nombre || "el organizador");
      const estadoActual = limpiarTexto(reserva.estado).toUpperCase();
      const mensaje = `Se han actualizado los requisitos de ${actividad}${codigo ? ` asociados a tu solicitud (${codigo})` : ""}. Revisa las condiciones antes de mantener la solicitud tal como estÃ¡.`;

      let mensajeFinal = mensaje;
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
            accion: "CAMBIO_REQUISITOS",
            estadoOrigen: estadoActual,
            estadoDestino: "SUSPENDIDA",
            observaciones: "La actividad ha actualizado sus requisitos particulares.",
            actorUsuarioId: actor.actorUsuarioId,
            actorRol: actor.actorRol,
            actorNombre: actor.actorNombre
          });
        }

        mensajeFinal = `Se han actualizado los requisitos de ${actividad}${codigo ? ` asociados a tu solicitud (${codigo})` : ""}. Tu solicitud ha pasado a estado suspendida hasta que revises los requisitos actualizados.`;
      } else if (estadoActual === "SUSPENDIDA") {
        await registrarEventoReserva(env, {
          reservaId: reserva.id,
          accion: "CAMBIO_REQUISITOS",
          estadoOrigen: "SUSPENDIDA",
          estadoDestino: "SUSPENDIDA",
          observaciones: "La actividad ha actualizado sus requisitos particulares.",
          actorUsuarioId: actor.actorUsuarioId,
          actorRol: actor.actorRol,
          actorNombre: actor.actorNombre
        });
        mensajeFinal = `Se han actualizado los requisitos de ${actividad}${codigo ? ` asociados a tu solicitud (${codigo})` : ""}. Tu solicitud continÃºa suspendida y debes revisar los requisitos actualizados.`;
      } else if (estadoActual === "RECHAZADA") {
        await registrarEventoReserva(env, {
          reservaId: reserva.id,
          accion: "CAMBIO_REQUISITOS",
          estadoOrigen: "RECHAZADA",
          estadoDestino: "RECHAZADA",
          observaciones: "La actividad ha actualizado sus requisitos particulares.",
          actorUsuarioId: actor.actorUsuarioId,
          actorRol: actor.actorRol,
          actorNombre: actor.actorNombre
        });
        mensajeFinal = `Se han actualizado los requisitos de ${actividad}${codigo ? ` asociados a tu solicitud (${codigo})` : ""}. Tu solicitud continÃºa rechazada, pero te avisamos para que conozcas el cambio.`;
      }

      const notificacion = await crearNotificacion(env, {
        usuarioId: Number(reserva.usuario_id || 0),
        rolDestino: "SOLICITANTE",
        tipo: "RESERVA",
        titulo: "Cambio en los requisitos de la actividad",
        mensaje: mensajeFinal,
        urlDestino: "/usuario-panel.html"
      });

      if (notificacion?.ok) {
        resumen.notificaciones_creadas += 1;
      }

      const destinatario = limpiarTexto(reserva.email || "");
      if (destinatario) {
        const saludo = contacto ? `Hola ${contacto},` : "Hola,";
        const text = [
          saludo,
          "",
          mensajeFinal,
          "",
          `Organiza: ${organizador}`,
          "",
          "Te recomendamos revisar de nuevo los requisitos particulares de la actividad para comprobar que sigues cumpliÃ©ndolos."
        ].join("\n");

        const html = `
          <p>${escaparHtml(saludo)}</p>
          <p>${escaparHtml(mensajeFinal)}</p>
          <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
          <p>Te recomendamos revisar de nuevo los requisitos particulares de la actividad para comprobar que sigues cumpliÃ©ndolos.</p>
        `;

        const correo = await enviarEmail(env, {
          to: destinatario,
          subject: "[Reservas] Cambio en los requisitos de la actividad",
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

function validarActividad(data) {
  const nombre = limpiarTexto(data.nombre);
  const tipo = limpiarTexto(data.tipo).toUpperCase();

  if (!nombre) return "El nombre de la actividad es obligatorio.";
  if (!["TEMPORAL", "PERMANENTE"].includes(tipo)) {
    return "El tipo debe ser TEMPORAL o PERMANENTE.";
  }

  if (tipo === "TEMPORAL") {
    const fecha_inicio = limpiarTexto(data.fecha_inicio);
    const fecha_fin = limpiarTexto(data.fecha_fin);

    if (!fecha_inicio || !fecha_fin) {
      return "Las actividades temporales deben tener fecha de inicio y fecha de fin.";
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_fin)) {
      return "Las fechas deben tener formato YYYY-MM-DD.";
    }

    if (fecha_inicio > fecha_fin) {
      return "La fecha de inicio no puede ser posterior a la fecha de fin.";
    }
  }

  return null;
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

async function obtenerPlazasComprometidasActividad(env, actividad_id) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(SUM(
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
    ), 0) AS comprometidas
    FROM reservas r
    WHERE r.actividad_id = ?
  `).bind(actividad_id).first();

  return Number(row?.comprometidas || 0);
}

async function obtenerSolicitudesVivasActividad(env, actividad_id) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM reservas r
    WHERE r.actividad_id = ?
      AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('BORRADOR', 'PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
  `).bind(actividad_id).first();

  return Number(row?.total || 0);
}

function construirPayload(body, admin_id) {
  const tipo = limpiarTexto(body.tipo).toUpperCase();
  const esTemporal = tipo === "TEMPORAL";
  const visiblePortal = parsearFlag(body.visible_portal, 1);
  const activa = parsearFlag(body.activa, 1);

  return {
    nombre: limpiarTexto(body.nombre),
    tipo,
    fecha_inicio: esTemporal ? limpiarTexto(body.fecha_inicio) : null,
    fecha_fin: esTemporal ? limpiarTexto(body.fecha_fin) : null,
    activa,

    titulo_publico: normalizarNullable(body.titulo_publico),
    subtitulo_publico: normalizarNullable(body.subtitulo_publico),

    descripcion_corta: normalizarNullable(body.descripcion_corta),

    lugar: normalizarNullable(body.lugar),
    direccion_postal: normalizarNullable(body.direccion_postal),
    latitud: normalizarNullable(body.latitud),
    longitud: normalizarNullable(body.longitud),
    zoom_mapa: normalizarNullable(body.zoom_mapa),

    imagen_url: normalizarNullable(body.imagen_url),
    imagen_id: normalizarNullable(body.imagen_id),

    visible_portal: activa === 0 ? 0 : visiblePortal,
    orden_portal: parsearEntero(body.orden_portal, 0),
    organizador_publico: normalizarNullable(body.organizador_publico),
    usa_franjas: parsearFlag(body.usa_franjas, 1),
    admin_id,
    requiere_reserva: parsearFlag(body.requiere_reserva, 1),
    aforo_limitado: parsearFlag(body.aforo_limitado, 1),
    provincia: normalizarNullable(body.provincia),
    es_recurrente: parsearFlag(body.es_recurrente, 0),
    patron_recurrencia: normalizarNullable(body.patron_recurrencia),
    usa_enlace_externo: parsearFlag(body.usa_enlace_externo, 0),
    enlace_externo_url: normalizarNullable(body.enlace_externo_url),
    borrador_tecnico: parsearFlag(body.borrador_tecnico, 0),
    requisitos_particulares: normalizarRequisitosEntrada(body.requisitos_particulares)
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    await ejecutarMantenimientoReservas(env);
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json();
    const errorValidacion = validarActividad(body);
    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, 400);
    }

    const rol = await obtenerRol(env, session.usuario_id);

    let admin_id = parsearIdPositivo(body.admin_id);
    if (rol === "SUPERADMIN") {
      if (!admin_id) {
        return json({ ok: false, error: "Debe indicar el administrador responsable." }, 400);
      }
    } else {
      admin_id = session.usuario_id;
    }

    const p = construirPayload(body, admin_id);
    if (Number(p.activa || 0) === 0) {
      p.visible_portal = 0;
    }

    const result = await env.DB.prepare(`
      INSERT INTO actividades (
        nombre,
        tipo,
        fecha_inicio,
        fecha_fin,
        activa,
        titulo_publico,
        subtitulo_publico,
        descripcion_corta,
        lugar,
        direccion_postal,
        latitud,
        longitud,
        zoom_mapa,
        imagen_url,
        imagen_id,
        visible_portal,
        orden_portal,
        organizador_publico,
        usa_franjas,
        admin_id,
        requiere_reserva,
        aforo_limitado,
        provincia,
        es_recurrente,
        patron_recurrencia,
        usa_enlace_externo,
        enlace_externo_url,
        borrador_tecnico
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      p.nombre,
      p.tipo,
      p.fecha_inicio,
      p.fecha_fin,
      p.activa,
      p.titulo_publico,
      p.subtitulo_publico,
      p.descripcion_corta,
      p.lugar,
      p.direccion_postal,
      p.latitud,
      p.longitud,
      p.zoom_mapa,
      p.imagen_url,
      p.imagen_id,
      p.visible_portal,
      p.orden_portal,
      p.organizador_publico,
      p.usa_franjas,
      p.admin_id,
      p.requiere_reserva,
      p.aforo_limitado,
      p.provincia,
      p.es_recurrente,
      p.patron_recurrencia,
      p.usa_enlace_externo,
      p.enlace_externo_url,
      p.borrador_tecnico
    ).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo crear la actividad." }, 500);
    }

    const actividadId = Number(result?.meta?.last_row_id || 0);
    if (actividadId > 0) {
      await guardarRequisitosActividad(env, actividadId, p.requisitos_particulares);
    }

    return json({
      ok: true,
      mensaje: p.borrador_tecnico ? "Borrador tÃ©cnico creado correctamente." : "Actividad creada correctamente.",
      id: result.meta.last_row_id
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al crear la actividad.", detalle: error.message },
      500
    );
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json();
    const id = parsearIdPositivo(body.id);

    if (!id) {
      return json({ ok: false, error: "ID de actividad no vÃ¡lido." }, 400);
    }

    const actual = await obtenerActividad(env, id);
    if (!actual) {
      return json({ ok: false, error: "La actividad no existe." }, 404);
    }

    const rol = await obtenerRol(env, session.usuario_id);
    if (rol !== "SUPERADMIN" && Number(actual.admin_id || 0) !== Number(session.usuario_id)) {
      return json({ ok: false, error: "No autorizado para editar esta actividad." }, 403);
    }

    const errorValidacion = validarActividad(body);
    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, 400);
    }

    let admin_id = parsearIdPositivo(body.admin_id);
    if (rol !== "SUPERADMIN") {
      admin_id = actual.admin_id;
    }
    if (rol === "SUPERADMIN" && !admin_id) {
      return json({ ok: false, error: "Debe indicar el administrador responsable." }, 400);
    }

    const p = construirPayload(body, admin_id);
    const observacionesAdmin = limpiarTexto(body.observaciones_admin || "");
    const confirmadoAnulacion = body.confirmado_anulacion === true || body.confirmado_anulacion === 1 || body.confirmado_anulacion === "1";
    const confirmadoCambioRequisitos = body.confirmado_cambio_requisitos === true || body.confirmado_cambio_requisitos === 1 || body.confirmado_cambio_requisitos === "1";
    const activaActual = Number(actual.activa ?? actual.visible_portal ?? 1) === 1 ? 1 : 0;
    const activaNueva = Number(p.activa || 0) === 1 ? 1 : 0;
    const requisitosActuales = await obtenerRequisitosActividad(env, id);
    const requisitosNuevos = p.requisitos_particulares.map((item) => limpiarTexto(item)).filter(Boolean);
    const requisitosHanCambiado = !requisitosSonIguales(requisitosActuales, requisitosNuevos);
    const reservasAfectadasRequisitos = requisitosHanCambiado ? await obtenerReservasAfectadasActividad(env, id) : [];

    // ===============================
    // VALIDACIONES DE NEGOCIO
    // ===============================

    const franjas = await env.DB.prepare(`
      SELECT fecha, hora_inicio
      FROM franjas
      WHERE actividad_id = ?
    `).bind(id).all();

    const listaFranjas = franjas.results || [];

    if (p.tipo === "TEMPORAL" && listaFranjas.length > 0) {
      const fueraRango = listaFranjas.some(f =>
        f.fecha && (f.fecha < p.fecha_inicio || f.fecha > p.fecha_fin)
      );

      if (fueraRango) {
        return json({
          ok: false,
          error: "No puedes cambiar las fechas porque existen franjas fuera del nuevo rango."
        }, 400);
      }
    }

    const confirmadasFuturas = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM reservas r
      JOIN franjas f ON f.id = r.franja_id
      WHERE f.actividad_id = ?
        AND r.estado = 'CONFIRMADA'
        AND (
          f.fecha IS NULL OR
          datetime(f.fecha || ' ' || f.hora_inicio) >= datetime('now')
        )
    `).bind(id).first();

    const hayConfirmadas = Number(confirmadasFuturas?.total || 0) > 0;
    const solicitudesVivas = await obtenerSolicitudesVivasActividad(env, id);

    if (hayConfirmadas && p.tipo === "PERMANENTE" && actual.tipo === "TEMPORAL") {
      return json({
        ok: false,
        error: "No puedes cambiar a actividad permanente porque existen reservas confirmadas futuras."
      }, 400);
    }

    const plazasComprometidas = await obtenerPlazasComprometidasActividad(env, id);

    if (
      plazasComprometidas > 0 &&
      Number(actual.aforo_limitado || 0) === 1 &&
      Number(p.aforo_limitado || 0) === 0
    ) {
      return json({
        ok: false,
        error: "No puedes desactivar el aforo limitado porque existen plazas comprometidas en reservas activas."
      }, 400);
    }

    if (
      plazasComprometidas > 0 &&
      Number(actual.requiere_reserva || 0) === 1 &&
      Number(p.requiere_reserva || 0) === 0
    ) {
      return json({
        ok: false,
        error: "No puedes desactivar la reserva porque existen plazas comprometidas en reservas activas."
      }, 400);
    }

    if (
      solicitudesVivas > 0 &&
      Number(actual.usa_franjas || 0) === 1 &&
      Number(p.usa_franjas || 0) === 0
    ) {
      return json({
        ok: false,
        error: "No puedes desactivar las franjas porque existen solicitudes activas asociadas a esta actividad."
      }, 400);
    }

    if (activaActual === 1 && activaNueva === 0) {
      p.visible_portal = 0;

      if (solicitudesVivas > 0 && !confirmadoAnulacion) {
        const situacion = await obtenerSituacionReservasActividad(env, id);
        return json({
          ok: false,
          requiere_confirmacion: true,
          requiere_observaciones: true,
          resumen: situacion,
          mensaje: `La actividad tiene ${situacion.totalAfectables} solicitud(es) afectada(s) en estado borrador, pendiente, aceptada o suspendida. Si la desactivas, todas pasarÃ¡n automÃ¡ticamente a rechazada y se notificarÃ¡ individualmente a cada solicitante afectado.`
        }, 200);
      }

      if (solicitudesVivas > 0 && !observacionesAdmin) {
        return json({
          ok: false,
          error: "Debes indicar el motivo de la desactivaciÃ³n para rechazar automÃ¡ticamente las solicitudes afectadas."
        }, 400);
      }
    }

    if (activaActual === 0 && activaNueva === 1) {
      p.visible_portal = 1;
    }

    if (requisitosHanCambiado && reservasAfectadasRequisitos.length > 0 && !confirmadoCambioRequisitos) {
      return json({
        ok: false,
        requiere_confirmacion_requisitos: true,
        total_afectadas: reservasAfectadasRequisitos.length,
        mensaje: reservasAfectadasRequisitos.length === 1
          ? "Existe 1 solicitud vinculada a esta actividad. Si continÃºas, se notificarÃ¡ al solicitante y, si estaba pendiente o confirmada, pasarÃ¡ a suspendida."
          : `Existen ${reservasAfectadasRequisitos.length} solicitudes vinculadas a esta actividad. Si continÃºas, se notificarÃ¡ a los solicitantes y las que estuvieran pendientes o confirmadas pasarÃ¡n a suspendida.`
      }, 409);
    }

    const result = await env.DB.prepare(`
      UPDATE actividades
      SET
        nombre = ?,
        tipo = ?,
        fecha_inicio = ?,
        fecha_fin = ?,
        activa = ?,
        titulo_publico = ?,
        subtitulo_publico = ?,
        descripcion_corta = ?,
        lugar = ?,
        direccion_postal = ?,
        latitud = ?,
        longitud = ?,
        zoom_mapa = ?,
        imagen_url = ?,
        imagen_id = ?,
        visible_portal = ?,
        orden_portal = ?,
        organizador_publico = ?,
        admin_id = ?,
        usa_franjas = ?,
        requiere_reserva = ?,
        aforo_limitado = ?,
        provincia = ?,
        es_recurrente = ?,
        patron_recurrencia = ?,
        usa_enlace_externo = ?,
        enlace_externo_url = ?,
        borrador_tecnico = ?
      WHERE id = ?
    `).bind(
      p.nombre,
      p.tipo,
      p.fecha_inicio,
      p.fecha_fin,
      p.activa,
      p.titulo_publico,
      p.subtitulo_publico,
      p.descripcion_corta,
      p.lugar,
      p.direccion_postal,
      p.latitud,
      p.longitud,
      p.zoom_mapa,
      p.imagen_url,
      p.imagen_id,
      p.visible_portal,
      p.orden_portal,
      p.organizador_publico,
      p.admin_id,
      p.usa_franjas,
      p.requiere_reserva,
      p.aforo_limitado,
      p.provincia,
      p.es_recurrente,
      p.patron_recurrencia,
      p.usa_enlace_externo,
      p.enlace_externo_url,
      p.borrador_tecnico,
      id
    ).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo actualizar la actividad." }, 500);
    }

    let resumenAnulacion = null;
    if (activaActual === 1 && activaNueva === 0 && solicitudesVivas > 0) {
      await asegurarColumnaObservacionesAdmin(env);
      resumenAnulacion = await rechazarReservasPorAnulacionActividad(env, id, observacionesAdmin, {
        actorUsuarioId: session.usuario_id,
        actorRol: rol
      });
    }

    await guardarRequisitosActividad(env, id, p.requisitos_particulares);

    let resumenCambioRequisitos = null;
    if (requisitosHanCambiado && reservasAfectadasRequisitos.length > 0) {
      resumenCambioRequisitos = await notificarCambioRequisitosActividad(
        env,
        reservasAfectadasRequisitos,
        p.titulo_publico || p.nombre,
        {
          actorUsuarioId: session.usuario_id,
          actorRol: rol
        }
      );
    }

    return json({
      ok: true,
      resumen_anulacion: resumenAnulacion,
      resumen_cambio_requisitos: resumenCambioRequisitos,
      mensaje: p.borrador_tecnico ? "Borrador tÃ©cnico actualizado correctamente." : "Actividad actualizada correctamente."
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al actualizar la actividad.", detalle: error.message },
      500
    );
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json();
    const id = parsearIdPositivo(body.id);

    if (!id) {
      return json({ ok: false, error: "ID de actividad no vÃ¡lido." }, 400);
    }

    const actual = await obtenerActividad(env, id);
    if (!actual) {
      return json({ ok: false, error: "La actividad no existe." }, 404);
    }

    const rol = await obtenerRol(env, session.usuario_id);
    if (rol !== "SUPERADMIN" && Number(actual.admin_id || 0) !== Number(session.usuario_id)) {
      return json({ ok: false, error: "No autorizado para eliminar esta actividad." }, 403);
    }

    if (Number(actual.borrador_tecnico || 0) !== 1) {
      return json(
        { ok: false, error: "Solo se pueden eliminar desde aquÃ­ actividades en borrador tÃ©cnico." },
        400
      );
    }

    await env.DB.prepare(`
      DELETE FROM franjas
      WHERE actividad_id = ?
    `).bind(id).run();

    await asegurarTablaRequisitos(env);
    await env.DB.prepare(`
      DELETE FROM actividad_requisitos
      WHERE actividad_id = ?
    `).bind(id).run();

    const result = await env.DB.prepare(`
      DELETE FROM actividades
      WHERE id = ?
        AND borrador_tecnico = 1
    `).bind(id).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo eliminar el borrador tÃ©cnico." }, 500);
    }

    return json({
      ok: true,
      mensaje: "Borrador tÃ©cnico eliminado correctamente."
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al eliminar el borrador tÃ©cnico.", detalle: error.message },
      500
    );
  }
}

