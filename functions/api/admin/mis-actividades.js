import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  });
}

async function desactivarActividadesFinalizadasPorPeriodo(env) {
  await env.DB.prepare(`
    UPDATE actividades
    SET activa = 0,
        visible_portal = 0
    WHERE tipo = 'TEMPORAL'
      AND fecha_fin IS NOT NULL
      AND date(fecha_fin) < date('now')
      AND (
        COALESCE(activa, 0) <> 0
        OR COALESCE(visible_portal, 0) <> 0
      )
  `).run();
}

async function obtenerRequisitosPorActividades(env, actividadIds) {
  const ids = Array.from(
    new Set((actividadIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))
  );

  if (!ids.length) return new Map();

  try {
    const placeholders = ids.map(() => "?").join(", ");
    const result = await env.DB.prepare(`
      SELECT actividad_id, texto, orden
      FROM actividad_requisitos
      WHERE actividad_id IN (${placeholders})
      ORDER BY actividad_id ASC, orden ASC, id ASC
    `).bind(...ids).all();

    const mapa = new Map();
    for (const row of result?.results || []) {
      const actividadId = Number(row.actividad_id || 0);
      if (!mapa.has(actividadId)) mapa.set(actividadId, []);
      mapa.get(actividadId).push(String(row.texto || "").trim());
    }
    return mapa;
  } catch (_) {
    return new Map();
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    await desactivarActividadesFinalizadasPorPeriodo(env);
    await ejecutarMantenimientoReservas(env);
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
        u.web_externa_url AS organizador_web_externa_url,
        CASE
          WHEN TRIM(COALESCE(u.web_externa_url, '')) <> '' THEN
            COALESCE(u.web_externa_activa, 1)
          ELSE 0
        END AS organizador_web_externa_activa,
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
        AND r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
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
        AND r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
          )
        ) AS plazas_disponibles,
        (
          SELECT MAX(datetime(f.fecha || ' ' || f.hora_fin))
          FROM franjas f
          WHERE f.actividad_id = a.id
            AND COALESCE(f.es_recurrente, 0) = 0
            AND f.fecha IS NOT NULL
            AND f.hora_fin IS NOT NULL
        ) AS ultima_franja_fin,
        (
          SELECT MAX(CASE WHEN COALESCE(f.es_recurrente, 0) = 1 THEN 1 ELSE 0 END)
          FROM franjas f
          WHERE f.actividad_id = a.id
        ) AS tiene_franjas_recurrentes,
        (
          SELECT COUNT(*)
          FROM reservas r
          WHERE r.actividad_id = a.id
            AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
        ) AS solicitudes_activas

      FROM actividades a
      LEFT JOIN usuarios u
        ON u.id = a.admin_id
    `;

    const binds = [];

    if (rol !== "SUPERADMIN") {
      sql += ` WHERE a.admin_id = ?`;
      binds.push(session.usuario_id);
    }

    sql += ` ORDER BY a.orden_portal ASC, a.id ASC`;

      const result = await env.DB.prepare(sql).bind(...binds).all();
    const requisitosPorActividad = await obtenerRequisitosPorActividades(
      env,
      (result.results || []).map((a) => a.id)
    );
    const actividades = (result.results || []).map((a) => ({
        ...a,
        plazas_totales: Number(a.plazas_totales || 0),
        plazas_ocupadas: Number(a.plazas_ocupadas || 0),
        plazas_disponibles: Number(a.plazas_disponibles || 0),
        requisitos_particulares: requisitosPorActividad.get(Number(a.id || 0)) || [],
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
