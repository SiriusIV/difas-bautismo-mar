import { requireAdminSession } from "./_auth.js";

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

async function obtenerResumenFranjas(env) {
  const sql = `
    SELECT
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      COUNT(CASE WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN r.id END) AS numero_reservas,
      COALESCE(SUM(
        CASE
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN r.personas
          ELSE 0
        END
      ), 0) AS ocupadas,
      (
        f.capacidad - COALESCE(SUM(
          CASE
            WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN r.personas
            ELSE 0
          END
        ), 0)
      ) AS disponibles
    FROM franjas f
    LEFT JOIN reservas r
      ON f.id = r.franja_id
    GROUP BY
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad
    ORDER BY
      f.fecha,
      f.hora_inicio,
      f.hora_fin
  `;

  const result = await env.DB.prepare(sql).all();
  return result.results || [];
}

export async function onRequestGet(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { env } = context;

  try {
    const franjas = await obtenerResumenFranjas(env);

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
    const data = await request.json();

    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHora(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);

    const errorValidacion = validarDatosFranja({
      fecha,
      hora_inicio,
      hora_fin,
      capacidad
    });

    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, { status: 400 });
    }

    const duplicada = await env.DB.prepare(`
      SELECT id
      FROM franjas
      WHERE fecha = ?
        AND hora_inicio = ?
        AND hora_fin = ?
      LIMIT 1
    `)
      .bind(fecha, hora_inicio, hora_fin)
      .first();

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe una franja con esa fecha y ese rango horario."
        },
        { status: 409 }
      );
    }

    const insertResult = await env.DB.prepare(`
      INSERT INTO franjas (
        fecha,
        hora_inicio,
        hora_fin,
        capacidad
      )
      VALUES (?, ?, ?, ?)
    `)
      .bind(fecha, hora_inicio, hora_fin, capacidad)
      .run();

    if ((insertResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo crear la franja." },
        { status: 500 }
      );
    }

    const franjas = await obtenerResumenFranjas(env);

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
    const data = await request.json();

    const id = parseInt(data.id, 10);
    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHora(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);

    if (!Number.isInteger(id) || id <= 0) {
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

    const existente = await env.DB.prepare(`
      SELECT id
      FROM franjas
      WHERE id = ?
      LIMIT 1
    `)
      .bind(id)
      .first();

    if (!existente) {
      return json(
        { ok: false, error: "La franja indicada no existe." },
        { status: 404 }
      );
    }

    const duplicada = await env.DB.prepare(`
      SELECT id
      FROM franjas
      WHERE fecha = ?
        AND hora_inicio = ?
        AND hora_fin = ?
        AND id <> ?
      LIMIT 1
    `)
      .bind(fecha, hora_inicio, hora_fin, id)
      .first();

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe otra franja con esa fecha y ese rango horario."
        },
        { status: 409 }
      );
    }

    const ocupacion = await env.DB.prepare(`
      SELECT COALESCE(SUM(personas), 0) AS ocupadas
      FROM reservas
      WHERE franja_id = ?
        AND estado IN ('PENDIENTE', 'CONFIRMADA')
    `)
      .bind(id)
      .first();

    const ocupadas = Number(ocupacion?.ocupadas || 0);

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

    const franjas = await obtenerResumenFranjas(env);

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
    const data = await request.json();
    const id = parseInt(data.id, 10);

    if (!Number.isInteger(id) || id <= 0) {
      return json({ ok: false, error: "ID de franja no válido." }, { status: 400 });
    }

    const existente = await env.DB.prepare(`
      SELECT id
      FROM franjas
      WHERE id = ?
      LIMIT 1
    `)
      .bind(id)
      .first();

    if (!existente) {
      return json(
        { ok: false, error: "La franja indicada no existe." },
        { status: 404 }
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

    const franjas = await obtenerResumenFranjas(env);

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
