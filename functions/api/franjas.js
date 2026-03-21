function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

async function obtenerFranjasConDisponibilidad(env) {
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

  const result = await env.DB.prepare(sql).all();
  return result.results || [];
}

export async function onRequestGet(context) {
  const { env, request } = context;

  try {
    const url = new URL(request.url);
    const actividad_id = Number(url.searchParams.get("actividad_id"));

    if (!actividad_id) {
      return json({ ok: false, error: "Actividad obligatoria" }, 400);
    }

    const franjas = await obtenerFranjasConDisponibilidad(env, actividad_id);

    return json(
      franjas.map(f => ({
        id: f.id,
        fecha: f.fecha,
        hora_inicio: f.hora_inicio,
        hora_fin: f.hora_fin,
        capacidad: Number(f.capacidad || 0),
        ocupadas: Number(f.ocupadas || 0),
        disponibles: Number(f.disponibles || 0)
      }))
    );
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
