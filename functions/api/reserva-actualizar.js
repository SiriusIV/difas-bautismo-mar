import { crearNotificacion } from "./_notificaciones.js";
import { registrarEventoReserva } from "./_reservas_historial.js";
import { getUserSession } from "./usuario/_auth.js";

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

function calcularMinutosConsolidacion(plazasReservadas) {
  const plazas = Number(plazasReservadas || 0);
  return 20 + (plazas * 3);
}

async function obtenerFechaExpiracionSQLite(env, minutos) {
  const row = await env.DB.prepare(`
    SELECT datetime('now', '+' || ? || ' minutes') AS expira
  `).bind(minutos).first();

  return row?.expira || null;
}

function accionNormalizada(valor) {
  return limpiarTexto(valor).toLowerCase();
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
  if (!(idAdmin > 0)) return { ok: false, skipped: true, error: "Administrador no vÃ¡lido." };

  return await crearNotificacion(env, {
    usuarioId: idAdmin,
    rolDestino: "ADMIN",
    tipo: "RESERVA",
    titulo: "Nueva solicitud de actividad",
    mensaje: `${centro || "Un centro"} ha solicitado ${actividadNombre || "una actividad"}${codigoReserva ? ` (${codigoReserva})` : ""}.`,
    urlDestino: actividadId ? `/admin-reservas.html?actividad_id=${encodeURIComponent(String(actividadId))}` : "/admin-reservas.html"
  });
}

async function obtenerReservaPorToken(env, tokenEdicion) {
  const sql = `
    SELECT
      r.id,
      r.actividad_id,
      r.franja_id,
      r.centro,
      r.contacto,
      r.telefono,
      r.email,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      r.observaciones,
      r.estado,
      r.codigo_reserva,
      r.usuario_id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin
    FROM reservas r
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.token_edicion = ?
    LIMIT 1
  `;

  return await env.DB.prepare(sql).bind(tokenEdicion).first();
}

async function contarAsistentes(env, reservaId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM visitantes
    WHERE reserva_id = ?
  `).bind(reservaId).first();

  return Number(row?.total || 0);
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

async function obtenerDisponibilidadFranja(env, franjaId) {
  const sql = `
    SELECT
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      COALESCE(SUM(
        CASE
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN
            CASE
              WHEN r.prereserva_expira_en IS NOT NULL
                   AND datetime('now') <= datetime(r.prereserva_expira_en)
                THEN COALESCE(r.plazas_prereservadas, 0)
              ELSE (
                SELECT COUNT(*)
                FROM visitantes v
                WHERE v.reserva_id = r.id
              )
            END
          ELSE 0
        END
      ), 0) AS ocupadas,
      (
        f.capacidad - COALESCE(SUM(
          CASE
            WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN
              CASE
                WHEN r.prereserva_expira_en IS NOT NULL
                     AND datetime('now') <= datetime(r.prereserva_expira_en)
                  THEN COALESCE(r.plazas_prereservadas, 0)
                ELSE (
                  SELECT COUNT(*)
                  FROM visitantes v
                  WHERE v.reserva_id = r.id
                )
              END
            ELSE 0
          END
        ), 0)
      ) AS disponibles
    FROM franjas f
    LEFT JOIN reservas r
      ON r.franja_id = f.id
    WHERE f.id = ?
    GROUP BY
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad
    LIMIT 1
  `;

  return await env.DB.prepare(sql).bind(franjaId).first();
}

async function existeSolicitudActivaMismoCentroFranjaExcluyendo(env, franjaId, centroComparacion, reservaIdExcluir) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado
    FROM reservas r
    WHERE r.franja_id = ?
      AND UPPER(TRIM(r.centro)) = ?
      AND r.id <> ?
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
    .bind(franjaId, centroComparacion, reservaIdExcluir)
    .first();
}

async function existeSolicitudActivaMismoCentroActividadSinFranjaExcluyendo(env, actividadId, centroComparacion, reservaIdExcluir) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado
    FROM reservas r
    WHERE r.actividad_id = ?
      AND r.franja_id IS NULL
      AND UPPER(TRIM(r.centro)) = ?
      AND r.id <> ?
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
    .bind(actividadId, centroComparacion, reservaIdExcluir)
    .first();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const user = await getUserSession(request, env.SECRET_KEY);
    if (!user?.id) {
      return json(
        { ok: false, authenticated: false, error: "Debes iniciar sesión para modificar esta solicitud." },
        { status: 401 }
      );
    }

    const data = await request.json();

    const tokenEdicion = limpiarTexto(data.token_edicion);
    const centro = limpiarTexto(data.centro);
    const contacto = limpiarTexto(data.contacto);
    const telefono = limpiarTexto(data.telefono);
    const email = limpiarTexto(data.email);
    const observaciones = limpiarTexto(data.observaciones);
    const accion = accionNormalizada(data.accion);
    const franjaRaw = data.franja;
    const franjaIdNueva = franjaRaw == null || String(franjaRaw).trim() === ""
      ? null
      : parseInt(franjaRaw, 10);
    const plazasSolicitadas = parseInt(
      data.plazas_reservadas ?? data.plazas_solicitadas,
      10
    );

    if (!tokenEdicion) {
      return json({ ok: false, error: "Falta el token de ediciÃ³n." }, { status: 400 });
    }

    if (!centro || !contacto || !telefono || !email) {
      return json({ ok: false, error: "Faltan datos obligatorios del solicitante." }, { status: 400 });
    }

    if (!esEmailValido(email)) {
      return json({ ok: false, error: "El correo electrÃ³nico no tiene un formato vÃ¡lido." }, { status: 400 });
    }

    if (!Number.isInteger(plazasSolicitadas) || plazasSolicitadas <= 0) {
      return json({ ok: false, error: "Debe indicar un nÃºmero vÃ¡lido de plazas reservadas." }, { status: 400 });
    }

    const reservaActual = await obtenerReservaPorToken(env, tokenEdicion);

    if (!reservaActual) {
      return json({ ok: false, error: "No existe ninguna reserva con ese token." }, { status: 404 });
    }

    if (Number(reservaActual.usuario_id || 0) !== Number(user.id || 0)) {
      return json({ ok: false, error: "Solo el solicitante originador puede modificar esta solicitud." }, { status: 403 });
    }

    const actividad = await obtenerActividad(env, reservaActual.actividad_id);
    if (!actividad || Number(actividad.requiere_reserva || 0) !== 1) {
      return json({ ok: false, error: "La actividad asociada ya no admite reservas." }, { status: 400 });
    }

    const usaFranjas = Number(actividad.usa_franjas || 0) === 1;
    const estadoActual = String(reservaActual.estado || "").toUpperCase();
    const esBorrador = estadoActual === "BORRADOR";
    const esRechazada = estadoActual === "RECHAZADA";
    const reenviarRechazada = esRechazada && accion !== "guardar_borrador";
    const guardarBorrador = (esBorrador || esRechazada) && (accion === "" || accion === "guardar_borrador");
    const enviarBorrador = esBorrador && accion === "enviar_borrador";

    if (Number(actividad.activa || 0) !== 1 && !guardarBorrador) {
      return json({ ok: false, error: "La actividad asociada estÃ¡ desactivada y no admite el envÃ­o de la solicitud." }, { status: 400 });
    }

    if (usaFranjas && (!Number.isInteger(franjaIdNueva) || franjaIdNueva <= 0)) {
      return json({ ok: false, error: "La franja horaria indicada no es vÃ¡lida." }, { status: 400 });
    }

    if (!usaFranjas && franjaIdNueva !== null) {
      return json({ ok: false, error: "Esta actividad no utiliza franjas horarias." }, { status: 400 });
    }

    if (!esBorrador && !esRechazada) {
      return json({ ok: false, error: "La solicitud no puede modificarse en su estado actual." }, { status: 400 });
    }

    const asistentesCargados = await contarAsistentes(env, reservaActual.id);
    const centroComparacion = normalizarCentroComparacion(centro);

    let franjaNueva = null;
    let disponibilidadActual = null;
    if (usaFranjas) {
      franjaNueva = await obtenerFranja(env, franjaIdNueva);
      if (!franjaNueva) {
        return json({ ok: false, error: "La franja seleccionada no existe." }, { status: 404 });
      }

      if (Number(franjaNueva.actividad_id || 0) !== Number(reservaActual.actividad_id || 0)) {
        return json({ ok: false, error: "La franja seleccionada no pertenece a la actividad indicada." }, { status: 400 });
      }

      disponibilidadActual = await obtenerDisponibilidadFranja(env, franjaIdNueva);
      if (!disponibilidadActual) {
        return json({ ok: false, error: "No se pudo calcular la disponibilidad actual de la franja." }, { status: 400 });
      }
    }

    const necesitaControlDuplicada = !guardarBorrador;
    if (necesitaControlDuplicada) {
      const duplicada = usaFranjas
        ? await existeSolicitudActivaMismoCentroFranjaExcluyendo(
          env,
          franjaIdNueva,
          centroComparacion,
          reservaActual.id
        )
        : await existeSolicitudActivaMismoCentroActividadSinFranjaExcluyendo(
          env,
          reservaActual.actividad_id,
          centroComparacion,
          reservaActual.id
        );

      if (duplicada) {
        return json(
          {
            ok: false,
            error: usaFranjas
              ? "Ya existe una solicitud activa para este centro en la franja seleccionada. Debe modificar la existente, no crear una segunda."
              : "Ya existe una solicitud activa para este centro en esta actividad. Debe modificar la existente, no crear una segunda."
          },
          { status: 409 }
        );
      }
    }

    if (usaFranjas) {
      let disponiblesEditables = Number(disponibilidadActual?.disponibles || 0);

      if (!esBorrador && Number(franjaIdNueva) === Number(reservaActual.franja_id)) {
        const prereservaVigente =
          !!reservaActual.prereserva_expira_en &&
          new Date(String(reservaActual.prereserva_expira_en).replace(" ", "T")) >= new Date();
        const bloqueoActualReserva = prereservaVigente
          ? Number(reservaActual.plazas_prereservadas || 0)
          : asistentesCargados;
        disponiblesEditables += bloqueoActualReserva;
      }

      const totalSolicitado = esBorrador
        ? plazasSolicitadas
        : asistentesCargados + plazasSolicitadas;

      if (totalSolicitado > disponiblesEditables) {
        return json(
          {
            ok: false,
            error: `No hay plazas suficientes en la franja seleccionada. Disponibles para esta operaciÃ³n: ${disponiblesEditables}. Solicitadas: ${totalSolicitado}.`
          },
          { status: 400 }
        );
      }
    }

    if (guardarBorrador) {
      const updateResult = await env.DB.prepare(`
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          personas = ?,
          plazas_prereservadas = ?,
          prereserva_expira_en = NULL,
          observaciones = ?,
          estado = 'BORRADOR',
          fecha_modificacion = datetime('now')
        WHERE id = ?
          AND UPPER(TRIM(COALESCE(estado, ''))) IN ('BORRADOR', 'RECHAZADA')
      `).bind(
        franjaIdNueva,
        centro,
        contacto,
        telefono,
        email,
        plazasSolicitadas,
        plazasSolicitadas,
        observaciones,
        reservaActual.id
      ).run();

      if ((updateResult?.meta?.changes || 0) === 0) {
        return json({ ok: false, error: "No se pudo guardar el borrador." }, { status: 500 });
      }

      return json({
        ok: true,
        estado: "BORRADOR",
        mensaje: "Borrador guardado correctamente.",
        franja: franjaNueva ? {
          id: franjaNueva.id,
          fecha: franjaNueva.fecha,
          hora_inicio: franjaNueva.hora_inicio,
          hora_fin: franjaNueva.hora_fin
        } : null
      });
    }

    if (enviarBorrador) {
      const minutosConsolidacion = calcularMinutosConsolidacion(plazasSolicitadas);
      const prereservaExpiraEn = await obtenerFechaExpiracionSQLite(env, minutosConsolidacion);
      if (!prereservaExpiraEn) {
        return json({ ok: false, error: "No se pudo calcular la expiraciÃ³n de la prereserva." }, { status: 500 });
      }

      const updateResult = await env.DB.prepare(`
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          personas = ?,
          plazas_prereservadas = ?,
          prereserva_expira_en = ?,
          observaciones = ?,
          estado = 'PENDIENTE',
          fecha_solicitud = datetime('now'),
          fecha_modificacion = datetime('now')
        WHERE id = ?
          AND UPPER(TRIM(COALESCE(estado, ''))) = 'BORRADOR'
      `).bind(
        franjaIdNueva,
        centro,
        contacto,
        telefono,
        email,
        plazasSolicitadas,
        plazasSolicitadas,
        prereservaExpiraEn,
        observaciones,
        reservaActual.id
      ).run();

      if ((updateResult?.meta?.changes || 0) === 0) {
        return json({ ok: false, error: "No se pudo enviar el borrador." }, { status: 500 });
      }

      await registrarEventoReserva(env, {
        reservaId: reservaActual.id,
        accion: "SOLICITUD_PRESENTADA",
        estadoOrigen: "BORRADOR",
        estadoDestino: "PENDIENTE",
        observaciones,
        actorUsuarioId: reservaActual.usuario_id,
        actorRol: "SOLICITANTE",
        actorNombre: contacto || centro || "Solicitante"
      });

      let notificacionAdmin = { ok: false, skipped: true, error: "" };
      try {
        notificacionAdmin = await crearNotificacionNuevaSolicitudAdmin(env, {
          adminId: actividad.admin_id,
          actividadId: reservaActual.actividad_id,
          actividadNombre: actividad.actividad_nombre || "Actividad",
          centro,
          codigoReserva: reservaActual.codigo_reserva
        });
      } catch (errorNotificacion) {
        notificacionAdmin = {
          ok: false,
          skipped: true,
          error: errorNotificacion?.message || String(errorNotificacion || "")
        };
      }

      return json({
        ok: true,
        estado: "PENDIENTE",
        mensaje: "Solicitud enviada correctamente.",
        codigo_reserva: reservaActual.codigo_reserva,
        token_edicion: tokenEdicion,
        minutos_consolidacion: minutosConsolidacion,
        prereserva_expira_en: prereservaExpiraEn,
        notificacion_admin: {
          creada: !!notificacionAdmin.ok,
          error: notificacionAdmin.ok ? "" : (notificacionAdmin.error || "")
        }
      });
    }

    const totalBloqueadoNuevo = asistentesCargados + plazasSolicitadas;

    if (reenviarRechazada) {
      const minutosConsolidacion = calcularMinutosConsolidacion(totalBloqueadoNuevo);
      const prereservaExpiraEn = totalBloqueadoNuevo > 0
        ? await obtenerFechaExpiracionSQLite(env, minutosConsolidacion)
        : null;

      if (totalBloqueadoNuevo > 0 && !prereservaExpiraEn) {
        return json({ ok: false, error: "No se pudo calcular la expiración de la prereserva." }, { status: 500 });
      }

      const updateResult = await env.DB.prepare(`
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          personas = ?,
          plazas_prereservadas = ?,
          prereserva_expira_en = ?,
          observaciones = ?,
          estado = 'PENDIENTE',
          fecha_solicitud = datetime('now'),
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `).bind(
        franjaIdNueva,
        centro,
        contacto,
        telefono,
        email,
        totalBloqueadoNuevo,
        totalBloqueadoNuevo,
        prereservaExpiraEn,
        observaciones,
        reservaActual.id
      ).run();

      if ((updateResult?.meta?.changes || 0) === 0) {
        return json({ ok: false, error: "No se pudo reenviar la solicitud." }, { status: 500 });
      }

      await registrarEventoReserva(env, {
        reservaId: reservaActual.id,
        accion: "SOLICITUD_REENVIADA",
        estadoOrigen: "RECHAZADA",
        estadoDestino: "PENDIENTE",
        observaciones,
        actorUsuarioId: reservaActual.usuario_id,
        actorRol: "SOLICITANTE",
        actorNombre: contacto || centro || "Solicitante"
      });

      let notificacionAdmin = { ok: false, skipped: true, error: "" };
      try {
        notificacionAdmin = await crearNotificacionNuevaSolicitudAdmin(env, {
          adminId: actividad.admin_id,
          actividadId: reservaActual.actividad_id,
          actividadNombre: actividad.actividad_nombre || "Actividad",
          centro,
          codigoReserva: reservaActual.codigo_reserva
        });
      } catch (errorNotificacion) {
        notificacionAdmin = {
          ok: false,
          skipped: true,
          error: errorNotificacion?.message || String(errorNotificacion || "")
        };
      }

      const franjaFinal = usaFranjas && franjaIdNueva
        ? await obtenerDisponibilidadFranja(env, franjaIdNueva)
        : null;

      return json({
        ok: true,
        estado: "PENDIENTE",
        mensaje: "Solicitud reenviada correctamente y pendiente de nueva validación.",
        codigo_reserva: reservaActual.codigo_reserva,
        token_edicion: tokenEdicion,
        minutos_consolidacion: minutosConsolidacion,
        prereserva_expira_en: prereservaExpiraEn,
        plazas_asignadas: asistentesCargados,
        plazas_reservadas: plazasSolicitadas,
        plazas_bloqueadas_total: totalBloqueadoNuevo,
        franja: franjaFinal ? {
          id: franjaFinal.id,
          fecha: franjaFinal.fecha,
          hora_inicio: franjaFinal.hora_inicio,
          hora_fin: franjaFinal.hora_fin
        } : null,
        disponibles_despues: franjaFinal ? Number(franjaFinal.disponibles || 0) : null,
        notificacion_admin: {
          creada: !!notificacionAdmin.ok,
          error: notificacionAdmin.ok ? "" : (notificacionAdmin.error || "")
        }
      });
    }

    let sqlUpdate;
    let bindValues;

    if (plazasSolicitadas > 0) {
      sqlUpdate = `
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          personas = ?,
          plazas_prereservadas = ?,
          prereserva_expira_en = datetime('now', '+2 hours'),
          observaciones = ?,
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `;

      bindValues = [
        franjaIdNueva,
        centro,
        contacto,
        telefono,
        email,
        totalBloqueadoNuevo,
        totalBloqueadoNuevo,
        observaciones,
        reservaActual.id
      ];
    } else {
      sqlUpdate = `
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          personas = ?,
          plazas_prereservadas = ?,
          observaciones = ?,
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `;

      bindValues = [
        franjaIdNueva,
        centro,
        contacto,
        telefono,
        email,
        totalBloqueadoNuevo,
        totalBloqueadoNuevo,
        observaciones,
        reservaActual.id
      ];
    }

    const updateResult = await env.DB.prepare(sqlUpdate).bind(...bindValues).run();

    if ((updateResult?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo actualizar la solicitud." }, { status: 500 });
    }

    const franjaFinal = usaFranjas && franjaIdNueva
      ? await obtenerDisponibilidadFranja(env, franjaIdNueva)
      : null;

    return json({
      ok: true,
      mensaje: "Solicitud actualizada correctamente.",
      plazas_asignadas: asistentesCargados,
      plazas_reservadas: plazasSolicitadas,
      plazas_bloqueadas_total: totalBloqueadoNuevo,
      franja: franjaFinal ? {
        id: franjaFinal.id,
        fecha: franjaFinal.fecha,
        hora_inicio: franjaFinal.hora_inicio,
        hora_fin: franjaFinal.hora_fin
      } : null,
      disponibles_despues: franjaFinal ? Number(franjaFinal.disponibles || 0) : null
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error interno al actualizar la solicitud.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}


