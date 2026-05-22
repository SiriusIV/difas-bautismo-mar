import { getAdminSession } from "./_auth.js";

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
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    if (String(session.rol || "").toUpperCase() !== "SUPERADMIN") {
      return json({ ok: false, error: "Solo SUPERADMIN" }, 403);
    }

    const rows = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        centro,
        localidad,
        email,
        telefono_contacto,
        responsable_legal,
        tipo_documento,
        documento_identificacion,
        activo,
        fecha_alta
      FROM usuarios
      WHERE rol = 'SOLICITANTE'
      ORDER BY
        UPPER(COALESCE(NULLIF(TRIM(centro), ''), NULLIF(TRIM(nombre), ''), email)) ASC
    `).all();

    return json({
      ok: true,
      usuarios: rows.results || []
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error cargando usuarios públicos",
      detalle: error.message
    }, 500);
  }
}
