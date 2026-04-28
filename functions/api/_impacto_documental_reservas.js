import {
  enviarEmail,
  nombreVisibleAdmin
} from "./_email.js";
import {
  construirEmailHtmlReservaCondicionadaDocumentacion,
  construirEmailHtmlReservaReactivadaDocumentacion,
  construirEmailTextoReservaCondicionadaDocumentacion,
  construirEmailTextoReservaReactivadaDocumentacion
} from "./_email_reservas_documentacion.js";
import { resolverResponsableDocumental } from "./_documentacion_responsable.js";
import { crearNotificacion } from "./_notificaciones.js";

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function parsearFecha(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return null;
  const fecha = new Date(texto.replace(" ", "T"));
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function normalizarEstadoDocumento(estado) {
  const valor = limpiarTexto(estado).toUpperCase();
  return valor || "EN_REVISION";
}

function calcularEstadoDocumento(doc, entrega) {
  if (!entrega) return "NO_ENVIADO";
  if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) {
    return "NO_ACTUALIZADO";
  }
  return normalizarEstadoDocumento(entrega.estado);
}

function calcularEstadoGlobal(documentosActivos, archivosActivos) {
  if (!Array.isArray(documentosActivos) || documentosActivos.length === 0) {
    return "NO_REQUERIDA";
  }

  const archivosPorNombre = new Map(
    (archivosActivos || []).map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo])
  );

  const estados = documentosActivos.map((doc) => {
    const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;
    return calcularEstadoDocumento(doc, entrega);
  });

  if (estados.every((estado) => estado === "NO_ENVIADO")) return "NO_INICIADO";
  if (estados.some((estado) => estado === "RECHAZADO")) return "RECHAZADA";
  if (estados.some((estado) => estado === "NO_ACTUALIZADO")) return "NO_ACTUALIZADO";
  if (estados.some((estado) => estado === "NO_ENVIADO")) return "NO_COMPLETADO";
  if (estados.every((estado) => estado === "VALIDADO")) return "VALIDADA";
  return "EN_REVISION";
}

function estadoDocumentalCompleto(estado) {
  return ["VALIDADA", "NO_REQUERIDA"].includes(String(estado || "").toUpperCase());
}

function motivoImpactoDocumentalTexto(motivo) {
  const clave = limpiarTexto(motivo).toLowerCase();
  if (clave === "cambio_responsable") {
    return "Ha cambiado el responsable de la documentacion obligatoria del organizador.";
  }
  if (clave === "documento_activado") {
    return "Se ha activado un documento obligatorio que ahora pasa a ser exigible.";
  }
  if (clave === "documento_creado") {
    return "Se ha creado un nuevo documento obligatorio.";
  }
  if (clave === "documento_eliminado") {
    return "Se ha eliminado un documento obligatorio del marco vigente.";
  }
  if (clave === "documentos_actualizados") {
    return "Se ha actualizado el conjunto de documentos obligatorios vigente.";
  }
  return "Se ha producido un cambio en la documentacion obligatoria vigente.";
}

function construirUrlPerfilDocumentacion(baseUrl, adminId) {
  const base = limpiarTexto(baseUrl);
  if (!base || !adminId) return "";

  try {
    const url = new URL("/usuario-perfil.html", base);
    url.searchParams.set("admin_id", String(adminId));
    return url.toString();
  } catch {
    return "";
  }
}

async function obtenerDocumentosActivosVigentes(env, adminId) {
  const resolucion = await resolverResponsableDocumental(env, adminId);
  const propietarioId = Number(
    String(resolucion?.modo || "").toUpperCase() === "SECRETARIA_EXTERNA"
      ? resolucion?.responsable?.id || 0
      : resolucion?.admin?.id || 0
  );

  const rows = await env.DB.prepare(`
    SELECT
      id,
      nombre,
      descripcion,
      version_documental,
      fecha_actualizacion
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND activo = 1
    ORDER BY orden ASC, id ASC
  `).bind(propietarioId || adminId).all();

  return {
    resolucion,
    propietario_documental_id: propietarioId || adminId,
    documentos: rows?.results || []
  };
}

async function obtenerSolicitantesAfectados(env, adminId) {
  const rows = await env.DB.prepare(`
    SELECT DISTINCT
      u.id,
      u.centro,
      u.email
    FROM usuarios u
    WHERE u.rol = 'SOLICITANTE'
      AND u.id IN (
        SELECT cad.centro_usuario_id
        FROM centro_admin_documentacion cad
        WHERE cad.admin_id = ?
        UNION
        SELECT r.usuario_id
        FROM reservas r
        INNER JOIN actividades a ON a.id = r.actividad_id
        WHERE a.admin_id = ?
      )
    ORDER BY COALESCE(u.centro, u.email, u.id) ASC
  `).bind(adminId, adminId).all();

  return rows?.results || [];
}

async function obtenerExpediente(env, adminId, centroUsuarioId) {
  return await env.DB.prepare(`
    SELECT
      id,
      admin_id,
      centro_usuario_id,
      version_requerida,
      version_aportada,
      estado,
      fecha_ultima_entrega,
      fecha_validacion,
      observaciones_admin
    FROM centro_admin_documentacion
    WHERE admin_id = ?
      AND centro_usuario_id = ?
    LIMIT 1
  `).bind(adminId, centroUsuarioId).first();
}

async function asegurarExpediente(env, adminId, centroUsuarioId, versionRequerida, estadoInicial) {
  let expediente = await obtenerExpediente(env, adminId, centroUsuarioId);
  if (expediente) return expediente;

  await env.DB.prepare(`
    INSERT INTO centro_admin_documentacion (
      centro_usuario_id,
      admin_id,
      version_requerida,
      version_aportada,
      estado,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    centroUsuarioId,
    adminId,
    versionRequerida,
    estadoInicial
  ).run();

  return await obtenerExpediente(env, adminId, centroUsuarioId);
}

async function obtenerArchivosActivosExpediente(env, expedienteId) {
  const rows = await env.DB.prepare(`
    SELECT
      id,
      nombre_documento,
      version_documental,
      estado,
      archivo_url,
      fecha_subida
    FROM centro_admin_documentacion_archivos
    WHERE documentacion_id = ?
      AND activo = 1
    ORDER BY id ASC
  `).bind(expedienteId).all();

  return rows?.results || [];
}

async function actualizarExpediente(env, expedienteId, datos) {
  await env.DB.prepare(`
    UPDATE centro_admin_documentacion
    SET
      version_requerida = ?,
      version_aportada = ?,
      estado = ?,
      fecha_ultima_entrega = ?,
      fecha_validacion = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    Number(datos.version_requerida || 0),
    Number(datos.version_aportada || 0),
    datos.estado || "NO_INICIADO",
    datos.fecha_ultima_entrega || null,
    datos.fecha_validacion || null,
    expedienteId
  ).run();
}

async function obtenerReservasActivasPorUsuario(env, adminId, usuarioId) {
  const rows = await env.DB.prepare(`
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado,
      r.actividad_id,
      r.franja_id,
      r.fecha_solicitud,
      r.fecha_modificacion
    FROM reservas r
    INNER JOIN actividades a ON a.id = r.actividad_id
    WHERE a.admin_id = ?
      AND r.usuario_id = ?
      AND r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
    ORDER BY r.fecha_solicitud ASC, r.id ASC
  `).bind(adminId, usuarioId).all();

  return rows?.results || [];
}

function construirPendientes(documentosActivos, archivosActivos) {
  const archivosPorNombre = new Map(
    (archivosActivos || []).map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo])
  );

  return (documentosActivos || []).map((doc) => {
    const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;
    const estado = calcularEstadoDocumento(doc, entrega);
    return {
      id: Number(doc.id || 0),
      nombre: limpiarTexto(doc.nombre),
      descripcion: limpiarTexto(doc.descripcion),
      version_documental: Number(doc.version_documental || 0),
      estado
    };
  }).filter((doc) => doc.estado !== "VALIDADO");
}

async function actualizarEstadoReserva(env, reservaId, nuevoEstado) {
  await env.DB.prepare(`
    UPDATE reservas
    SET
      estado = ?,
      fecha_modificacion = datetime('now')
    WHERE id = ?
  `).bind(nuevoEstado, reservaId).run();
}

async function notificarReservaCondicionada(env, payload) {
  return await enviarEmail(env, {
    to: payload?.centro?.email || "",
    subject: `[Reservas] Solicitud suspendida por documentacion en ${nombreVisibleAdmin(payload?.admin)}`,
    text: construirEmailTextoReservaCondicionadaDocumentacion(payload),
    html: construirEmailHtmlReservaCondicionadaDocumentacion(payload)
  });
}

async function notificarReservaReactivada(env, payload) {
  return await enviarEmail(env, {
    to: payload?.centro?.email || "",
    subject: `[Reservas] Solicitud reactivada en ${nombreVisibleAdmin(payload?.admin)}`,
    text: construirEmailTextoReservaReactivadaDocumentacion(payload),
    html: construirEmailHtmlReservaReactivadaDocumentacion(payload)
  });
}

async function crearNotificacionReservaCondicionada(env, payload) {
  return await crearNotificacion(env, {
    usuarioId: Number(payload?.centro?.usuario_id || 0),
    rolDestino: "SOLICITANTE",
    tipo: "DOCUMENTACION",
    titulo: "Documentación pendiente para tus reservas",
    mensaje: `Tu documentación para ${nombreVisibleAdmin(payload?.admin)} necesita revisión o actualización. Algunas reservas han quedado suspendidas hasta que la regularices.`,
    urlDestino: payload?.enlace_perfil || ""
  });
}

async function crearNotificacionReservaReactivada(env, payload) {
  return await crearNotificacion(env, {
    usuarioId: Number(payload?.centro?.usuario_id || 0),
    rolDestino: "SOLICITANTE",
    tipo: "DOCUMENTACION",
    titulo: "Documentación al día y reservas reactivadas",
    mensaje: `Tu documentación para ${nombreVisibleAdmin(payload?.admin)} vuelve a estar al día. Ya puedes consultar tus reservas reactivadas en tu perfil.`,
    urlDestino: payload?.enlace_perfil || ""
  });
}

export async function recalcularImpactoDocumentalReservas(env, {
  adminId,
  baseUrl = "",
  motivo = "documentos_actualizados"
} = {}) {
  const adminIdNumerico = Number(adminId || 0);
  if (!(adminIdNumerico > 0)) {
    return {
      ok: false,
      error: "admin_id no valido."
    };
  }

  const { resolucion, documentos } = await obtenerDocumentosActivosVigentes(env, adminIdNumerico);
  if (!resolucion?.admin) {
    return {
      ok: false,
      error: "Administrador no encontrado."
    };
  }

  const admin = resolucion.admin;
  const solicitantes = await obtenerSolicitantesAfectados(env, adminIdNumerico);
  const versionRequerida = (documentos || []).reduce(
    (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
    0
  );

  const resumen = {
    ok: true,
    admin_id: adminIdNumerico,
    motivo,
    total_solicitantes_revisados: 0,
    reservas_suspendidas: 0,
    reservas_reactivadas: 0,
    notificaciones_condicionadas: 0,
    notificaciones_reactivadas: 0,
    detalle: []
  };

  for (const solicitante of solicitantes) {
    resumen.total_solicitantes_revisados += 1;

    const estadoInicial = (documentos || []).length > 0 ? "NO_INICIADO" : "NO_REQUERIDA";
    const expediente = await asegurarExpediente(
      env,
      adminIdNumerico,
      Number(solicitante.id || 0),
      versionRequerida,
      estadoInicial
    );

    const archivosActivos = expediente?.id
      ? await obtenerArchivosActivosExpediente(env, Number(expediente.id || 0))
      : [];

    const estadoGlobal = calcularEstadoGlobal(documentos, archivosActivos);
    const pendientes = construirPendientes(documentos, archivosActivos);
    const versionAportada = archivosActivos.reduce(
      (max, archivo) => Math.max(max, Number(archivo.version_documental || 0)),
      0
    );
    const fechaUltimaEntrega = archivosActivos.reduce((max, archivo) => {
      const actual = parsearFecha(archivo.fecha_subida);
      if (!actual) return max;
      if (!max || actual > max) return actual;
      return max;
    }, null);

    await actualizarExpediente(env, Number(expediente.id || 0), {
      version_requerida: versionRequerida,
      version_aportada: versionAportada,
      estado: estadoGlobal,
      fecha_ultima_entrega: fechaUltimaEntrega ? fechaUltimaEntrega.toISOString().replace("T", " ").slice(0, 19) : null,
      fecha_validacion: estadoGlobal === "VALIDADA" ? (expediente?.fecha_validacion || null) : null
    });

    const reservas = await obtenerReservasActivasPorUsuario(env, adminIdNumerico, Number(solicitante.id || 0));
    if (!reservas.length) {
      resumen.detalle.push({
        centro_usuario_id: Number(solicitante.id || 0),
        email: solicitante.email || "",
        reservas_afectadas: [],
        estado_documental: estadoGlobal,
        accion: "SIN_RESERVAS"
      });
      continue;
    }

    const enlacePerfil = construirUrlPerfilDocumentacion(baseUrl, adminIdNumerico);
    const reservasSuspendidas = [];
    const reservasReactivadas = [];

    for (const reserva of reservas) {
      const estadoReserva = limpiarTexto(reserva.estado).toUpperCase();
      if (estadoDocumentalCompleto(estadoGlobal)) {
        if (estadoReserva === "SUSPENDIDA") {
          await actualizarEstadoReserva(env, Number(reserva.id || 0), "CONFIRMADA");
          reservasReactivadas.push(reserva);
          resumen.reservas_reactivadas += 1;
        }
      } else if (estadoReserva !== "SUSPENDIDA") {
        await actualizarEstadoReserva(env, Number(reserva.id || 0), "SUSPENDIDA");
        reservasSuspendidas.push(reserva);
        resumen.reservas_suspendidas += 1;
      }
    }

    if (reservasSuspendidas.length) {
      const payloadNotificacion = {
        admin,
        responsable: resolucion.responsable,
        centro: {
          usuario_id: Number(solicitante.id || 0),
          centro: solicitante.centro || "",
          email: solicitante.email || ""
        },
        motivo_texto: motivoImpactoDocumentalTexto(motivo),
        reservas: reservasSuspendidas,
        documentos_pendientes: pendientes,
        enlace_perfil: enlacePerfil
      };
      const resultado = await notificarReservaCondicionada(env, payloadNotificacion);
      if (resultado.ok) resumen.notificaciones_condicionadas += 1;
      try {
        await crearNotificacionReservaCondicionada(env, payloadNotificacion);
      } catch (errorNotificacionInterna) {
        console.error("No se pudo crear la notificación interna de suspensión documental.", {
          admin_id: Number(adminIdNumerico || 0),
          centro_usuario_id: Number(solicitante.id || 0),
          error: errorNotificacionInterna?.message || String(errorNotificacionInterna || "")
        });
      }
    }

    if (reservasReactivadas.length) {
      const payloadNotificacion = {
        admin,
        responsable: resolucion.responsable,
        centro: {
          usuario_id: Number(solicitante.id || 0),
          centro: solicitante.centro || "",
          email: solicitante.email || ""
        },
        motivo_texto: motivoImpactoDocumentalTexto(motivo),
        reservas: reservasReactivadas,
        enlace_perfil: enlacePerfil
      };
      const resultado = await notificarReservaReactivada(env, payloadNotificacion);
      if (resultado.ok) resumen.notificaciones_reactivadas += 1;
      try {
        await crearNotificacionReservaReactivada(env, payloadNotificacion);
      } catch (errorNotificacionInterna) {
        console.error("No se pudo crear la notificación interna de reactivación documental.", {
          admin_id: Number(adminIdNumerico || 0),
          centro_usuario_id: Number(solicitante.id || 0),
          error: errorNotificacionInterna?.message || String(errorNotificacionInterna || "")
        });
      }
    }

    resumen.detalle.push({
      centro_usuario_id: Number(solicitante.id || 0),
      email: solicitante.email || "",
      reservas_afectadas: reservas.map((reserva) => ({
        id: Number(reserva.id || 0),
        codigo_reserva: reserva.codigo_reserva || "",
        estado_anterior: reserva.estado || "",
        estado_nuevo: reservasSuspendidas.some((item) => Number(item.id || 0) === Number(reserva.id || 0))
          ? "SUSPENDIDA"
          : reservasReactivadas.some((item) => Number(item.id || 0) === Number(reserva.id || 0))
            ? "CONFIRMADA"
            : (reserva.estado || "")
      })),
      estado_documental: estadoGlobal,
      pendientes,
      accion: reservasSuspendidas.length
        ? "SUSPENDIDA"
        : reservasReactivadas.length
          ? "REACTIVADA"
          : "SIN_CAMBIOS"
    });
  }

  return resumen;
}
