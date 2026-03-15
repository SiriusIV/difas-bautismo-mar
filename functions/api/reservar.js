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

function generarCodigoReserva() {
  const ahora = new Date();
  const y = ahora.getFullYear();
  const m = String(ahora.getMonth() + 1).padStart(2, "0");
  const d = String(ahora.getDate()).padStart(2, "0");
  const aleatorio = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RES-${y}${m}${d}-${aleatorio}`;
}

function generarTokenEdicion() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "tok-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function esEmailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

  return await env.DB.prepare(sql).bind(franjaId, centroComparacion).first();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();

    const centro = limpiarTexto(data.centro);
    const contacto = limpiarTexto(data.contacto);
    const telefono = limpiarTexto(data.telefono);
    const email = limpiarTexto(data.email);
    const observaciones = limpiarTexto(data.observaciones);
    const franjaId = parseInt(data.franja, 10);
    const plazasSolicitadas = parseInt(data.plazas_solicitadas, 10);

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

    if (!Number.isInteger(franjaId) || franjaId <= 0) {
      return json(
        { ok: false, error: "La franja horaria indicada no es válida." },
        { status: 400 }
      );
    }

    if (!Number.isInteger(plazasSolicitadas) || plazasSolicitadas <= 0) {
      return json(
        { ok: false, error: "Debe indicar un número de plazas solicitadas válido." },
        { status: 400 }
      );
    }

    const centroComparacion = normalizarCentroComparacion(centro);

    const duplicada = await existeSolicitudActivaMismoCentroFranja(env, franjaId, centroComparacion);

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe una solicitud activa para este centro en la franja seleccionada. Debe recuperar esa solicitud y ampliarla o modificarla, pero no crear una segunda."
        },
        { status: 409 }
      );
    }

    const franja = await obtenerDisponibilidadFranja(env, franjaId);

    if (!franja) {
      return json(
        { ok: false, error: "La franja seleccionada no existe." },
        { status: 404 }
      );
    }

    const disponibles = Number(franja.disponibles || 0);

    if (plazasSolicitadas > disponibles) {
      return json(
        {
          ok: false,
          error: `No hay plazas suficientes en la franja seleccionada. Disponibles: ${disponibles}. Solicitadas: ${plazasSolicitadas}.`
        },
        { status: 400 }
      );
    }

    const codigoReserva = generarCodigoReserva();
    const tokenEdicion = generarTokenEdicion();

    const insertSql = `
      INSERT INTO reservas (
        franja_id,
        centro,
        contacto,
        telefono,
        email,
        mayores10,
        menores10,
        personas,
        plazas_prereservadas,
        prereserva_expira_en,
        observaciones,
        fecha_solicitud,
        fecha_modificacion,
        codigo_reserva,
        token_edicion,
        estado
      )
      VALUES (
        ?, ?, ?, ?, ?,
        0, 0,
        ?, ?,
        datetime('now', '+2 hours'),
        ?,
        datetime('now'),
        datetime('now'),
        ?, ?,
        'PENDIENTE'
      )
    `;

    const insertResult = await env.DB.prepare(insertSql)
      .bind(
        franjaId,
        centro,
        contacto,
        telefono,
        email,
        plazasSolicitadas,
        plazasSolicitadas,
        observaciones,
        codigoReserva,
        tokenEdicion
      )
      .run();

    if ((insertResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo crear la solicitud." },
        { status: 500 }
      );
    }

    const franjaFinal = await obtenerDisponibilidadFranja(env, franjaId);

return json({
  ok: true,
  mensaje: "Solicitud creada correctamente.",
  codigo_reserva: codigoReserva,
  token_edicion: tokenEdicion,
  estado: "PENDIENTE",
  plazas_prereservadas: plazasSolicitadas,
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
        error: "Error interno al crear la solicitud.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
