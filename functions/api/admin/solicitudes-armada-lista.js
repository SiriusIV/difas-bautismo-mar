import { getAdminSession } from "./_auth.js";
import { asegurarTablaSolicitudesArmada } from "./_solicitudes_armada.js";

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

    await asegurarTablaSolicitudesArmada(env.DB);

    const rows = await env.DB.prepare(`
      SELECT
        id,
        centro,
        localidad,
        responsable_legal,
        tipo_documento,
        documento_identificacion,
        email,
        telefono_contacto,
        estado,
        fecha_solicitud,
        fecha_resolucion,
        resuelto_por_superadmin_id,
        motivo_resolucion,
        usuario_creado_id
      FROM solicitudes_registro_armada
      ORDER BY
        CASE estado
          WHEN 'PENDIENTE' THEN 0
          WHEN 'APROBADA' THEN 1
          WHEN 'RECHAZADA' THEN 2
          ELSE 3
        END,
        datetime(fecha_solicitud) DESC
    `).all();

    return json({
      ok: true,
      solicitudes: rows.results || []
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error cargando solicitudes de Usuario Armada",
      detalle: error.message
    }, 500);
  }
}
