import { enviarEmail, nombreVisibleAdmin } from "../_email.js";
import { crearNotificacion } from "../_notificaciones.js";
import {
  construirEmailHtmlResolucionExpedienteDocumental,
  construirEmailTextoResolucionExpedienteDocumental
} from "../_email_resolucion_documental_expediente.js";
import { recalcularImpactoDocumentalReservas } from "../_impacto_documental_reservas.js";
import { getSecretariaSession, obtenerExpedienteGestionadoPorSecretaria } from "./_documental.js";

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

function seleccionarUltimosArchivosPorDocumento(archivos = []) {
  const porNombre = new Map();

  for (const archivo of Array.isArray(archivos) ? archivos : []) {
    const nombre = limpiarTexto(archivo?.nombre_documento);
    if (!nombre) continue;

    const existente = porNombre.get(nombre);
    if (!existente || Number(archivo?.id || 0) > Number(existente?.id || 0)) {
      porNombre.set(nombre, archivo);
    }
  }

  return Array.from(porNombre.values()).sort((a, b) => {
    const nombreA = limpiarTexto(a?.nombre_documento).localeCompare(limpiarTexto(b?.nombre_documento), "es", { sensitivity: "base" });
    if (nombreA !== 0) return nombreA;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });
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
    if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) return "NO_ACTUALIZADO";
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
    const session = await getSecretariaSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const documentacionId = parsearIdPositivo(body?.documentacion_id);
    const cambiosEntrada = Array.isArray(body?.cambios) ? body.cambios : [];
    const baseUrl = new URL(request.url).origin;

    if (!documentacionId) {
      return json({ ok: false, error: "Debes indicar un expediente válido." }, { status: 400 });
    }
    if (!cambiosEntrada.length) {
      return json({ ok: false, error: "No hay cambios de revisión para aplicar." }, { status: 400 });
    }

    const expediente = await obtenerExpedienteGestionadoPorSecretaria(env, session.usuario_id, documentacionId);
    if (!expediente) {
      return json({ ok: false, error: "Expediente documental no encontrado." }, { status: 404 });
    }

    const secretaria = await env.DB.prepare(`
      SELECT id, nombre, nombre_publico, localidad, email
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(session.usuario_id).first();

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

    const archivosLista = seleccionarUltimosArchivosPorDocumento(archivos?.results || []);
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
      SELECT id, nombre_documento, version_documental, estado
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
    `).bind(documentacionId).all();

    const documentosBaseActivos = await env.DB.prepare(`
      SELECT nombre, version_documental
      FROM admin_documentos_comunes
      WHERE admin_id = ?
        AND activo = 1
    `).bind(session.usuario_id).all();

    const estadoExpediente = calcularEstadoGlobal(
      documentosBaseActivos?.results || [],
      seleccionarUltimosArchivosPorDocumento(archivosActualizados?.results || [])
    );

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

    const notificacionCentro = await enviarEmail(env, {
      to: expediente.email || "",
      subject: `[Documentación] Revisión actualizada por ${nombreVisibleAdmin(secretaria || {})}`,
      text: construirEmailTextoResolucionExpedienteDocumental({
        admin: secretaria || {},
        centro: expediente || {},
        estado_expediente: estadoExpediente,
        cambios: cambiosAplicados
      }),
      html: construirEmailHtmlResolucionExpedienteDocumental({
        admin: secretaria || {},
        centro: expediente || {},
        estado_expediente: estadoExpediente,
        cambios: cambiosAplicados
      })
    });

    const hayRechazos = cambiosAplicados.some((item) => String(item.estado || "").toUpperCase() === "RECHAZADO");
    let notificacionInternaCentro = { ok: false, skipped: true, error: "" };
    try {
      notificacionInternaCentro = await crearNotificacion(env, {
        usuarioId: Number(expediente.centro_usuario_id || 0),
        rolDestino: "SOLICITANTE",
        tipo: "DOCUMENTACION",
        titulo: hayRechazos ? "Documentación revisada con incidencias" : "Documentación revisada",
        mensaje: hayRechazos
          ? `Se ha actualizado la revisión de tu documentación para ${nombreVisibleAdmin(secretaria || {})}. Hay documentos rechazados o con observaciones que debes revisar.`
          : `Se ha actualizado la revisión de tu documentación para ${nombreVisibleAdmin(secretaria || {})}. Ya puedes consultar el resultado en tu perfil.`,
        urlDestino: `/usuario-perfil.html?admin_id=${encodeURIComponent(String(expediente.admin_id || 0))}&tab=documentos`
      });
    } catch (errorNotificacion) {
      notificacionInternaCentro = {
        ok: false,
        skipped: true,
        error: errorNotificacion?.message || String(errorNotificacion || "")
      };
      console.error("No se pudo crear la notificación interna de resolución documental de secretaría.", {
        expediente_id: Number(documentacionId || 0),
        centro_usuario_id: Number(expediente.centro_usuario_id || 0),
        admin_id: Number(expediente.admin_id || 0),
        secretaria_id: Number(session.usuario_id || 0),
        error: notificacionInternaCentro.error
      });
    }

    const impactoReservas = await recalcularImpactoDocumentalReservas(env, {
      adminId: Number(expediente.admin_id || 0),
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
      notificacion_interna_centro: {
        creada: !!notificacionInternaCentro.ok,
        error: notificacionInternaCentro.ok ? "" : (notificacionInternaCentro.error || "")
      },
      impacto_reservas: impactoReservas
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudo aplicar la revisión documental agrupada de la secretaría.",
      detalle: error.message
    }, { status: 500 });
  }
}
