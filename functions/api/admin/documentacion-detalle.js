import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
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

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const url = new URL(request.url);
    const adminId = await resolverAdminObjetivo(env, session, url.searchParams.get("admin_id"));
    const centroUsuarioId = parsearIdPositivo(url.searchParams.get("centro_usuario_id"));

    if (!centroUsuarioId) {
      return json({ ok: false, error: "Debes indicar un centro válido." }, { status: 400 });
    }

    const expediente = await env.DB.prepare(`
      SELECT
        cad.id,
        cad.centro_usuario_id,
        cad.admin_id,
        cad.version_requerida,
        cad.version_aportada,
        cad.estado,
        cad.fecha_ultima_entrega,
        cad.fecha_validacion,
        cad.observaciones_admin,
        cad.updated_at,
        u.centro,
        u.email,
        u.telefono_contacto
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios u
        ON u.id = cad.centro_usuario_id
      WHERE cad.admin_id = ?
        AND cad.centro_usuario_id = ?
      LIMIT 1
    `).bind(adminId, centroUsuarioId).first();

    if (!expediente) {
      return json({ ok: false, error: "Expediente documental no encontrado." }, { status: 404 });
    }

    const archivos = await env.DB.prepare(`
      SELECT
        id,
        nombre_documento,
        archivo_url,
        version_documental,
        fecha_subida,
        activo
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
      ORDER BY nombre_documento ASC, id ASC
    `).bind(expediente.id).all();

    return json({
      ok: true,
      expediente: {
        id: expediente.id,
        centro_usuario_id: expediente.centro_usuario_id,
        admin_id: expediente.admin_id,
        centro: expediente.centro || "",
        email: expediente.email || "",
        telefono_contacto: expediente.telefono_contacto || "",
        version_requerida: Number(expediente.version_requerida || 0),
        version_aportada: Number(expediente.version_aportada || 0),
        estado: expediente.estado || "",
        fecha_ultima_entrega: expediente.fecha_ultima_entrega || "",
        fecha_validacion: expediente.fecha_validacion || "",
        observaciones_admin: expediente.observaciones_admin || "",
        updated_at: expediente.updated_at || ""
      },
      documentos: (archivos?.results || []).map((row) => ({
        id: row.id,
        nombre_documento: row.nombre_documento || "",
        archivo_url: row.archivo_url || "",
        version_documental: Number(row.version_documental || 0),
        fecha_subida: row.fecha_subida || "",
        activo: Number(row.activo || 0) === 1
      }))
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo cargar el detalle documental del centro.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
