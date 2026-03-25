function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const result = await env.DB.prepare(`
      WITH franja_ocupacion AS (
        SELECT
          f.id AS franja_id,
          f.actividad_id,
          f.capacidad,
          COALESCE(SUM(
            CASE
              WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN
                CASE
                  WHEN r.prereserva_expira_en IS NOT NULL
                       AND datetime('now') <= datetime(r.prereserva_expira_en)
                    THEN max(
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
        GROUP BY
          f.id,
          f.actividad_id,
          f.capacidad
      ),
      actividad_disponibilidad AS (
        SELECT
          actividad_id,
          COALESCE(SUM(
            CASE
              WHEN (capacidad - ocupadas) > 0 THEN (capacidad - ocupadas)
              ELSE 0
            END
          ), 0) AS plazas_disponibles
        FROM franja_ocupacion
        GROUP BY actividad_id
      )
      SELECT
        a.id,
        a.nombre,
        a.tipo,
        a.fecha_inicio,
        a.fecha_fin,
        a.titulo_publico,
        a.subtitulo_publico,
        a.descripcion_corta,
        a.descripcion_larga,
        a.lugar,
        a.imagen_url,
        a.visible_portal,
        a.orden_portal,
        a.latitud,
        a.longitud,
        a.direccion_postal,
        a.zoom_mapa,
        COALESCE(ad.plazas_disponibles, 0) AS plazas_disponibles,
        CASE
          WHEN COALESCE(ad.plazas_disponibles, 0) <= 0 THEN 1
          ELSE 0
        END AS completa
      FROM actividades a
      LEFT JOIN actividad_disponibilidad ad
        ON ad.actividad_id = a.id
      WHERE a.activa = 1
        AND a.visible_portal = 1
        AND (
          a.tipo = 'PERMANENTE'
          OR (
            a.tipo = 'TEMPORAL'
            AND (
              a.fecha_fin IS NULL
              OR date(a.fecha_fin) >= date('now')
            )
          )
        )
      ORDER BY a.orden_portal ASC, a.id ASC
    `).all();

    return json({
      ok: true,
      actividades: result.results || []
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudieron cargar las actividades.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
