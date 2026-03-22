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
      ON r.franja_id = f.id

    WHERE f.actividad_id = ?

    GROUP BY
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad

    ORDER BY
      f.fecha ASC,
      f.hora_inicio ASC
  `;

  const result = await env.DB.prepare(sql).bind(actividad_id).all();
  const rows = result.results || [];

  return rows.map(row => {
    const capacidad = Number(row.capacidad || 0);
    const ocupadas = Number(row.ocupadas || 0);

    return {
      id: row.id,
      fecha: row.fecha,
      hora_inicio: row.hora_inicio,
      hora_fin: row.hora_fin,
      capacidad,
      ocupadas,
      disponibles: Math.max(capacidad - ocupadas, 0)
    };
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;

  try {
    const url = new URL(request.url);
    const actividad_id = Number(url.searchParams.get("actividad_id"));

    if (!Number.isInteger(actividad_id) || actividad_id <= 0) {
      return json({ ok: false, error: "Actividad obligatoria" }, { status: 400 });
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
