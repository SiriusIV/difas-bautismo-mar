import { ejecutarMantenimientoReservas } from "./_reservas_mantenimiento.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

async function obtenerFranjasConDisponibilidad(env, actividad_id) {
  const sql = `
    SELECT
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.es_recurrente,
      f.patron_recurrencia,

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
      ON r.franja_id = f.id

    WHERE f.actividad_id = ?

    GROUP BY
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.es_recurrente,
      f.patron_recurrencia

    ORDER BY
      CASE WHEN COALESCE(f.es_recurrente, 0) = 1 THEN 1 ELSE 0 END,
      f.fecha ASC,
      f.patron_recurrencia ASC,
      f.hora_inicio ASC
  `;

  const result = await env.DB.prepare(sql).bind(actividad_id).all();
  const rows = result.results || [];

  return rows.map(row => {
    const capacidad = row.capacidad == null ? null : Number(row.capacidad || 0);
    const ocupadas = Number(row.ocupadas || 0);

    return {
      id: row.id,
      fecha: row.fecha,
      es_recurrente: Number(row.es_recurrente || 0),
      patron_recurrencia: row.patron_recurrencia || null,
      hora_inicio: row.hora_inicio,
      hora_fin: row.hora_fin,
      capacidad,
      ocupadas,
      disponibles: capacidad == null ? null : Math.max(capacidad - ocupadas, 0)
    };
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;

  try {
    await ejecutarMantenimientoReservas(env);
    const url = new URL(request.url);
    const actividad_id = Number(url.searchParams.get("actividad_id"));

    if (!Number.isInteger(actividad_id) || actividad_id <= 0) {
      return json({ ok: false, error: "Actividad obligatoria" }, { status: 400 });
    }

    const actividad = await env.DB.prepare(`
      SELECT usa_franjas
      FROM actividades
      WHERE id = ?
      LIMIT 1
    `).bind(actividad_id).first();

    if (!actividad) {
      return json({ ok: false, error: "Actividad no encontrada." }, { status: 404 });
    }

    if (Number(actividad.usa_franjas || 0) !== 1) {
      return json({
        ok: true,
        franjas: []
      });
    }

    const franjas = await obtenerFranjasConDisponibilidad(env, actividad_id);

    return json({
      ok: true,
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudieron cargar las franjas.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
