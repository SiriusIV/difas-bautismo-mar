import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import { asegurarColumnasContextoDocumental } from "../_documentacion_contextual.js";

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
    await asegurarColumnasContextoDocumental(env);
    const propietarioDocumentalId = await resolverAdminObjetivo(env, session, url.searchParams.get("admin_id"));
    const actividadAdminId = parsearIdPositivo(url.searchParams.get("actividad_admin_id"));
    const centroUsuarioId = parsearIdPositivo(url.searchParams.get("centro_usuario_id"));
    const documentacionId = parsearIdPositivo(url.searchParams.get("documentacion_id"));

    if (!centroUsuarioId && !documentacionId) {
      return json({ ok: false, error: "Debes indicar un centro válido." }, { status: 400 });
    }

    const expediente = await env.DB.prepare(`
      SELECT
        cad.id,
        cad.centro_usuario_id,
        cad.admin_id,
        cad.actividad_id,
        cad.reserva_id,
        cad.version_requerida,
        cad.version_aportada,
        cad.estado,
        cad.fecha_ultima_entrega,
        cad.fecha_validacion,
        cad.observaciones_admin,
        cad.updated_at,
        u.centro,
        u.email,
        u.telefono_contacto,
        COALESCE(act.titulo_publico, act.nombre, '') AS actividad_nombre,
        r.codigo_reserva
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios u
        ON u.id = cad.centro_usuario_id
      LEFT JOIN actividades act
        ON act.id = cad.actividad_id
      LEFT JOIN reservas r
        ON r.id = cad.reserva_id
      WHERE ${documentacionId ? "cad.id = ?" : "cad.centro_usuario_id = ?"}
        ${actividadAdminId ? "AND cad.admin_id = ?" : ""}
        AND EXISTS (
          SELECT 1
          FROM centro_admin_documentacion_archivos a
          INNER JOIN admin_documentos_comunes d
            ON d.admin_id = ?
           AND COALESCE(d.activo, 1) = 1
           AND UPPER(TRIM(COALESCE(d.nombre, ''))) = UPPER(TRIM(COALESCE(a.nombre_documento, '')))
          WHERE a.documentacion_id = cad.id
            AND a.activo = 1
        )
      LIMIT 1
    `).bind(
      ...(actividadAdminId
        ? [documentacionId || centroUsuarioId, actividadAdminId, propietarioDocumentalId]
        : [documentacionId || centroUsuarioId, propietarioDocumentalId])
    ).first();

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
      INNER JOIN admin_documentos_comunes d
        ON d.admin_id = ?
       AND COALESCE(d.activo, 1) = 1
       AND UPPER(TRIM(COALESCE(d.nombre, ''))) = UPPER(TRIM(COALESCE(a.nombre_documento, '')))
      WHERE a.documentacion_id = ?
        AND a.activo = 1
      ORDER BY a.nombre_documento ASC, a.id ASC
    `).bind(expediente.id, propietarioDocumentalId, expediente.id).all();

    return json({
      ok: true,
      expediente: {
        id: expediente.id,
        centro_usuario_id: expediente.centro_usuario_id,
        admin_id: expediente.admin_id,
        actividad_id: Number(expediente.actividad_id || 0),
        reserva_id: Number(expediente.reserva_id || 0),
        actividad_nombre: expediente.actividad_nombre || "",
        codigo_reserva: expediente.codigo_reserva || "",
        propietario_documental_id: propietarioDocumentalId,
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
        estado: String(row.estado || "").trim().toUpperCase() || "EN_REVISION",
        fecha_validacion: row.fecha_validacion || "",
        validado_por_admin_id: Number(row.validado_por_admin_id || 0),
        observaciones_admin: row.observaciones_admin || "",
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
