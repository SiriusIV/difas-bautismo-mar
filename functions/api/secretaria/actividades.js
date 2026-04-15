import { getUserSession } from "../usuario/_auth.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    if (!session?.id) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    if (String(session.rol || "").toUpperCase() !== "SECRETARIA") {
      return json({ ok: false, error: "No autorizado." }, { status: 403 });
    }

    const adminsResult = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM usuarios
      WHERE secretaria_usuario_id = ?
        AND COALESCE(modulo_secretaria, 0) = 0
        AND rol = 'ADMIN'
    `).bind(session.id).first();

    const result = await env.DB.prepare(`
      WITH admins_secretaria AS (
        SELECT id
        FROM usuarios
        WHERE secretaria_usuario_id = ?
          AND COALESCE(modulo_secretaria, 0) = 0
          AND rol = 'ADMIN'
      ),
      franja_ocupacion AS (
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
      actividad_totales AS (
        SELECT
          actividad_id,
          COALESCE(SUM(capacidad), 0) AS plazas_totales,
          COALESCE(SUM(ocupadas), 0) AS plazas_ocupadas
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
        a.lugar,
        a.imagen_url,
        a.visible_portal,
        a.orden_portal,
        a.organizador_publico,
        a.latitud,
        a.longitud,
        a.direccion_postal,
        a.zoom_mapa,
        a.usa_franjas,
        a.requiere_reserva,
        a.aforo_limitado,
        a.admin_id,
        a.provincia,
        a.es_recurrente,
        a.patron_recurrencia,
        a.usa_enlace_externo,
        a.enlace_externo_url,
        COALESCE(at.plazas_totales, 0) AS plazas_totales,
        COALESCE(at.plazas_ocupadas, 0) AS plazas_ocupadas,
        (COALESCE(at.plazas_totales, 0) - COALESCE(at.plazas_ocupadas, 0)) AS plazas_disponibles,
        CASE
          WHEN a.aforo_limitado = 1
               AND a.usa_franjas = 1
               AND COALESCE(at.plazas_totales, 0) > 0
               AND (COALESCE(at.plazas_totales, 0) - COALESCE(at.plazas_ocupadas, 0)) <= 0
            THEN 1
          ELSE 0
        END AS completa_calculada
      FROM actividades a
      INNER JOIN admins_secretaria s
        ON s.id = a.admin_id
      LEFT JOIN actividad_totales at
        ON at.actividad_id = a.id
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
    `).bind(session.id).all();

    return json({
      ok: true,
      admins_asociados: Number(adminsResult?.total || 0),
      actividades: (result.results || []).map((a) => ({
        ...a,
        plazas_totales: Number(a.plazas_totales || 0),
        plazas_ocupadas: Number(a.plazas_ocupadas || 0),
        plazas_disponibles: Number(a.plazas_disponibles || 0),
        completa_calculada: Number(a.completa_calculada || 0)
      }))
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudieron cargar las actividades de la secretaría.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
