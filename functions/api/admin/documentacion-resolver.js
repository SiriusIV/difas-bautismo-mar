import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import {
  construirEmailHtmlDocumentacionResuelta,
  construirEmailTextoDocumentacionResuelta,
  enviarEmail,
  nombreVisibleAdmin
} from "../_email.js";

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
  const valor = String(estado || "").trim().toUpperCase();
  return valor || "EN_REVISION";
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
    SELECT nombre, version_documental
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND activo = 1
  `).bind(adminId).all();

  return rows?.results || [];
}

function calcularEstadoGlobal(documentosBaseActivos, archivosActivos) {
  if (!Array.isArray(documentosBaseActivos) || documentosBaseActivos.length === 0) {
    return "NO_INICIADO";
  }

  const archivosPorNombre = new Map(
    (archivosActivos || []).map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo])
  );

  const estados = documentosBaseActivos.map((doc) => {
    const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;

    if (!entrega) {
      return "NO_ENVIADO";
    }

    if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) {
      return "NO_ACTUALIZADO";
    }

    return normalizarEstadoDocumento(entrega.estado);
  });

  if (estados.every((estado) => estado === "NO_ENVIADO")) {
    return "NO_INICIADO";
  }

  if (estados.some((estado) => estado === "RECHAZADO")) {
    return "RECHAZADA";
  }

  if (estados.some((estado) => estado === "NO_ACTUALIZADO")) {
    return "NO_ACTUALIZADO";
  }

  if (estados.some((estado) => estado === "NO_ENVIADO")) {
    return "NO_COMPLETADO";
  }

  if (estados.every((estado) => estado === "VALIDADO")) {
    return "VALIDADA";
  }

  return "EN_REVISION";
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const adminId = await resolverAdminObjetivo(env, session, body?.admin_id);
    const documentacionId = parsearIdPositivo(body?.documentacion_id);
    const archivoId = parsearIdPositivo(body?.archivo_id);
    const accion = limpiarTexto(body?.accion || "").toLowerCase();
    const observaciones = limpiarTexto(body?.observaciones_admin || "");

    if (!documentacionId) {
      return json({ ok: false, error: "Debes indicar un expediente válido." }, { status: 400 });
    }

    if (!["validar", "rechazar"].includes(accion)) {
      return json({ ok: false, error: "La acción indicada no es válida." }, { status: 400 });
    }

    const expediente = await env.DB.prepare(`
      SELECT
        id,
        admin_id,
        centro_usuario_id,
        version_requerida,
        estado
      FROM centro_admin_documentacion
      WHERE id = ?
        AND admin_id = ?
      LIMIT 1
    `).bind(documentacionId, adminId).first();

    if (!expediente) {
      return json({ ok: false, error: "Expediente documental no encontrado." }, { status: 404 });
    }

    const admin = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        nombre_publico,
        localidad,
        email
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(adminId).first();

    const centro = await env.DB.prepare(`
      SELECT
        id,
        centro,
        email
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(expediente.centro_usuario_id).first();

    const nuevoEstadoDocumento = accion === "validar" ? "VALIDADO" : "RECHAZADO";

    if (archivoId) {
      const archivoObjetivo = await env.DB.prepare(`
        SELECT id
        FROM centro_admin_documentacion_archivos
        WHERE id = ?
          AND documentacion_id = ?
          AND activo = 1
        LIMIT 1
      `).bind(archivoId, documentacionId).first();

      if (!archivoObjetivo) {
        return json({ ok: false, error: "Documento documental no encontrado." }, { status: 404 });
      }

      await env.DB.prepare(`
        UPDATE centro_admin_documentacion_archivos
        SET
          estado = ?,
          fecha_validacion = CASE WHEN ? = 'VALIDADO' THEN CURRENT_TIMESTAMP ELSE NULL END,
          validado_por_admin_id = ?,
          observaciones_admin = ?
        WHERE id = ?
      `).bind(
        nuevoEstadoDocumento,
        nuevoEstadoDocumento,
        session.usuario_id,
        observaciones || null,
        archivoId
      ).run();
    } else {
      await env.DB.prepare(`
        UPDATE centro_admin_documentacion_archivos
        SET
          estado = ?,
          fecha_validacion = CASE WHEN ? = 'VALIDADO' THEN CURRENT_TIMESTAMP ELSE NULL END,
          validado_por_admin_id = ?,
          observaciones_admin = ?
        WHERE documentacion_id = ?
          AND activo = 1
      `).bind(
        nuevoEstadoDocumento,
        nuevoEstadoDocumento,
        session.usuario_id,
        observaciones || null,
        documentacionId
      ).run();
    }

    const archivosActuales = await env.DB.prepare(`
      SELECT
        id,
        nombre_documento,
        version_documental,
        estado
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
    `).bind(documentacionId).all();

    const documentosBaseActivos = await obtenerDocumentosBaseActivos(env, adminId);
    const estadoExpediente = calcularEstadoGlobal(
      documentosBaseActivos,
      archivosActuales?.results || []
    );

    await env.DB.prepare(`
      UPDATE centro_admin_documentacion
      SET
        estado = ?,
        fecha_validacion = CASE WHEN ? = 'VALIDADA' THEN CURRENT_TIMESTAMP ELSE NULL END,
        validado_por_admin_id = CASE WHEN ? = 'VALIDADA' THEN ? ELSE NULL END,
        observaciones_admin = ?
      WHERE id = ?
    `).bind(
      estadoExpediente,
      estadoExpediente,
      estadoExpediente,
      session.usuario_id,
      observaciones || null,
      documentacionId
    ).run();

    const notificacionCentro = await enviarEmail(env, {
      to: centro?.email || "",
      subject: estadoExpediente === "VALIDADA"
        ? `[Documentación] Validada por ${nombreVisibleAdmin(admin || {})}`
        : `[Documentación] Rechazada por ${nombreVisibleAdmin(admin || {})}`,
      text: construirEmailTextoDocumentacionResuelta({
        admin: admin || {},
        centro: centro || {},
        versionRequerida: expediente.version_requerida || 0,
        estado: estadoExpediente,
        observaciones
      }),
      html: construirEmailHtmlDocumentacionResuelta({
        admin: admin || {},
        centro: centro || {},
        versionRequerida: expediente.version_requerida || 0,
        estado: estadoExpediente,
        observaciones
      })
    });

    if (!notificacionCentro.ok && !notificacionCentro.skipped) {
      console.error("No se pudo enviar el correo al centro tras resolver la documentación.", {
        admin_id: adminId,
        centro_usuario_id: expediente.centro_usuario_id,
        estado: estadoExpediente,
        error: notificacionCentro.error || ""
      });
    }

    return json({
      ok: true,
      mensaje: nuevoEstadoDocumento === "VALIDADO"
        ? "Documento validado correctamente."
        : "Documento rechazado correctamente.",
      estado_documento: nuevoEstadoDocumento,
      estado_expediente: estadoExpediente,
      notificacion_centro: {
        enviada: !!notificacionCentro.ok,
        omitida: !!notificacionCentro.skipped,
        error: notificacionCentro.ok ? "" : (notificacionCentro.error || "")
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo resolver la validación documental.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
