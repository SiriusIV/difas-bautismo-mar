import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
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
    if (!["ADMIN", "SUPERADMIN"].includes(String(rol || "").toUpperCase())) {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    const rows = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        nombre_publico,
        email,
        localidad
      FROM usuarios
      WHERE rol = 'SECRETARIA'
        AND activo = 1
      ORDER BY
        CASE
          WHEN nombre_publico IS NOT NULL AND TRIM(nombre_publico) <> '' THEN TRIM(nombre_publico)
          ELSE TRIM(nombre)
        END COLLATE NOCASE ASC,
        id ASC
    `).all();

    return json({
      ok: true,
      secretarias: rows?.results || []
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudieron cargar las secretarías disponibles.",
        detalle: error.message
      },
      500
    );
  }
}
