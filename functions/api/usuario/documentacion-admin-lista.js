import { getUserSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function obtenerUsuario(env, userId) {
  return await env.DB.prepare(`
    SELECT
      id,
      rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first();
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    if (!session?.id) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const usuario = await obtenerUsuario(env, session.id);
    if (!usuario || usuario.rol !== "SOLICITANTE") {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    const result = await env.DB.prepare(`
      SELECT
        u.id,
        u.nombre,
        u.email,
        MAX(adc.version_documental) AS version_requerida,
        COUNT(adc.id) AS total_documentos
      FROM admin_documentos_comunes adc
      JOIN usuarios u
        ON u.id = adc.admin_id
      WHERE adc.activo = 1
        AND u.rol IN ('ADMIN', 'SUPERADMIN')
      GROUP BY u.id, u.nombre, u.email
      HAVING COUNT(adc.id) > 0
      ORDER BY COALESCE(u.nombre, u.email) ASC
    `).all();

    return json({
      ok: true,
      administradores: (result?.results || []).map((row) => ({
        id: row.id,
        nombre: row.nombre || "",
        email: row.email || "",
        version_requerida: Number(row.version_requerida || 0),
        total_documentos: Number(row.total_documentos || 0)
      }))
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al obtener los administradores con documentación activa.",
        detalle: error.message
      },
      500
    );
  }
}
