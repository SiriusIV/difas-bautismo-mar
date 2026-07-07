import { getSecretariaSession } from "./_documental.js";
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

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getSecretariaSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    await asegurarColumnasContextoDocumental(env);

    const url = new URL(request.url);
    const documentacionId = parsearIdPositivo(url.searchParams.get("documentacion_id"));
    if (!documentacionId) {
      return json({ ok: false, error: "Debes indicar un expediente válido." }, { status: 400 });
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
        r.codigo_reserva,
        admin.nombre AS admin_nombre,
        admin.nombre_publico AS admin_nombre_publico
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios u
        ON u.id = cad.centro_usuario_id
      INNER JOIN usuarios admin
        ON admin.id = cad.admin_id
      LEFT JOIN actividades act
        ON act.id = cad.actividad_id
      LEFT JOIN reservas r
        ON r.id = cad.reserva_id
      WHERE cad.id = ?
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
    `).bind(documentacionId, session.usuario_id).first();

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
    `).bind(documentacionId, session.usuario_id, documentacionId).all();

    return json({
      ok: true,
      expediente: {
        id: Number(expediente.id || 0),
        centro_usuario_id: Number(expediente.centro_usuario_id || 0),
        admin_id: Number(expediente.admin_id || 0),
        actividad_id: Number(expediente.actividad_id || 0),
        reserva_id: Number(expediente.reserva_id || 0),
        actividad_nombre: expediente.actividad_nombre || "",
        codigo_reserva: expediente.codigo_reserva || "",
        propietario_documental_id: Number(session.usuario_id || 0),
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
