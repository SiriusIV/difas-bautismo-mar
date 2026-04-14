import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import { resolverResponsableDocumental } from "../_documentacion_responsable.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
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

function formatearModoDocumental(resolucion) {
  const modo = String(resolucion?.modo || "").toUpperCase();
  if (modo === "AUTOGESTION") {
    return "Autogestión";
  }
  if (modo === "SECRETARIA_EXTERNA") {
    return "Gestionado por secretaría";
  }
  return "Sin configuración documental operativa";
}

function construirResumenDocumentacion(documentos) {
  const activos = documentos.filter((doc) => Number(doc.activo || 0) === 1).length;
  const inactivos = documentos.filter((doc) => Number(doc.activo || 0) !== 1).length;
  if (!documentos.length) {
    return "No hay documentos base definidos actualmente.";
  }
  if (activos > 0 && inactivos > 0) {
    return `${activos} documento(s) activo(s) y ${inactivos} inactivo(s).`;
  }
  if (activos > 0) {
    return `${activos} documento(s) activo(s).`;
  }
  return `${inactivos} documento(s) inactivo(s).`;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const url = new URL(request.url);
    const adminId = await resolverAdminObjetivo(env, session, url.searchParams.get("admin_id"));
    const resolucion = await resolverResponsableDocumental(env, adminId);

    if (!resolucion) {
      return json({ ok: false, error: "Administrador no encontrado." }, 404);
    }

    const propietarioDocumentalId = Number(
      resolucion.modo === "SECRETARIA_EXTERNA"
        ? resolucion.responsable?.id || 0
        : resolucion.admin?.id || 0
    );

    const documentosRows = await env.DB.prepare(`
      SELECT
        id,
        admin_id,
        nombre,
        descripcion,
        archivo_url,
        orden,
        activo,
        version_documental,
        fecha_actualizacion
      FROM admin_documentos_comunes
      WHERE admin_id = ?
      ORDER BY activo DESC, orden ASC, id ASC
    `).bind(propietarioDocumentalId).all();

    const documentos = (documentosRows?.results || []).map((row) => ({
      id: Number(row.id || 0),
      admin_id: Number(row.admin_id || 0),
      nombre: row.nombre || "",
      descripcion: row.descripcion || "",
      archivo_url: row.archivo_url || "",
      orden: Number(row.orden || 0),
      activo: Number(row.activo || 0) === 1,
      version_documental: Number(row.version_documental || 0),
      fecha_actualizacion: row.fecha_actualizacion || ""
    }));

    const versionActual = documentos.reduce(
      (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
      0
    );

    const editable = (
      resolucion.modo === "AUTOGESTION" &&
      Number(resolucion.responsable?.id || 0) === Number(session.usuario_id || 0)
    );

    return json({
      ok: true,
      admin_id: Number(resolucion.admin?.id || 0),
      modo_documental: resolucion.modo || "",
      modo_documental_etiqueta: formatearModoDocumental(resolucion),
      editable,
      propietario_documental_id: propietarioDocumentalId,
      resumen: construirResumenDocumentacion(documentos),
      observacion: resolucion.observacion || "",
      admin: resolucion.admin || null,
      responsable_documental: resolucion.responsable || null,
      version_actual: versionActual > 0 ? versionActual : 1,
      documentos
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo cargar el contexto documental del administrador.",
        detalle: error.message
      },
      500
    );
  }
}
