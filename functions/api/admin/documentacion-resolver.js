import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function resolverAdminObjetivo(env, session, adminIdParam) {
  const rol = await getRolUsuario(env, session.usuario_id);
  if (rol === "SUPERADMIN") {
    return parsearIdPositivo(adminIdParam) || session.usuario_id;
  }
  return session.usuario_id;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const adminId = await resolverAdminObjetivo(env, session, body?.admin_id);
    const documentacionId = parsearIdPositivo(body?.documentacion_id);
    const accion = limpiarTexto(body?.accion || "").toLowerCase();
    const observaciones = limpiarTexto(body?.observaciones_admin || "");

    if (!documentacionId) {
      return json({ ok: false, error: "Debes indicar un expediente válido." }, { status: 400 });
    }

    if (!["validar", "rechazar"].includes(accion)) {
      return json({ ok: false, error: "La acción indicada no es válida." }, { status: 400 });
    }

    const expediente = await env.DB.prepare(`
      SELECT
        id,
        admin_id,
        estado
      FROM centro_admin_documentacion
      WHERE id = ?
        AND admin_id = ?
      LIMIT 1
    `).bind(documentacionId, adminId).first();

    if (!expediente) {
      return json({ ok: false, error: "Expediente documental no encontrado." }, { status: 404 });
    }

    const nuevoEstado = accion === "validar" ? "VALIDADA" : "RECHAZADA";

    await env.DB.prepare(`
      UPDATE centro_admin_documentacion
      SET
        estado = ?,
        fecha_validacion = CASE WHEN ? = 'VALIDADA' THEN CURRENT_TIMESTAMP ELSE NULL END,
        validado_por_admin_id = CASE WHEN ? = 'VALIDADA' THEN ? ELSE NULL END,
        observaciones_admin = ?
      WHERE id = ?
    `).bind(
      nuevoEstado,
      nuevoEstado,
      nuevoEstado,
      session.usuario_id,
      observaciones || null,
      documentacionId
    ).run();

    return json({
      ok: true,
      mensaje: nuevoEstado === "VALIDADA"
        ? "Documentación validada correctamente."
        : "Documentación rechazada correctamente.",
      estado: nuevoEstado
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo resolver la validación documental.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
