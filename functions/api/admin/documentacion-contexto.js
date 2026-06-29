import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";

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
    const rolSesion = await getRolUsuario(env, session.usuario_id);
    const adminRow = await env.DB.prepare(`
      SELECT id, nombre, nombre_publico, email, rol
      FROM usuarios
      WHERE id = ? AND UPPER(COALESCE(rol, '')) = 'ADMIN'
      LIMIT 1
    `).bind(adminId).first();

    if (!adminRow) {
      return json({ ok: false, error: "Administrador no encontrado." }, 404);
    }

    const propietarioDocumentalId = Number(adminRow.id || adminId);

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
      ORDER BY orden ASC, id ASC
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
      String(rolSesion || "").toUpperCase() === "SUPERADMIN" ||
      Number(propietarioDocumentalId || 0) === Number(session.usuario_id || 0)
    );

    return json({
      ok: true,
      admin_id: Number(adminRow.id || 0),
      modo_documental: "PROPIO",
      modo_documental_etiqueta: "Repositorio propio",
      editable,
      propietario_documental_id: propietarioDocumentalId,
      resumen: construirResumenDocumentacion(documentos),
      observacion: "",
      admin: {
        id: Number(adminRow.id || 0),
        nombre: adminRow.nombre || "",
        nombre_publico: adminRow.nombre_publico || "",
        email: adminRow.email || ""
      },
      responsable_documental: {
        id: Number(adminRow.id || 0),
        nombre: adminRow.nombre || "",
        nombre_publico: adminRow.nombre_publico || "",
        email: adminRow.email || "",
        rol: "ADMIN"
      },
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
