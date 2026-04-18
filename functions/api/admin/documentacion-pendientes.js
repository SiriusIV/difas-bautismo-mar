import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import { puedeGestionarDocumentacionAdmin } from "../_documentacion_responsable.js";

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
    const rolSesion = await getRolUsuario(env, session.usuario_id);
    const adminId = await resolverAdminObjetivo(env, session, url.searchParams.get("admin_id"));
    const permiso = await puedeGestionarDocumentacionAdmin(env, session.usuario_id, adminId, rolSesion);
    const filtro = limpiarTexto(url.searchParams.get("filtro") || "pendientes").toLowerCase();
    const soloPendientes = filtro !== "todos";

    if (!permiso.permitido) {
      const mensaje = permiso.motivo === "RESPONSABLE_DISTINTO"
        ? "La documentación de este administrador está gestionada por una secretaría externa."
        : "Este administrador no tiene la gestión documental operativa habilitada.";
      return json(
        {
          ok: false,
          error: mensaje,
          modo_documental: permiso.resolucion?.modo || "",
          responsable_documental_id: Number(permiso.resolucion?.responsable?.id || 0)
        },
        { status: 403 }
      );
    }

    const condicionPendientes = soloPendientes
      ? `
        HAVING COALESCE(SUM(
          CASE
            WHEN a.activo = 1
             AND UPPER(TRIM(COALESCE(a.estado, ''))) IN ('EN_REVISION', 'EN REVISIÓN', 'EN REVISION')
            THEN 1
            ELSE 0
          END
        ), 0) > 0
      `
      : "";

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
      LEFT JOIN centro_admin_documentacion_archivos a
        ON a.documentacion_id = cad.id
      WHERE cad.admin_id = ?
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
        u.telefono_contacto
      ${condicionPendientes}
      ORDER BY
        datetime(cad.fecha_ultima_entrega) DESC,
        u.centro ASC
    `).bind(adminId).all();

    const expedientes = (rows?.results || []).map((row) => ({
      id: Number(row.id || 0),
      centro_usuario_id: Number(row.centro_usuario_id || 0),
      admin_id: Number(row.admin_id || 0),
      centro: row.centro || "",
      email: row.email || "",
      telefono_contacto: row.telefono_contacto || "",
      total_documentos_pendientes: Number(row.total_documentos_pendientes || 0),
      total_documentos_en_revision: Number(row.total_documentos_pendientes || 0),
      total_documentos_no_enviados: 0,
      total_documentos_no_actualizados: 0,
      total_documentos_rechazados: 0,
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
      admin_id: adminId,
      filtro: soloPendientes ? "pendientes" : "todos",
      total: expedientes.length,
      expedientes
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo cargar la documentación pendiente del administrador.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
