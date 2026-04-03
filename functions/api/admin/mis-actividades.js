import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const rol = await getRolUsuario(env, session.usuario_id);

    let sql = `
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
        a.imagen_id,
        a.visible_portal,
        a.orden_portal,
        a.organizador_publico,
        a.activa,
        a.admin_id,
        a.usa_franjas,
        a.requiere_reserva,
        a.aforo_limitado,
        a.provincia,
        a.es_recurrente,
        a.patron_recurrencia,
        a.usa_enlace_externo,
        a.enlace_externo_url,
        a.enlace_externo_texto,
        a.direccion_postal,
        a.latitud,
        a.longitud,
        a.borrador_tecnico,
        a.zoom_mapa,

        /* plazas totales */
        (
          SELECT COALESCE(SUM(f.capacidad), 0)
          FROM franjas f
          WHERE f.actividad_id = a.id
        ) AS plazas_totales,

        /* plazas ocupadas reales */
        (
          SELECT COALESCE(SUM(
            CASE
              WHEN r.prereserva_expira_en IS NOT NULL
                   AND datetime('now') <= r.prereserva_expira_en
              THEN r.plazas_prereservadas
              ELSE (
                SELECT COUNT(*)
                FROM visitantes v
                WHERE v.reserva_id = r.id
              )
            END
          ), 0)
          FROM reservas r
          WHERE r.actividad_id = a.id
            AND r.estado IN ('PENDIENTE', 'CONFIRMADA')
        ) AS plazas_ocupadas,

        /* plazas disponibles */
        (
          (
            SELECT COALESCE(SUM(f.capacidad), 0)
            FROM franjas f
            WHERE f.actividad_id = a.id
          ) -
          (
            SELECT COALESCE(SUM(
              CASE
                WHEN r.prereserva_expira_en IS NOT NULL
                     AND datetime('now') <= r.prereserva_expira_en
                THEN r.plazas_prereservadas
                ELSE (
                  SELECT COUNT(*)
                  FROM visitantes v
                  WHERE v.reserva_id = r.id
                )
              END
            ), 0)
            FROM reservas r
            WHERE r.actividad_id = a.id
              AND r.estado IN ('PENDIENTE', 'CONFIRMADA')
          )
        ) AS plazas_disponibles

      FROM actividades a
    `;

    const binds = [];

    if (rol !== "SUPERADMIN") {
      sql += ` WHERE a.admin_id = ?`;
      binds.push(session.usuario_id);
    }

    sql += ` ORDER BY a.orden_portal ASC, a.id ASC`;

    const result = await env.DB.prepare(sql).bind(...binds).all();
    const actividades = (result.results || []).map((a) => ({
      ...a,
      plazas_totales: Number(a.plazas_totales || 0),
      plazas_ocupadas: Number(a.plazas_ocupadas || 0),
      plazas_disponibles: Number(a.plazas_disponibles || 0),
      completa_calculada:
        Number(a.aforo_limitado || 0) === 1 &&
        Number(a.usa_franjas || 0) === 1 &&
        Number(a.plazas_totales || 0) > 0 &&
        Number(a.plazas_disponibles || 0) <= 0
          ? 1
          : 0
    }));

    return json({
      ok: true,
      actividades
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudieron cargar las actividades del administrador.",
        detalle: error.message
      },
      500
    );
  }
}
