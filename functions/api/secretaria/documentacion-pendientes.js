import { getSecretariaSession } from "./_documental.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getSecretariaSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const rows = await env.DB.prepare(`
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
        u.centro,
        u.email,
        u.telefono_contacto,
        admin.nombre AS admin_nombre,
        admin.nombre_publico AS admin_nombre_publico,
        COALESCE(SUM(
          CASE
            WHEN a.activo = 1
             AND UPPER(TRIM(COALESCE(a.estado, ''))) IN ('EN_REVISION', 'EN REVISIÓN', 'EN REVISION')
            THEN 1
            ELSE 0
          END
        ), 0) AS total_documentos_pendientes,
        COALESCE(GROUP_CONCAT(
          CASE
            WHEN a.activo = 1
             AND UPPER(TRIM(COALESCE(a.estado, ''))) IN ('EN_REVISION', 'EN REVISIÓN', 'EN REVISION')
            THEN a.nombre_documento
            ELSE NULL
          END,
          ' · '
        ), '') AS documentos_pendientes_resumen
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios u
        ON u.id = cad.centro_usuario_id
      INNER JOIN usuarios admin
        ON admin.id = cad.admin_id
      LEFT JOIN centro_admin_documentacion_archivos a
        ON a.documentacion_id = cad.id
      WHERE admin.rol = 'ADMIN'
        AND admin.secretaria_usuario_id = ?
        AND COALESCE(admin.modulo_secretaria, 0) = 0
      GROUP BY
        cad.id,
        cad.centro_usuario_id,
        cad.admin_id,
        cad.version_requerida,
        cad.version_aportada,
        cad.estado,
        cad.fecha_ultima_entrega,
        cad.fecha_validacion,
        cad.observaciones_admin,
        u.centro,
        u.email,
        u.telefono_contacto,
        admin.nombre,
        admin.nombre_publico
      HAVING COALESCE(SUM(
        CASE
          WHEN a.activo = 1
           AND UPPER(TRIM(COALESCE(a.estado, ''))) IN ('EN_REVISION', 'EN REVISIÓN', 'EN REVISION')
          THEN 1
          ELSE 0
        END
      ), 0) > 0
      ORDER BY
        datetime(cad.fecha_ultima_entrega) DESC,
        u.centro ASC
    `).bind(session.usuario_id).all();

    const expedientes = (rows?.results || []).map((row) => ({
      id: Number(row.id || 0),
      centro_usuario_id: Number(row.centro_usuario_id || 0),
      admin_id: Number(row.admin_id || 0),
      admin_nombre: row.admin_nombre || "",
      admin_nombre_publico: row.admin_nombre_publico || "",
      centro: row.centro || "",
      email: row.email || "",
      telefono_contacto: row.telefono_contacto || "",
      total_documentos_pendientes: Number(row.total_documentos_pendientes || 0),
      total_documentos_en_revision: Number(row.total_documentos_pendientes || 0),
      documentos_pendientes_resumen: row.documentos_pendientes_resumen || "",
      version_requerida: Number(row.version_requerida || 0),
      version_aportada: Number(row.version_aportada || 0),
      estado: row.estado || "",
      fecha_ultima_entrega: row.fecha_ultima_entrega || "",
      fecha_validacion: row.fecha_validacion || "",
      observaciones_admin: row.observaciones_admin || ""
    }));

    return json({
      ok: true,
      secretaria_id: Number(session.usuario_id || 0),
      filtro: "pendientes",
      total: expedientes.length,
      expedientes
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudo cargar la documentación pendiente de la secretaría.",
      detalle: error.message
    }, { status: 500 });
  }
}
