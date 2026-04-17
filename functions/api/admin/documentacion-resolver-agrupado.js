import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import { puedeGestionarDocumentacionAdmin } from "../_documentacion_responsable.js";
import { enviarEmail, nombreVisibleAdmin } from "../_email.js";
import {
  construirEmailHtmlResolucionExpedienteDocumental,
  construirEmailTextoResolucionExpedienteDocumental
} from "../_email_resolucion_documental_expediente.js";
import { recalcularImpactoDocumentalReservas } from "../_impacto_documental_reservas.js";

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
  const valor = limpiarTexto(estado).toUpperCase();
  if (["VALIDADO", "RECHAZADO", "EN_REVISION"].includes(valor)) return valor;
  return "";
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

    if (!entrega) return "NO_ENVIADO";
    if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) {
      return "NO_ACTUALIZADO";
    }

    return normalizarEstadoDocumento(entrega.estado) || "EN_REVISION";
  });

  if (estados.every((estado) => estado === "NO_ENVIADO")) return "NO_INICIADO";
  if (estados.some((estado) => estado === "RECHAZADO")) return "RECHAZADA";
  if (estados.some((estado) => estado === "NO_ACTUALIZADO")) return "NO_ACTUALIZADO";
  if (estados.some((estado) => estado === "NO_ENVIADO")) return "NO_COMPLETADO";
  if (estados.every((estado) => estado === "VALIDADO")) return "VALIDADA";
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
    const rolSesion = await getRolUsuario(env, session.usuario_id);
    const adminId = await resolverAdminObjetivo(env, session, body?.admin_id);
    const permiso = await puedeGestionarDocumentacionAdmin(env, session.usuario_id, adminId, rolSesion);
    const documentacionId = parsearIdPositivo(body?.documentacion_id);
    const cambiosEntrada = Array.isArray(body?.cambios) ? body.cambios : [];
    const baseUrl = new URL(request.url).origin;

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

    if (!documentacionId) {
      return json({ ok: false, error: "Debes indicar un expediente válido." }, { status: 400 });
    }

    if (!cambiosEntrada.length) {
      return json({ ok: false, error: "No hay cambios de revisión para aplicar." }, { status: 400 });
    }

    const expediente = await env.DB.prepare(`
      SELECT
        cad.id,
        cad.admin_id,
        cad.centro_usuario_id,
        cad.version_requerida,
        u.centro,
        u.email
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios u ON u.id = cad.centro_usuario_id
      WHERE cad.id = ?
        AND cad.admin_id = ?
      LIMIT 1
    `).bind(documentacionId, adminId).first();

    if (!expediente) {
      return json({ ok: false, error: "Expediente documental no encontrado." }, { status: 404 });
    }

    const archivos = await env.DB.prepare(`
      SELECT
        id,
        nombre_documento,
        archivo_url,
        version_documental,
        estado,
        observaciones_admin
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
      ORDER BY nombre_documento ASC, id ASC
    `).bind(documentacionId).all();

    const archivosLista = archivos?.results || [];
    const archivosPorId = new Map(archivosLista.map((item) => [Number(item.id || 0), item]));
    const cambiosAplicados = [];

    for (const cambio of cambiosEntrada) {
      const archivoId = parsearIdPositivo(cambio?.archivo_id);
      const estado = normalizarEstadoDocumento(cambio?.estado);
      const observaciones = limpiarTexto(cambio?.observaciones_admin || "");
      if (!archivoId || !estado) continue;

      const archivo = archivosPorId.get(archivoId);
      if (!archivo) continue;

      await env.DB.prepare(`
        UPDATE centro_admin_documentacion_archivos
        SET
          estado = ?,
          fecha_validacion = CASE WHEN ? = 'VALIDADO' THEN CURRENT_TIMESTAMP ELSE NULL END,
          validado_por_admin_id = CASE WHEN ? IN ('VALIDADO', 'RECHAZADO') THEN ? ELSE NULL END,
          observaciones_admin = ?
        WHERE id = ?
      `).bind(
        estado,
        estado,
        estado,
        session.usuario_id,
        observaciones || null,
        archivoId
      ).run();

      cambiosAplicados.push({
        archivo_id: archivoId,
        nombre_documento: archivo.nombre_documento || "",
        estado,
        observaciones_admin: observaciones
      });
    }

    if (!cambiosAplicados.length) {
      return json({ ok: false, error: "No se ha aplicado ningún cambio válido." }, { status: 400 });
    }

    const archivosActualizados = await env.DB.prepare(`
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
    const estadoExpediente = calcularEstadoGlobal(documentosBaseActivos, archivosActualizados?.results || []);

    await env.DB.prepare(`
      UPDATE centro_admin_documentacion
      SET
        estado = ?,
        fecha_validacion = CASE WHEN ? = 'VALIDADA' THEN CURRENT_TIMESTAMP ELSE NULL END,
        validado_por_admin_id = CASE WHEN ? = 'VALIDADA' THEN ? ELSE NULL END,
        observaciones_admin = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      estadoExpediente,
      estadoExpediente,
      estadoExpediente,
      session.usuario_id,
      documentacionId
    ).run();

    const admin = await env.DB.prepare(`
      SELECT id, nombre, nombre_publico, localidad, email
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(adminId).first();

    const notificacionCentro = await enviarEmail(env, {
      to: expediente.email || "",
      subject: `[Documentación] Revisión actualizada por ${nombreVisibleAdmin(admin || {})}`,
      text: construirEmailTextoResolucionExpedienteDocumental({
        admin: admin || {},
        centro: expediente || {},
        estado_expediente: estadoExpediente,
        cambios: cambiosAplicados
      }),
      html: construirEmailHtmlResolucionExpedienteDocumental({
        admin: admin || {},
        centro: expediente || {},
        estado_expediente: estadoExpediente,
        cambios: cambiosAplicados
      })
    });

    const impactoReservas = await recalcularImpactoDocumentalReservas(env, {
      adminId,
      baseUrl,
      motivo: "documentos_actualizados"
    });

    return json({
      ok: true,
      mensaje: "Revisión documental aplicada correctamente.",
      estado_expediente: estadoExpediente,
      cambios: cambiosAplicados,
      notificacion_centro: {
        enviada: !!notificacionCentro.ok,
        omitida: !!notificacionCentro.skipped,
        error: notificacionCentro.ok ? "" : (notificacionCentro.error || "")
      },
      impacto_reservas: impactoReservas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo aplicar la revisión documental agrupada.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
