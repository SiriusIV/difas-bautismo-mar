import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";

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
    const propietarioDocumentalId = await resolverAdminObjetivo(env, session, url.searchParams.get("admin_id"));
    const filtro = limpiarTexto(url.searchParams.get("filtro") || "pendientes").toLowerCase();
    const soloPendientes = filtro !== "todos";

    const condicionPendientes = soloPendientes
      ? "AND UPPER(TRIM(COALESCE(av.estado, ''))) IN ('EN_REVISION', 'EN REVISIÓN', 'EN REVISION')"
      : "";

    const rows = await env.DB.prepare(`
      WITH archivos_vigentes AS (
        SELECT
          a.*,
          ROW_NUMBER() OVER (
            PARTITION BY a.documentacion_id, TRIM(COALESCE(a.nombre_documento, ''))
            ORDER BY a.id DESC
          ) AS rn
        FROM centro_admin_documentacion_archivos a
        WHERE a.activo = 1
      )
      SELECT
        cad.id AS documentacion_id,
        cad.centro_usuario_id,
        cad.admin_id,
        cad.version_requerida,
        cad.version_aportada,
        cad.estado AS estado_expediente,
        cad.fecha_ultima_entrega,
        cad.fecha_validacion,
        u.centro,
        u.email,
        u.telefono_contacto,
        admin.nombre AS admin_nombre,
        admin.nombre_publico AS admin_nombre_publico,
        av.id AS archivo_id,
        doc.id AS documento_base_id,
        doc.admin_id AS propietario_documental_id,
        av.nombre_documento,
        av.archivo_url,
        av.version_documental,
        av.estado,
        av.observaciones_admin,
        av.fecha_subida
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios u
        ON u.id = cad.centro_usuario_id
      INNER JOIN usuarios admin
        ON admin.id = cad.admin_id
      INNER JOIN archivos_vigentes av
        ON av.documentacion_id = cad.id
       AND av.rn = 1
      INNER JOIN admin_documentos_comunes doc
        ON doc.admin_id = ?
       AND COALESCE(doc.activo, 1) = 1
       AND UPPER(TRIM(COALESCE(doc.nombre, ''))) = UPPER(TRIM(COALESCE(av.nombre_documento, '')))
      WHERE 1 = 1
        ${condicionPendientes}
      ORDER BY
        datetime(COALESCE(av.fecha_subida, cad.fecha_ultima_entrega)) DESC,
        u.centro ASC,
        av.nombre_documento ASC
    `).bind(propietarioDocumentalId).all();

    const expedientes = (rows?.results || []).map((row) => ({
      id: Number(row.documentacion_id || 0),
      archivo_id: Number(row.archivo_id || 0),
      centro_usuario_id: Number(row.centro_usuario_id || 0),
      admin_id: Number(row.admin_id || 0),
      admin_nombre: row.admin_nombre || "",
      admin_nombre_publico: row.admin_nombre_publico || "",
      documento_base_id: Number(row.documento_base_id || 0),
      propietario_documental_id: Number(row.propietario_documental_id || 0),
      centro: row.centro || "",
      email: row.email || "",
      telefono_contacto: row.telefono_contacto || "",
      nombre_documento: row.nombre_documento || "",
      archivo_url: row.archivo_url || "",
      version_documental: Number(row.version_documental || 0),
      estado: row.estado || "",
      observaciones_admin: row.observaciones_admin || "",
      fecha_ultima_entrega: row.fecha_subida || row.fecha_ultima_entrega || "",
      version_requerida: Number(row.version_requerida || 0),
      version_aportada: Number(row.version_aportada || 0),
      estado_expediente: row.estado_expediente || "",
      fecha_validacion: row.fecha_validacion || ""
    }));

    return json({
      ok: true,
      admin_id: propietarioDocumentalId,
      propietario_documental_id: propietarioDocumentalId,
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
