import { enviarEmail, nombreVisibleAdmin } from "../_email.js";
import { crearNotificacion } from "../_notificaciones.js";
import {
  construirEmailHtmlResolucionExpedienteDocumental,
  construirEmailTextoResolucionExpedienteDocumental
} from "../_email_resolucion_documental_expediente.js";
import { recalcularImpactoDocumentalReservasPorPropietario } from "../_impacto_documental_reservas.js";
import { getSecretariaSession } from "./_documental.js";

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
  const valor = limpiarTexto(estado)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (valor === "VALIDADA" || valor === "APROBADA") return "VALIDADO";
  if (valor === "EN REVISION") return "EN_REVISION";
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

async function obtenerExpedienteConDocumentosPropios(env, propietarioId, documentacionId) {
  return await env.DB.prepare(`
    SELECT
      cad.id,
      cad.centro_usuario_id,
      cad.admin_id,
      cad.actividad_id,
      cad.reserva_id,
      cad.version_requerida,
      u.centro,
      u.nombre AS usuario_nombre,
      u.nombre_publico AS usuario_nombre_publico,
      u.email,
      COALESCE(a.titulo_publico, a.nombre, '') AS actividad_nombre,
      r.codigo_reserva,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      admin.nombre AS admin_nombre,
      admin.nombre_publico AS admin_nombre_publico
    FROM centro_admin_documentacion cad
    INNER JOIN usuarios u ON u.id = cad.centro_usuario_id
    INNER JOIN usuarios admin ON admin.id = cad.admin_id
    LEFT JOIN actividades a ON a.id = cad.actividad_id
    LEFT JOIN reservas r ON r.id = cad.reserva_id
    LEFT JOIN franjas f ON f.id = r.franja_id
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
  `).bind(documentacionId, propietarioId).first();
}

async function obtenerDocumentosBaseExpediente(env, documentacionId) {
  const rows = await env.DB.prepare(`
    SELECT DISTINCT d.nombre, d.version_documental
    FROM centro_admin_documentacion_archivos a
    INNER JOIN admin_documentos_comunes d
      ON UPPER(TRIM(COALESCE(d.nombre, ''))) = UPPER(TRIM(COALESCE(a.nombre_documento, '')))
     AND COALESCE(d.activo, 1) = 1
    WHERE a.documentacion_id = ?
      AND a.activo = 1
  `).bind(documentacionId).all();

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

function construirResumenDocumentalParaCorreo(documentosBaseActivos, archivosActivos = []) {
  const archivosPorNombre = new Map(
    (archivosActivos || []).map((archivo) => [limpiarTexto(archivo?.nombre_documento), archivo])
  );
  const validados = [];
  const pendientes = [];

  for (const doc of Array.isArray(documentosBaseActivos) ? documentosBaseActivos : []) {
    const nombre = limpiarTexto(doc?.nombre);
    if (!nombre) continue;
    const entrega = archivosPorNombre.get(nombre) || null;

    if (!entrega) {
      pendientes.push({ nombre, motivo: "No remitido" });
      continue;
    }
    if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) {
      pendientes.push({ nombre, motivo: "Desactualizado" });
      continue;
    }
    const estado = normalizarEstadoDocumento(entrega.estado);
    if (estado === "VALIDADO") {
      validados.push({ nombre, observaciones_admin: limpiarTexto(entrega?.observaciones_admin || "") });
    } else if (estado === "RECHAZADO") {
      pendientes.push({ nombre, motivo: "Rechazado" });
    } else {
      pendientes.push({ nombre, motivo: "Pendiente de validación" });
    }
  }

  return { completo: pendientes.length === 0 && validados.length > 0, validados, pendientes };
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

    const expediente = await obtenerExpedienteConDocumentosPropios(env, session.usuario_id, documentacionId);
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
        a.id,
        a.nombre_documento,
        a.archivo_url,
        a.version_documental,
        a.estado,
        a.observaciones_admin
      FROM centro_admin_documentacion_archivos a
      INNER JOIN admin_documentos_comunes d
        ON d.admin_id = ?
       AND COALESCE(d.activo, 1) = 1
       AND UPPER(TRIM(COALESCE(d.nombre, ''))) = UPPER(TRIM(COALESCE(a.nombre_documento, '')))
      WHERE a.documentacion_id = ?
        AND a.activo = 1
      ORDER BY a.nombre_documento ASC, a.id ASC
    `).bind(session.usuario_id, documentacionId).all();

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

    const documentosBaseActivos = await obtenerDocumentosBaseExpediente(env, documentacionId);

    const estadoExpediente = calcularEstadoGlobal(
      documentosBaseActivos,
      seleccionarUltimosArchivosPorDocumento(archivosActualizados?.results || [])
    );
    const resumenDocumentalCorreo = construirResumenDocumentalParaCorreo(
      documentosBaseActivos,
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

    let notificacionCentro = { ok: false, skipped: true, error: "" };
    try {
      notificacionCentro = await enviarEmail(env, {
        to: expediente.email || "",
        subject: `[Documentación] Revisión actualizada por ${nombreVisibleAdmin(secretaria || {})}`,
        text: construirEmailTextoResolucionExpedienteDocumental({
          admin: secretaria || {},
          centro: expediente || {},
          estado_expediente: estadoExpediente,
          cambios: cambiosAplicados,
          resumen_documental: resumenDocumentalCorreo
        }),
        html: construirEmailHtmlResolucionExpedienteDocumental({
          admin: secretaria || {},
          centro: expediente || {},
          estado_expediente: estadoExpediente,
          cambios: cambiosAplicados,
          resumen_documental: resumenDocumentalCorreo
        })
      });
    } catch (errorEmail) {
      notificacionCentro = {
        ok: false,
        skipped: true,
        error: errorEmail?.message || String(errorEmail || "")
      };
      console.error("No se pudo enviar correo de revision documental agrupada (secretaria).", {
        expediente_id: Number(documentacionId || 0),
        centro_usuario_id: Number(expediente.centro_usuario_id || 0),
        admin_id: Number(expediente.admin_id || 0),
        secretaria_id: Number(session.usuario_id || 0),
        error: notificacionCentro.error
      });
    }

    const hayRechazos = cambiosAplicados.some((item) => String(item.estado || "").toUpperCase() === "RECHAZADO");
    let notificacionInternaCentro = { ok: false, skipped: true, error: "" };
    try {
      notificacionInternaCentro = await crearNotificacion(env, {
        usuarioId: Number(expediente.centro_usuario_id || 0),
        rolDestino: "SOLICITANTE",
        tipo: "DOCUMENTACION",
        titulo: hayRechazos ? "Documentación revisada con incidencias" : "Documentación revisada",
        mensaje: hayRechazos
          ? `Se ha actualizado la revisión de tu documentación para ${nombreVisibleAdmin(secretaria || {})}. Hay documentos rechazados o con observaciones que debes revisar en tu solicitud.`
          : `Se ha actualizado la revisión de tu documentación para ${nombreVisibleAdmin(secretaria || {})}. Ya puedes consultar el resultado en tu panel de reservas.`,
        urlDestino: "/usuario-panel.html"
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

    let impactoReservas = {
      ok: false,
      error: "No se pudo recalcular el impacto documental de reservas."
    };
    try {
      impactoReservas = await recalcularImpactoDocumentalReservasPorPropietario(env, {
        propietarioDocumentalId: Number(expediente.admin_id || 0),
        baseUrl,
        motivo: "documentos_actualizados"
      });
    } catch (errorImpacto) {
      console.error("No se pudo recalcular impacto documental de reservas (secretaria).", {
        expediente_id: Number(documentacionId || 0),
        admin_id: Number(expediente.admin_id || 0),
        secretaria_id: Number(session.usuario_id || 0),
        error: errorImpacto?.message || String(errorImpacto || "")
      });
    }

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
