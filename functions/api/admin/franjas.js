import { requireAdminSession, getAdminSession } from "./_auth.js";
import { checkAdminActividad } from "./_permisos.js";

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

function validarDatosFranja({
  fecha,
  hora_inicio,
  hora_fin,
  capacidad,
  es_recurrente,
  patron_recurrencia,
  aforo_limitado
}) {
  if (!hora_inicio || !hora_fin) {
    return "Faltan las horas de la franja.";
  }

  if (!/^\d{2}:\d{2}$/.test(hora_inicio) || !/^\d{2}:\d{2}$/.test(hora_fin)) {
    return "Las horas deben tener formato HH:MM.";
  }

  if (hora_inicio >= hora_fin) {
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
  return await env.DB.prepare(`
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
      f.es_recurrente,
      f.patron_recurrencia,
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
      f.actividad_id,
      f.es_recurrente,
      f.patron_recurrencia
    ORDER BY
      CASE WHEN f.es_recurrente = 1 THEN 1 ELSE 0 END,
      f.fecha,
      f.patron_recurrencia,
      f.hora_inicio,
      f.hora_fin
  `;

  const result = await env.DB.prepare(sql).bind(actividad_id).all();
  const rows = result.results || [];

  return rows.map(row => {
    const capacidad = row.capacidad === null || row.capacidad === undefined ? null : Number(row.capacidad || 0);
    const ocupadas = aforoLimitado ? Number(row.ocupadas || 0) : 0;

    return {
      ...row,
      es_recurrente: Number(row.es_recurrente || 0),
      capacidad,
      ocupadas,
      disponibles: aforoLimitado && capacidad !== null ? Math.max(capacidad - ocupadas, 0) : null,
      numero_reservas: aforoLimitado ? Number(row.numero_reservas || 0) : 0
    };
  });
}

async function obtenerFranjaPorId(env, id) {
  return await env.DB.prepare(`
    SELECT
      id,
      actividad_id,
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
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
    const es_recurrente = parsearFlag(data.es_recurrente, 0);
    const patron_recurrencia = normalizarTexto(data.patron_recurrencia);

    if (!actividad_id) {
      return json({ ok: false, error: "actividad_id es obligatorio." }, { status: 400 });
    }

    await checkAdminActividad(env, session.usuario_id, actividad_id);

    const actividad = await obtenerActividad(env, actividad_id);

    if (!actividad) {
      return json({ ok: false, error: "Actividad no válida." }, { status: 400 });
    }
    
    const aforo_limitado = Number(actividad?.aforo_limitado || 0);

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
          AND hora_fin = ?
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
          AND hora_fin = ?
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
    const session = await getAdminSession(request, env);
    const data = await request.json();

    const id = parsearIdPositivo(data.id);
    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHora(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);
    const es_recurrente = parsearFlag(data.es_recurrente, 0);
    const patron_recurrencia = normalizarTexto(data.patron_recurrencia);

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
    const aforo_limitado = Number(actividad?.aforo_limitado || 0);

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
          AND hora_fin = ?
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
          AND hora_fin = ?
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

    const actividad = await obtenerActividad(env, existente.actividad_id);
    const aforo_limitado = Number(actividad?.aforo_limitado || 0);

    if (aforo_limitado === 1) {
      const ocupadas = await obtenerBloqueoActualFranja(env, id);

if (Number(actividad.borrador_tecnico) === 1) {
  // en borrador se permite borrar siempre
} else {
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
}
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
