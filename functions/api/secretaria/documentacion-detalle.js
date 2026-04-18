import { getSecretariaSession, obtenerExpedienteGestionadoPorSecretaria } from "./_documental.js";

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

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getSecretariaSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const url = new URL(request.url);
    const documentacionId = parsearIdPositivo(url.searchParams.get("documentacion_id"));
    if (!documentacionId) {
      return json({ ok: false, error: "Debes indicar un expediente válido." }, { status: 400 });
    }

    const expediente = await obtenerExpedienteGestionadoPorSecretaria(env, session.usuario_id, documentacionId);
    if (!expediente) {
      return json({ ok: false, error: "Expediente documental no encontrado." }, { status: 404 });
    }

    const archivos = await env.DB.prepare(`
      SELECT
        a.id,
        a.nombre_documento,
        a.archivo_url,
        a.version_documental,
        a.estado,
        a.fecha_validacion,
        a.validado_por_admin_id,
        a.observaciones_admin,
        a.fecha_subida,
        a.activo
      FROM centro_admin_documentacion_archivos a
      INNER JOIN (
        SELECT nombre_documento, MAX(id) AS id
        FROM centro_admin_documentacion_archivos
        WHERE documentacion_id = ?
          AND activo = 1
        GROUP BY nombre_documento
      ) ult
        ON ult.id = a.id
      WHERE a.documentacion_id = ?
        AND a.activo = 1
      ORDER BY a.nombre_documento ASC, a.id ASC
    `).bind(documentacionId, documentacionId).all();

    return json({
      ok: true,
      expediente: {
        id: Number(expediente.id || 0),
        centro_usuario_id: Number(expediente.centro_usuario_id || 0),
        admin_id: Number(expediente.admin_id || 0),
        admin_nombre: expediente.admin_nombre || "",
        admin_nombre_publico: expediente.admin_nombre_publico || "",
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
        id: Number(row.id || 0),
        nombre_documento: row.nombre_documento || "",
        archivo_url: row.archivo_url || "",
        version_documental: Number(row.version_documental || 0),
        estado: String(row.estado || "").trim().toUpperCase() || "EN_REVISION",
        fecha_validacion: row.fecha_validacion || "",
        validado_por_admin_id: Number(row.validado_por_admin_id || 0),
        observaciones_admin: row.observaciones_admin || "",
        fecha_subida: row.fecha_subida || "",
        activo: Number(row.activo || 0) === 1
      }))
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudo cargar el detalle documental del expediente.",
      detalle: error.message
    }, { status: 500 });
  }
}
