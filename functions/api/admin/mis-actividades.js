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
        id,
        nombre,
        tipo,
        fecha_inicio,
        fecha_fin,
        titulo_publico,
        subtitulo_publico,
        descripcion_corta,
        descripcion_larga,
        lugar,
        imagen_url,
        visible_portal,
        orden_portal,
        organizador_publico,
        activa,
        admin_id
        usa_franjas
        requiere_reserva
        aforo_limitado
        provincia
        es_recurrente
        patron_recurrencia
      FROM actividades
    `;
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
