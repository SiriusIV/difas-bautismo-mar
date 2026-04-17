import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import { puedeGestionarDocumentacionAdmin } from "../_documentacion_responsable.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
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

function normalizarEstadoDocumento(estado) {
  return limpiarTexto(estado).toUpperCase() || "EN_REVISION";
}

function calcularEstadoDocumento(baseDoc, entrega) {
  if (!entrega) {
    return "NO_ENVIADO";
  }

  if (Number(entrega.version_documental || 0) !== Number(baseDoc.version_documental || 0)) {
    return "NO_ACTUALIZADO";
  }

  return normalizarEstadoDocumento(entrega.estado);
}

function prioridadPendienteExpediente(item) {
  if (Number(item.total_documentos_en_revision || 0) > 0) return 0;
  return 1;
}

async function resolverAdminObjetivo(env, session, adminIdParam) {
  const rol = await getRolUsuario(env, session.usuario_id);
  if (rol === "SUPERADMIN") {
    return parsearIdPositivo(adminIdParam) || session.usuario_id;
  }
  return session.usuario_id;
}

async function obtenerDocumentosBaseActivos(env, adminId) {
  const rows = await env.DB.prepare(`
    SELECT
      id,
      nombre,
      version_documental
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND activo = 1
    ORDER BY orden ASC, id ASC
  `).bind(adminId).all();

  return rows?.results || [];
}

async function obtenerExpedientesDocumentales(env, adminId) {
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
      u.telefono_contacto
    FROM centro_admin_documentacion cad
    INNER JOIN usuarios u
      ON u.id = cad.centro_usuario_id
    WHERE cad.admin_id = ?
      ORDER BY datetime(cad.fecha_ultima_entrega) DESC, u.centro ASC
  `).bind(adminId).all();

  return rows?.results || [];
}

async function obtenerArchivosActivosPorExpediente(env, expedientesIds) {
  if (!Array.isArray(expedientesIds) || expedientesIds.length === 0) {
    return new Map();
  }

  const placeholders = expedientesIds.map(() => "?").join(", ");
  const rows = await env.DB.prepare(`
    SELECT
      documentacion_id,
      nombre_documento,
      version_documental,
      estado,
      fecha_subida,
      archivo_url
    FROM centro_admin_documentacion_archivos
    WHERE activo = 1
      AND documentacion_id IN (${placeholders})
    ORDER BY documentacion_id ASC, id ASC
  `).bind(...expedientesIds).all();

  const archivosPorExpediente = new Map();
  for (const row of rows?.results || []) {
    const expedienteId = Number(row.documentacion_id || 0);
    if (!archivosPorExpediente.has(expedienteId)) {
      archivosPorExpediente.set(expedienteId, []);
    }
    archivosPorExpediente.get(expedienteId).push(row);
  }

  return archivosPorExpediente;
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

    const [documentosBaseActivos, expedientes] = await Promise.all([
      obtenerDocumentosBaseActivos(env, adminId),
      obtenerExpedientesDocumentales(env, adminId)
    ]);

    const archivosPorExpediente = await obtenerArchivosActivosPorExpediente(
      env,
      expedientes.map((row) => Number(row.id || 0)).filter((id) => id > 0)
    );

    const pendientes = expedientes.map((row) => {
      const expedienteId = Number(row.id || 0);
      const archivosActivos = archivosPorExpediente.get(expedienteId) || [];
      const archivosPorNombre = new Map(
        archivosActivos.map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo])
      );

      const documentosBloqueantes = documentosBaseActivos.map((doc) => {
        const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;
        return {
          nombre: limpiarTexto(doc.nombre),
          estado: calcularEstadoDocumento(doc, entrega)
        };
      }).filter((doc) => doc.estado !== "VALIDADO");

      const totalEnRevision = documentosBloqueantes.filter((doc) => doc.estado === "EN_REVISION").length;
      const documentosEnRevision = documentosBloqueantes.filter((doc) => doc.estado === "EN_REVISION");
      const totalNoEnviados = documentosBloqueantes.filter((doc) => doc.estado === "NO_ENVIADO").length;
      const totalNoActualizados = documentosBloqueantes.filter((doc) => doc.estado === "NO_ACTUALIZADO").length;
      const totalRechazados = documentosBloqueantes.filter((doc) => doc.estado === "RECHAZADO").length;

      return {
        id: expedienteId,
        centro_usuario_id: Number(row.centro_usuario_id || 0),
        admin_id: Number(row.admin_id || 0),
        centro: row.centro || "",
        email: row.email || "",
        telefono_contacto: row.telefono_contacto || "",
        total_documentos_pendientes: documentosEnRevision.length,
        total_documentos_en_revision: totalEnRevision,
        total_documentos_no_enviados: totalNoEnviados,
        total_documentos_no_actualizados: totalNoActualizados,
        total_documentos_rechazados: totalRechazados,
        documentos_pendientes_resumen: documentosEnRevision.map((doc) => doc.nombre).join(" · "),
        documentos_bloqueantes: documentosEnRevision,
        version_requerida: Number(row.version_requerida || 0),
        version_aportada: Number(row.version_aportada || 0),
        estado: row.estado || "",
        fecha_ultima_entrega: row.fecha_ultima_entrega || "",
        fecha_validacion: row.fecha_validacion || "",
        observaciones_admin: row.observaciones_admin || ""
      };
    }).filter((item) => {
      if (!soloPendientes) return true;
      return item.total_documentos_en_revision > 0;
    }).sort((a, b) => {
      const prioridadA = prioridadPendienteExpediente(a);
      const prioridadB = prioridadPendienteExpediente(b);
      if (prioridadA !== prioridadB) return prioridadA - prioridadB;

      const fechaA = limpiarTexto(a.fecha_ultima_entrega);
      const fechaB = limpiarTexto(b.fecha_ultima_entrega);
      if (fechaA !== fechaB) return fechaA < fechaB ? 1 : -1;

      return limpiarTexto(a.centro).localeCompare(limpiarTexto(b.centro), "es");
    });

    return json({
      ok: true,
      admin_id: adminId,
      filtro: soloPendientes ? "pendientes" : "todos",
      total: pendientes.length,
      expedientes: pendientes
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
