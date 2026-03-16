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

async function obtenerReservaPorToken(env, tokenEdicion) {
  const sql = `
    SELECT
      r.id,
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
      f.fecha,
      f.hora_inicio,
      f.hora_fin
    FROM reservas r
    INNER JOIN franjas f
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
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN
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
            WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN
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

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();

    const tokenEdicion = limpiarTexto(data.token_edicion);
    const centro = limpiarTexto(data.centro);
    const contacto = limpiarTexto(data.contacto);
    const telefono = limpiarTexto(data.telefono);
    const email = limpiarTexto(data.email);
    const observaciones = limpiarTexto(data.observaciones);
    const franjaIdNueva = parseInt(data.franja, 10);

    // ESTE CAMPO AHORA SIGNIFICA: plazas reservadas pendientes de asignar
    const plazasReservadasPendientes = parseInt(data.plazas_reservadas, 10);

    if (!tokenEdicion) {
      return json({ ok: false, error: "Falta el token de edición." }, { status: 400 });
    }

    if (!centro || !contacto || !telefono || !email) {
      return json({ ok: false, error: "Faltan datos obligatorios del solicitante." }, { status: 400 });
    }

    if (!esEmailValido(email)) {
      return json({ ok: false, error: "El correo electrónico no tiene un formato válido." }, { status: 400 });
    }

    if (!Number.isInteger(franjaIdNueva) || franjaIdNueva <= 0) {
      return json({ ok: false, error: "La franja horaria indicada no es válida." }, { status: 400 });
    }

    if (!Number.isInteger(plazasReservadasPendientes) || plazasReservadasPendientes < 0) {
      return json({ ok: false, error: "Debe indicar un número de plazas reservadas válido." }, { status: 400 });
    }

    const reservaActual = await obtenerReservaPorToken(env, tokenEdicion);

    if (!reservaActual) {
      return json({ ok: false, error: "No existe ninguna reserva con ese token." }, { status: 404 });
    }

    if (!["PENDIENTE", "CONFIRMADA"].includes(reservaActual.estado)) {
      return json({ ok: false, error: "La solicitud no puede modificarse en su estado actual." }, { status: 400 });
    }

    const asistentesCargados = await contarAsistentes(env, reservaActual.id);
    const totalBloqueadoNuevo = asistentesCargados + plazasReservadasPendientes;

    const centroComparacion = normalizarCentroComparacion(centro);

    const duplicada = await existeSolicitudActivaMismoCentroFranjaExcluyendo(
      env,
      franjaIdNueva,
      centroComparacion,
      reservaActual.id
    );

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe una solicitud activa para este centro en la franja seleccionada. Debe modificar la existente, no crear una segunda."
        },
        { status: 409 }
      );
    }

    const franjaNueva = await obtenerDisponibilidadFranja(env, franjaIdNueva);

    if (!franjaNueva) {
      return json({ ok: false, error: "La franja seleccionada no existe." }, { status: 404 });
    }

    let disponiblesEditables = Number(franjaNueva.disponibles || 0);

    // Lo actualmente bloqueado por esta reserva es:
    // si la prereserva sigue vigente, plazas_prereservadas
    // si ya venció, asistentes_cargados
    const prereservaVigente =
      !!reservaActual.prereserva_expira_en &&
      new Date(reservaActual.prereserva_expira_en.replace(" ", "T")) >= new Date();

    const bloqueoActualReserva = prereservaVigente
      ? Number(reservaActual.plazas_prereservadas || 0)
      : asistentesCargados;

    if (Number(franjaIdNueva) === Number(reservaActual.franja_id)) {
      disponiblesEditables += bloqueoActualReserva;
    }

    if (totalBloqueadoNuevo > disponiblesEditables) {
      return json(
        {
          ok: false,
          error: `No hay plazas suficientes en la franja seleccionada. Disponibles para esta modificación: ${disponiblesEditables}. Solicitadas: ${totalBloqueadoNuevo}.`
        },
        { status: 400 }
      );
    }

    let sqlUpdate;
    let bindValues;

    if (plazasReservadasPendientes > 0) {
      // Si el usuario abre nuevas plazas reservadas pendientes, reiniciamos ventana de 2 horas
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
      // Si no hay plazas reservadas pendientes, queda solo lo asignado
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

    const franjaFinal = await obtenerDisponibilidadFranja(env, franjaIdNueva);

    return json({
      ok: true,
      mensaje: "Solicitud actualizada correctamente.",
      plazas_asignadas: asistentesCargados,
      plazas_reservadas: plazasReservadasPendientes,
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
