import { requireAdminSession, getAdminSession } from "./_auth.js";
import { checkAdminActividad } from "./_permisos.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function normalizarFecha(valor) {
  return String(valor || "").trim();
}

function normalizarHora(valor) {
  return String(valor || "").trim();
}

function parsearCapacidad(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) ? n : NaN;
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function validarDatosFranja({ fecha, hora_inicio, hora_fin, capacidad }) {
  if (!fecha || !hora_inicio || !hora_fin) {
    return "Faltan campos obligatorios de la franja.";
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return "La fecha debe tener formato YYYY-MM-DD.";
  }

  if (!/^\d{2}:\d{2}$/.test(hora_inicio) || !/^\d{2}:\d{2}$/.test(hora_fin)) {
    return "Las horas deben tener formato HH:MM.";
  }

  if (!(capacidad > 0)) {
    return "La capacidad debe ser un entero mayor que 0.";
  }

  if (hora_inicio >= hora_fin) {
    return "La hora de inicio debe ser anterior a la hora de fin.";
  }

  return null;
}

async function obtenerActividad(env, actividad_id) {
  return await env.DB.prepare(`
    SELECT id, nombre, tipo, fecha_inicio, fecha_fin
    FROM actividades
    WHERE id = ?
    LIMIT 1
  `)
    .bind(actividad_id)
    .first();
}

function validarFechaDentroDeActividad(actividad, fecha) {
  if (!actividad) {
    return "La actividad indicada no existe.";
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
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN
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
  const sql = `
    SELECT
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.actividad_id,
      COUNT(CASE WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN r.id END) AS numero_reservas,
      COALESCE(SUM(
        CASE
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN
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
      f.actividad_id
    ORDER BY
      f.fecha,
      f.hora_inicio,
      f.hora_fin
  `;

  const result = await env.DB.prepare(sql).bind(actividad_id).all();
  const rows = result.results || [];

  return rows.map(row => {
    const capacidad = Number(row.capacidad || 0);
    const ocupadas = Number(row.ocupadas || 0);

    return {
      ...row,
      capacidad,
      ocupadas,
      disponibles: Math.max(capacidad - ocupadas, 0)
    };
  });
}

async function obtenerFranjaPorId(env, id) {
  return await env.DB.prepare(`
    SELECT id, actividad_id, fecha, hora_inicio, hora_fin, capacidad
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
    const session = await getAdminSession(request, env);
    const data = await request.json();

    const actividad_id = parsearIdPositivo(data.actividad_id);
    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHora(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);

    if (!actividad_id) {
      return json({ ok: false, error: "actividad_id es obligatorio." }, { status: 400 });
    }

    await checkAdminActividad(env, session.usuario_id, actividad_id);

    const errorValidacion = validarDatosFranja({
      fecha,
      hora_inicio,
      hora_fin,
      capacidad
    });

    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, { status: 400 });
    }

    const actividad = await obtenerActividad(env, actividad_id);
    const errorFecha = validarFechaDentroDeActividad(actividad, fecha);

    if (errorFecha) {
      return json({ ok: false, error: errorFecha }, { status: 400 });
    }

    const duplicada = await env.DB.prepare(`
      SELECT id
      FROM franjas
      WHERE actividad_id = ?
        AND fecha = ?
        AND hora_inicio = ?
        AND hora_fin = ?
      LIMIT 1
    `)
      .bind(actividad_id, fecha, hora_inicio, hora_fin)
      .first();

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe una franja con esa fecha y ese rango horario para esta actividad."
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
        actividad_id
      )
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(fecha, hora_inicio, hora_fin, capacidad, actividad_id)
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
    const session = await getAdminSession(request, env);
    const data = await request.json();

    const id = parsearIdPositivo(data.id);
    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHora(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);

    if (!id) {
      return json({ ok: false, error: "ID de franja no válido." }, { status: 400 });
    }

    const errorValidacion = validarDatosFranja({
      fecha,
      hora_inicio,
      hora_fin,
      capacidad
    });

    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, { status: 400 });
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
    const errorFecha = validarFechaDentroDeActividad(actividad, fecha);

    if (errorFecha) {
      return json({ ok: false, error: errorFecha }, { status: 400 });
    }

    const duplicada = await env.DB.prepare(`
      SELECT id
      FROM franjas
      WHERE actividad_id = ?
        AND fecha = ?
        AND hora_inicio = ?
        AND hora_fin = ?
        AND id <> ?
      LIMIT 1
    `)
      .bind(existente.actividad_id, fecha, hora_inicio, hora_fin, id)
      .first();

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe otra franja con esa fecha y ese rango horario para esta actividad."
        },
        { status: 409 }
      );
    }

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

    const updateResult = await env.DB.prepare(`
      UPDATE franjas
      SET
        fecha = ?,
        hora_inicio = ?,
        hora_fin = ?,
        capacidad = ?
      WHERE id = ?
    `)
      .bind(fecha, hora_inicio, hora_fin, capacidad, id)
      .run();

    if ((updateResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo actualizar la franja." },
        { status: 500 }
      );
    }

    const franjas = await obtenerResumenFranjas(env, existente.actividad_id);

    return json({
      ok: true,
      mensaje: "Franja actualizada correctamente.",
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

    const ocupadas = await obtenerBloqueoActualFranja(env, id);

    if (ocupadas > 0) {
      return json(
        {
          ok: false,
          error: "No se puede eliminar la franja porque tiene plazas bloqueadas o asistentes asociados."
        },
        { status: 400 }
      );
    }

    const uso = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM reservas
      WHERE franja_id = ?
        AND estado IN ('PENDIENTE', 'CONFIRMADA')
    `)
      .bind(id)
      .first();

    const totalReservas = Number(uso?.total || 0);

    if (totalReservas > 0) {
      return json(
        {
          ok: false,
          error: "No se puede eliminar la franja porque tiene reservas operativas asociadas."
        },
        { status: 400 }
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
