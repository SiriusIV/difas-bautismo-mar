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

        -- PLAZAS DISPONIBLES REALES
        COALESCE((
          SELECT SUM(
            f.capacidad -
            COALESCE((
              SELECT SUM(
                CASE
                  WHEN r.estado IN ('PENDIENTE','CONFIRMADA') THEN
                    CASE
                      WHEN r.prereserva_expira_en IS NOT NULL
                           AND datetime('now') <= datetime(r.prereserva_expira_en)
                        THEN MAX(
                          COALESCE(r.plazas_prereservadas,0),
                          COALESCE((
                            SELECT COUNT(*)
                            FROM visitantes v
                            WHERE v.reserva_id = r.id
                          ),0)
                        )
                      ELSE COALESCE((
                        SELECT COUNT(*)
                        FROM visitantes v
                        WHERE v.reserva_id = r.id
                      ),0)
                    END
                  ELSE 0
                END
              )
              FROM reservas r
              WHERE r.franja_id = f.id
            ),0)
          )
          FROM franjas f
          WHERE f.actividad_id = a.id
        ),0) AS plazas_disponibles,

        -- FLAG COMPLETA
        CASE
          WHEN COALESCE((
            SELECT SUM(
              f.capacidad -
              COALESCE((
                SELECT SUM(
                  CASE
                    WHEN r.estado IN ('PENDIENTE','CONFIRMADA') THEN
                      CASE
                        WHEN r.prereserva_expira_en IS NOT NULL
                             AND datetime('now') <= datetime(r.prereserva_expira_en)
                          THEN MAX(
                            COALESCE(r.plazas_prereservadas,0),
                            COALESCE((
                              SELECT COUNT(*)
                              FROM visitantes v
                              WHERE v.reserva_id = r.id
                            ),0)
                          )
                        ELSE COALESCE((
                          SELECT COUNT(*)
                          FROM visitantes v
                          WHERE v.reserva_id = r.id
                        ),0)
                      END
                    ELSE 0
                  END
                )
                FROM reservas r
                WHERE r.franja_id = f.id
              ),0)
            )
            FROM franjas f
            WHERE f.actividad_id = a.id
          ),0) <= 0
          THEN 1 ELSE 0
        END AS completa

      FROM actividades a
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
