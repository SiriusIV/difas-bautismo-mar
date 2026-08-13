import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import { enviarEmail, nombreVisibleAdmin } from "../_email.js";
import { crearNotificacion } from "../_notificaciones.js";
import {
  construirEmailHtmlResolucionExpedienteDocumental,
  construirEmailTextoResolucionExpedienteDocumental
} from "../_email_resolucion_documental_expediente.js";
import { recalcularImpactoDocumentalReservasPorPropietario } from "../_impacto_documental_reservas.js";
import { registrarEventoReserva } from "../_reservas_historial.js";

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
  if (valor === "VALIDADA" || valor === "APROBADA" || valor === "APROBADO") return "VALIDADO";
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

async function resolverAdminObjetivo(env, session, adminIdParam) {
  const rol = await getRolUsuario(env, session.usuario_id);
  if (rol === "SUPERADMIN") {
    return parsearIdPositivo(adminIdParam) || session.usuario_id;
  }
  return session.usuario_id;
}

async function obtenerDocumentosBaseActivos(env, documentacionId) {
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

function construirResumenDocumentalParaCorreo(documentosBaseActivos, archivosActivos = []) {
  const archivosPorNombre = new Map(
    (archivosActivos || []).map((archivo) => [limpiarTexto(archivo?.nombre_documento), archivo])
  );

  const validados = [];
  const pendientes = [];

  for (const doc of Array.isArray(documentosBaseActivos) ? documentosBaseActivos : []) {
    const nombre = limpiarTexto(doc?.nombre);
    if (!nombre) continue;
    const requerido = Number(doc?.version_documental || 0);
    const entrega = archivosPorNombre.get(nombre) || null;

    if (!entrega) {
      pendientes.push({ nombre, motivo: "No remitido" });
      continue;
    }

    const versionAportada = Number(entrega?.version_documental || 0);
    if (versionAportada !== requerido) {
      pendientes.push({ nombre, motivo: "Desactualizado" });
      continue;
    }

    const estado = normalizarEstadoDocumento(entrega?.estado);
    if (estado === "VALIDADO") {
      validados.push({
        nombre,
        observaciones_admin: limpiarTexto(entrega?.observaciones_admin || "")
      });
      continue;
    }

    if (estado === "RECHAZADO") {
      pendientes.push({ nombre, motivo: "Rechazado" });
      continue;
    }

    pendientes.push({ nombre, motivo: "Pendiente de validación" });
  }

  return {
    completo: pendientes.length === 0 && validados.length > 0,
    validados,
    pendientes
  };
}

async function registrarHistorialRevisionDocumental(env, {
  expediente,
  cambios = [],
  actorUsuarioId,
  actorRol = "ADMIN",
  actorNombre = ""
} = {}) {
  const reservaId = parsearIdPositivo(expediente?.reserva_id) ||
    (Array.isArray(cambios)
      ? cambios.map((cambio) => parsearIdPositivo(cambio?.reserva_id)).find(Boolean)
      : null);
  if (!reservaId) return;

  for (const cambio of Array.isArray(cambios) ? cambios : []) {
    const estado = normalizarEstadoDocumento(cambio?.estado);
    const accion = estado === "RECHAZADO" ? "DOCUMENTACION_RECHAZADA" : estado === "VALIDADO" ? "DOCUMENTACION_VALIDADA" : "DOCUMENTACION_REVISADA";
    try {
      await registrarEventoReserva(env, {
        reservaId,
        accion,
        estadoOrigen: "EN_REVISION",
        estadoDestino: estado,
        observaciones: `Documento: ${limpiarTexto(cambio?.nombre_documento) || "Documento"}.${limpiarTexto(cambio?.observaciones_admin) ? ` Observaciones: ${limpiarTexto(cambio.observaciones_admin)}` : ""}`,
        actorUsuarioId,
        actorRol,
        actorNombre
      });
    } catch (errorHistorial) {
      console.error("No se pudo registrar el hito de revisi�n documental en el historial de la reserva.", {
        reserva_id: reservaId,
        documentacion_id: Number(expediente?.id || 0),
        archivo_id: Number(cambio?.archivo_id || 0),
        error: errorHistorial?.message || String(errorHistorial || "")
      });
    }
  }
}

async function completarExpedienteParaAvisos(env, expediente = {}, cambios = []) {
  const reservaId = parsearIdPositivo(expediente?.reserva_id) ||
    (Array.isArray(cambios)
      ? cambios.map((cambio) => parsearIdPositivo(cambio?.reserva_id)).find(Boolean)
      : null);
  if (!reservaId) return expediente || {};
  const contexto = await env.DB.prepare(`
    SELECT r.id AS reserva_id, r.usuario_id AS centro_usuario_id, r.actividad_id, r.codigo_reserva,
      COALESCE(NULLIF(TRIM(u.centro), ''), NULLIF(TRIM(u.nombre_publico), ''), NULLIF(TRIM(u.nombre), ''), NULLIF(TRIM(r.centro), ''), NULLIF(TRIM(r.contacto), ''), NULLIF(TRIM(u.email), ''), NULLIF(TRIM(r.email), '')) AS centro,
      u.nombre AS usuario_nombre, u.nombre_publico AS usuario_nombre_publico,
      COALESCE(NULLIF(TRIM(u.email), ''), NULLIF(TRIM(r.email), '')) AS email,
      COALESCE(a.titulo_publico, a.nombre, '') AS actividad_nombre,
      f.fecha, f.hora_inicio, f.hora_fin
    FROM reservas r
    LEFT JOIN usuarios u ON u.id = r.usuario_id
    LEFT JOIN actividades a ON a.id = r.actividad_id
    LEFT JOIN franjas f ON f.id = r.franja_id
    WHERE r.id = ?
    LIMIT 1
  `).bind(reservaId).first();
  if (!contexto) return expediente || {};
  return {
    ...(expediente || {}),
    reserva_id: Number(contexto.reserva_id || expediente?.reserva_id || 0) || expediente?.reserva_id,
    centro_usuario_id: Number(contexto.centro_usuario_id || expediente?.centro_usuario_id || 0) || expediente?.centro_usuario_id,
    actividad_id: Number(contexto.actividad_id || expediente?.actividad_id || 0) || expediente?.actividad_id,
    codigo_reserva: limpiarTexto(contexto.codigo_reserva) || expediente?.codigo_reserva || "",
    centro: limpiarTexto(contexto.centro) || expediente?.centro || "",
    usuario_nombre: limpiarTexto(contexto.usuario_nombre) || expediente?.usuario_nombre || "",
    usuario_nombre_publico: limpiarTexto(contexto.usuario_nombre_publico) || expediente?.usuario_nombre_publico || "",
    email: limpiarTexto(contexto.email) || expediente?.email || "",
    actividad_nombre: limpiarTexto(contexto.actividad_nombre) || expediente?.actividad_nombre || "",
    fecha: limpiarTexto(contexto.fecha) || expediente?.fecha || "",
    hora_inicio: limpiarTexto(contexto.hora_inicio) || expediente?.hora_inicio || "",
    hora_fin: limpiarTexto(contexto.hora_fin) || expediente?.hora_fin || ""
  };
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
    const cambiosEntrada = Array.isArray(body?.cambios) ? body.cambios : [];
    const baseUrl = new URL(request.url).origin;
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
        f.hora_fin
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios u ON u.id = cad.centro_usuario_id
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
    `).bind(documentacionId, adminId).first();

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
        a.observaciones_admin,
        a.actividad_id,
        a.reserva_id
      FROM centro_admin_documentacion_archivos a
      INNER JOIN admin_documentos_comunes d
        ON d.admin_id = ?
       AND COALESCE(d.activo, 1) = 1
       AND UPPER(TRIM(COALESCE(d.nombre, ''))) = UPPER(TRIM(COALESCE(a.nombre_documento, '')))
      WHERE a.documentacion_id = ?
        AND a.activo = 1
      ORDER BY a.nombre_documento ASC, a.id ASC
    `).bind(adminId, documentacionId).all();

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
        actividad_id: archivo.actividad_id || null,
        reserva_id: archivo.reserva_id || null,
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
        estado,
        observaciones_admin
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
    `).bind(documentacionId).all();

    const ultimosArchivos = seleccionarUltimosArchivosPorDocumento(archivosActualizados?.results || []);
    const documentosBaseActivos = await obtenerDocumentosBaseActivos(env, documentacionId);
    const estadoExpediente = calcularEstadoGlobal(
      documentosBaseActivos,
      ultimosArchivos
    );
    const resumenDocumentalCorreo = construirResumenDocumentalParaCorreo(documentosBaseActivos, ultimosArchivos);

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

    const expedienteAvisos = await completarExpedienteParaAvisos(env, expediente, cambiosAplicados);

    let notificacionCentro = { ok: false, skipped: true, error: "" };
    try {
      notificacionCentro = await enviarEmail(env, {
        to: expedienteAvisos.email || "",
        subject: `[Documentación] Revisión actualizada por ${nombreVisibleAdmin(admin || {})}`,
        text: construirEmailTextoResolucionExpedienteDocumental({
          admin: admin || {},
          centro: expedienteAvisos || {},
          estado_expediente: estadoExpediente,
          cambios: cambiosAplicados,
          resumen_documental: resumenDocumentalCorreo
        }),
        html: construirEmailHtmlResolucionExpedienteDocumental({
          admin: admin || {},
          centro: expedienteAvisos || {},
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
      console.error("No se pudo enviar correo de revision documental agrupada (admin).", {
        expediente_id: Number(documentacionId || 0),
        centro_usuario_id: Number(expedienteAvisos.centro_usuario_id || 0),
        admin_id: Number(expediente.admin_id || 0),
        revisor_id: Number(session.usuario_id || 0),
        error: notificacionCentro.error
      });
    }
    await registrarHistorialRevisionDocumental(env, {
      expediente: expedienteAvisos,
      cambios: cambiosAplicados,
      actorUsuarioId: session.usuario_id,
      actorRol: "ADMIN",
      actorNombre: nombreVisibleAdmin(admin || {})
    });

    const hayRechazos = cambiosAplicados.some((item) => String(item.estado || "").toUpperCase() === "RECHAZADO");
    let notificacionInternaCentro = { ok: false, skipped: true, error: "" };
    try {
      notificacionInternaCentro = await crearNotificacion(env, {
        usuarioId: Number(expedienteAvisos.centro_usuario_id || 0),
        rolDestino: "SOLICITANTE",
        tipo: "DOCUMENTACION",
        titulo: hayRechazos ? "Documentación revisada con incidencias" : "Documentación revisada",
        mensaje: hayRechazos
          ? `Se ha actualizado la revisión de tu documentación para ${nombreVisibleAdmin(admin || {})}. Hay documentos rechazados o con observaciones que debes revisar en tu solicitud.`
          : `Se ha actualizado la revisión de tu documentación para ${nombreVisibleAdmin(admin || {})}. Ya puedes consultar el resultado en tu panel de reservas.`,
        urlDestino: "/usuario-panel.html"
      });
    } catch (errorNotificacion) {
      notificacionInternaCentro = {
        ok: false,
        skipped: true,
        error: errorNotificacion?.message || String(errorNotificacion || "")
      };
      console.error("No se pudo crear la notificación interna de resolución documental del administrador.", {
        expediente_id: Number(documentacionId || 0),
        centro_usuario_id: Number(expedienteAvisos.centro_usuario_id || 0),
        admin_id: Number(expediente.admin_id || 0),
        revisor_id: Number(session.usuario_id || 0),
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
      console.error("No se pudo recalcular impacto documental de reservas (admin).", {
        expediente_id: Number(documentacionId || 0),
        admin_id: Number(expediente.admin_id || 0),
        revisor_id: Number(session.usuario_id || 0),
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
