import { getSecretariaSession } from "./_documental.js";
import {
  construirEmailHtmlResolucionExpedienteDocumental,
  construirEmailTextoResolucionExpedienteDocumental
} from "../_email_resolucion_documental_expediente.js";
import { enviarEmail, nombreVisibleAdmin } from "../_email.js";
import { crearNotificacion } from "../_notificaciones.js";
import { recalcularImpactoDocumentalReservas } from "../_impacto_documental_reservas.js";
import { construirResumenActividadesSolicitables } from "../_documentacion_actividades_solicitables.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function parsearIdPositivo(valor) {
  const n = Number.parseInt(String(valor || ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizarEstadoDocumento(estado) {
  const valor = String(estado || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (valor === "VALIDADA" || valor === "APROBADA") return "VALIDADO";
  if (valor === "EN REVISION") return "EN_REVISION";
  return valor || "EN_REVISION";
}

function calcularEstadoDocumento(doc, entrega) {
  if (!entrega) return "NO_ENVIADO";
  if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) return "NO_ACTUALIZADO";
  return normalizarEstadoDocumento(entrega.estado);
}

function calcularEstadoGlobal(documentosBaseActivos, archivosActivos) {
  if (!Array.isArray(documentosBaseActivos) || documentosBaseActivos.length === 0) return "NO_REQUERIDA";
  const archivosPorNombre = new Map((archivosActivos || []).map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo]));
  const estados = documentosBaseActivos.map((doc) => calcularEstadoDocumento(doc, archivosPorNombre.get(limpiarTexto(doc.nombre)) || null));
  if (estados.some((estado) => estado === "RECHAZADO")) return "RECHAZADA";
  if (estados.some((estado) => estado === "NO_ACTUALIZADO")) return "NO_ACTUALIZADO";
  if (estados.some((estado) => estado === "EN_REVISION")) return "EN_REVISION";
  if (estados.every((estado) => estado === "NO_ENVIADO")) return "NO_INICIADO";
  if (estados.every((estado) => estado === "VALIDADO")) return "VALIDADA";
  return "VALIDACION_PARCIAL";
}

function construirResumenDocumentalParaCorreo(documentosBaseActivos, archivosActivos = []) {
  const archivosPorNombre = new Map((archivosActivos || []).map((archivo) => [limpiarTexto(archivo?.nombre_documento), archivo]));
  const validados = [];
  const pendientes = [];
  for (const doc of Array.isArray(documentosBaseActivos) ? documentosBaseActivos : []) {
    const nombre = limpiarTexto(doc?.nombre);
    if (!nombre) continue;
    const entrega = archivosPorNombre.get(nombre) || null;
    const estado = calcularEstadoDocumento(doc, entrega);
    if (estado === "VALIDADO") {
      validados.push({ nombre, observaciones_admin: limpiarTexto(entrega?.observaciones_admin || "") });
    } else if (estado === "NO_ENVIADO") {
      pendientes.push({ nombre, motivo: "No remitido" });
    } else if (estado === "NO_ACTUALIZADO") {
      pendientes.push({ nombre, motivo: "Desactualizado" });
    } else if (estado === "RECHAZADO") {
      pendientes.push({ nombre, motivo: "Rechazado" });
    } else {
      pendientes.push({ nombre, motivo: "Pendiente de validaciÃ³n" });
    }
  }
  return { completo: pendientes.length === 0 && validados.length > 0, validados, pendientes };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const session = await getSecretariaSession(request, env);
    if (!session || session.rol !== "SECRETARIA") return json({ ok: false, error: "No autorizado." }, 401);

    const body = await request.json().catch(() => ({}));
    const accion = limpiarTexto(body?.accion).toLowerCase();
    const documentacionId = parsearIdPositivo(body?.documentacion_id);
    const archivoId = parsearIdPositivo(body?.archivo_id);
    if (!["eliminar", "validar", "rechazar"].includes(accion)) return json({ ok: false, error: "AcciÃ³n no vÃ¡lida." }, 400);
    if (!documentacionId || !archivoId) return json({ ok: false, error: "Faltan identificadores de documento." }, 400);

    const expediente = await env.DB.prepare(`
      SELECT cad.id, cad.admin_id, cad.centro_usuario_id
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios admin ON admin.id = cad.admin_id
      WHERE cad.id = ?
        AND admin.rol = 'ADMIN'
        AND COALESCE(admin.modulo_secretaria, 0) = 0
        AND admin.secretaria_usuario_id = ?
      LIMIT 1
    `).bind(documentacionId, Number(session.usuario_id || 0)).first();
    if (!expediente) return json({ ok: false, error: "Sin permisos para gestionar esta documentaciÃ³n." }, 403);

    const archivo = await env.DB.prepare(`
      SELECT id, nombre_documento
      FROM centro_admin_documentacion_archivos
      WHERE id = ?
        AND documentacion_id = ?
        AND activo = 1
      LIMIT 1
    `).bind(archivoId, documentacionId).first();
    if (!archivo) return json({ ok: false, error: "Documento remitido no encontrado." }, 404);

    if (accion === "eliminar") {
      await env.DB.prepare(`
        UPDATE centro_admin_documentacion_archivos
        SET activo = 0,
            estado = 'NO_ENVIADO',
            observaciones_admin = 'Eliminado por la secretarÃ­a',
            validado_por_admin_id = NULL,
            fecha_validacion = NULL
        WHERE id = ?
      `).bind(archivoId).run();
    } else {
      const estadoDestino = accion === "validar" ? "VALIDADO" : "RECHAZADO";
      await env.DB.prepare(`
        UPDATE centro_admin_documentacion_archivos
        SET estado = ?,
            fecha_validacion = CASE WHEN ? = 'VALIDADO' THEN CURRENT_TIMESTAMP ELSE NULL END,
            validado_por_admin_id = ?,
            observaciones_admin = NULL
        WHERE id = ?
      `).bind(estadoDestino, estadoDestino, Number(session.usuario_id || 0), archivoId).run();
    }

    const adminId = Number(expediente.admin_id || 0);
    const docsBaseRows = await env.DB.prepare(`
      SELECT nombre, version_documental
      FROM admin_documentos_comunes
      WHERE admin_id = ?
        AND activo = 1
    `).bind(Number(session.usuario_id || 0)).all();
    const documentosBaseActivos = (docsBaseRows?.results || []).map((row) => ({
      nombre: limpiarTexto(row.nombre),
      version_documental: Number(row.version_documental || 0)
    })).filter((item) => item.nombre);

    const archivosActivosRows = await env.DB.prepare(`
      SELECT id, nombre_documento, version_documental, estado, observaciones_admin
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
    `).bind(documentacionId).all();
    const archivosActivos = archivosActivosRows?.results || [];
    const estadoExpediente = calcularEstadoGlobal(documentosBaseActivos, archivosActivos);

    await env.DB.prepare(`
      UPDATE centro_admin_documentacion
      SET estado = ?,
          fecha_validacion = CASE WHEN ? = 'VALIDADA' THEN CURRENT_TIMESTAMP ELSE NULL END,
          validado_por_admin_id = CASE WHEN ? = 'VALIDADA' THEN ? ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(estadoExpediente, estadoExpediente, estadoExpediente, Number(session.usuario_id || 0), documentacionId).run();

    const admin = await env.DB.prepare(`
      SELECT id, nombre, nombre_publico, localidad, email
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(adminId).first();
    const centro = await env.DB.prepare(`
      SELECT id, centro, email
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(Number(expediente.centro_usuario_id || 0)).first();

    const resumenCorreo = construirResumenDocumentalParaCorreo(documentosBaseActivos, archivosActivos);
    let resumenActividadesCorreo = null;
    try {
      resumenActividadesCorreo = await construirResumenActividadesSolicitables(env, {
        adminId,
        documentacionId
      });
    } catch (errorResumenActividades) {
      console.error("No se pudo calcular el resumen de actividades solicitables (secretarÃ­a).", {
        admin_id: adminId,
        documentacion_id: documentacionId,
        error: errorResumenActividades?.message || String(errorResumenActividades || "")
      });
    }
    const cambioTexto = accion === "eliminar" ? "NO_ENVIADO" : (accion === "validar" ? "VALIDADO" : "RECHAZADO");
    try {
      await enviarEmail(env, {
      to: centro?.email || "",
      subject: `[DocumentaciÃ³n] RevisiÃ³n actualizada por ${nombreVisibleAdmin(admin || {})}`,
      text: construirEmailTextoResolucionExpedienteDocumental({
        admin: admin || {},
        centro: centro || {},
        estado_expediente: estadoExpediente,
        cambios: [{
          nombre_documento: limpiarTexto(archivo.nombre_documento || ""),
          estado: cambioTexto,
          observaciones_admin: accion === "eliminar" ? "Documento eliminado por la secretarÃ­a." : ""
        }],
        resumen_documental: resumenCorreo,
        resumen_actividades: resumenActividadesCorreo
      }),
      html: construirEmailHtmlResolucionExpedienteDocumental({
        admin: admin || {},
        centro: centro || {},
        estado_expediente: estadoExpediente,
        cambios: [{
          nombre_documento: limpiarTexto(archivo.nombre_documento || ""),
          estado: cambioTexto,
          observaciones_admin: accion === "eliminar" ? "Documento eliminado por la secretarÃ­a." : ""
        }],
        resumen_documental: resumenCorreo,
        resumen_actividades: resumenActividadesCorreo
      }),
      dedupe: true,
      dedupeSegundos: 300
      });
    } catch (errorEmail) {
      console.error("No se pudo enviar correo de actualizaciÃ³n documental (secretarÃ­a).", {
        admin_id: adminId,
        centro_usuario_id: Number(expediente.centro_usuario_id || 0),
        documentacion_id: documentacionId,
        error: errorEmail?.message || String(errorEmail || "")
      });
    }

    try {
      await crearNotificacion(env, {
        usuarioId: Number(expediente.centro_usuario_id || 0),
        rolDestino: "SOLICITANTE",
        tipo: "DOCUMENTACION",
        titulo: "Documentación actualizada",
        mensaje: "Se ha actualizado el estado de tu documentación obligatoria. Revisa tu perfil.",
        urlDestino: `/usuario-perfil.html?admin_id=${encodeURIComponent(String(adminId))}&tab=documentos`
      });
    } catch (errorNotificacion) {
      console.error("No se pudo crear notificación interna de actualización documental (secretaría).", {
        admin_id: adminId,
        centro_usuario_id: Number(expediente.centro_usuario_id || 0),
        documentacion_id: documentacionId,
        error: errorNotificacion?.message || String(errorNotificacion || "")
      });
    }

    const baseUrl = new URL(request.url).origin;
    let impactoReservas = {
      ok: false,
      error: "No se pudo recalcular el impacto documental de reservas."
    };
    try {
      impactoReservas = await recalcularImpactoDocumentalReservas(env, {
        adminId,
        baseUrl,
        motivo: "documentos_actualizados"
      });
    } catch (errorImpacto) {
      console.error("No se pudo recalcular impacto documental de reservas (secretaría).", {
        admin_id: adminId,
        documentacion_id: documentacionId,
        error: errorImpacto?.message || String(errorImpacto || "")
      });
    }

    return json({
      ok: true,
      mensaje: "Documento actualizado correctamente.",
      estado_expediente: estadoExpediente,
      impacto_reservas: impactoReservas
    });
  } catch (error) {
    return json({ ok: false, error: "No se pudo actualizar el documento.", detalle: error?.message || String(error) }, 500);
  }
}


