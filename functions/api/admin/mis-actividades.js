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
  a.*,

  /* 🔹 plazas totales */
  (
    SELECT COALESCE(SUM(f.capacidad), 0)
    FROM franjas f
    WHERE f.actividad_id = a.id
  ) AS plazas_totales,

  /* 🔹 plazas ocupadas reales */
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
      AND r.estado IN ('PENDIENTE','CONFIRMADA')
  ) AS plazas_ocupadas,

  /* 🔹 plazas disponibles */
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
        AND r.estado IN ('PENDIENTE','CONFIRMADA')
    )
  ) AS plazas_disponibles
    const binds = [];

    if (rol !== "SUPERADMIN") {
      sql += ` WHERE admin_id = ?`;
      binds.push(session.usuario_id);
    }

    sql += ` ORDER BY orden_portal ASC, id ASC`;

    const result = await env.DB.prepare(sql).bind(...binds).all();

    return json({
      ok: true,
      actividades: result.results || []
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
