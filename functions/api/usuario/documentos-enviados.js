import { getUserSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function obtenerUsuarioSolicitante(env, userId) {
  return await env.DB.prepare(`
    SELECT id, centro, email, rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first();
}

function etiquetaEstado(estado) {
  const valor = String(estado || "").toUpperCase().trim();
  return valor || "EN_REVISION";
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    if (!session?.id) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const usuario = await obtenerUsuarioSolicitante(env, session.id);
    if (!usuario || usuario.rol !== "SOLICITANTE") {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    const rows = await env.DB.prepare(`
      SELECT
        a.id AS archivo_id,
        a.documentacion_id,
        a.nombre_documento,
        a.archivo_url,
        a.version_documental,
        a.fecha_subida,
        d.admin_id,
        d.estado AS expediente_estado,
        d.fecha_validacion,
        d.fecha_ultima_entrega,
        u.nombre AS admin_nombre,
        u.nombre_publico AS admin_nombre_publico,
        u.localidad AS admin_localidad
      FROM centro_admin_documentacion_archivos a
      INNER JOIN centro_admin_documentacion d
        ON d.id = a.documentacion_id
      LEFT JOIN usuarios u
        ON u.id = d.admin_id
      WHERE d.centro_usuario_id = ?
      ORDER BY a.fecha_subida DESC, a.id DESC
    `).bind(usuario.id).all();

    const documentos = (rows?.results || []).map((row) => ({
      archivo_id: Number(row.archivo_id || 0),
      documentacion_id: Number(row.documentacion_id || 0),
      admin_id: Number(row.admin_id || 0),
      admin_nombre: row.admin_nombre || "",
      admin_nombre_publico: row.admin_nombre_publico || "",
      admin_localidad: row.admin_localidad || "",
      nombre_documento: row.nombre_documento || "",
      archivo_url: row.archivo_url || "",
      version_documental: Number(row.version_documental || 0),
      fecha_subida: row.fecha_subida || "",
      estado_documento: etiquetaEstado(row.expediente_estado),
      fecha_validacion: row.fecha_validacion || "",
      fecha_ultima_entrega: row.fecha_ultima_entrega || ""
    }));

    return json({
      ok: true,
      total: documentos.length,
      documentos
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudieron cargar los documentos enviados.",
        detalle: error?.message || String(error)
      },
      500
    );
  }
}
