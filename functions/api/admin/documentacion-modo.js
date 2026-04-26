import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import {
  construirEmailHtmlCambioMarcoDocumental,
  construirEmailTextoCambioMarcoDocumental,
  enviarEmail,
  nombreVisibleAdmin
} from "../_email.js";
import { recalcularImpactoDocumentalReservas } from "../_impacto_documental_reservas.js";
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

async function obtenerSecretaria(env, secretariaUsuarioId) {
  return await env.DB.prepare(`
    SELECT
      id,
      nombre,
      nombre_publico,
      localidad,
      email,
      rol
    FROM usuarios
    WHERE id = ?
      AND rol = 'SECRETARIA'
    LIMIT 1
  `).bind(secretariaUsuarioId).first();
}

async function obtenerDocumentosActivosDeUsuario(env, usuarioId) {
  const rows = await env.DB.prepare(`
    SELECT
      id,
      nombre,
      descripcion,
      archivo_url,
      orden,
      activo,
      version_documental,
      fecha_actualizacion
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND activo = 1
    ORDER BY orden ASC, id ASC
  `).bind(usuarioId).all();

  return rows?.results || [];
}

async function obtenerExpedientesAfectados(env, adminId) {
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
      u.email
    FROM centro_admin_documentacion cad
    INNER JOIN usuarios u
      ON u.id = cad.centro_usuario_id
    WHERE cad.admin_id = ?
    ORDER BY cad.id ASC
  `).bind(adminId).all();

  return rows?.results || [];
}

async function obtenerArchivosActivosPorExpediente(env, documentacionId) {
  const rows = await env.DB.prepare(`
    SELECT
      id,
      archivo_url
    FROM centro_admin_documentacion_archivos
    WHERE documentacion_id = ?
      AND activo = 1
    ORDER BY id ASC
  `).bind(documentacionId).all();

  return rows?.results || [];
}

async function desactivarArchivosActivosExpediente(env, documentacionId) {
  const archivosActivos = await obtenerArchivosActivosPorExpediente(env, documentacionId);
  if (!archivosActivos.length) return archivosActivos;

  const sentencias = archivosActivos.map((archivo) => env.DB.prepare(`
    UPDATE centro_admin_documentacion_archivos
    SET activo = 0
    WHERE id = ?
  `).bind(archivo.id));

  await env.DB.batch(sentencias);
  return archivosActivos;
}

async function recalcularExpedientesPorCambioDeMarco(env, adminId, documentosNuevoMarco) {
  const expedientes = await obtenerExpedientesAfectados(env, adminId);
  const afectadosConRemision = [];
  const versionNueva = (documentosNuevoMarco || []).reduce(
    (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
    0
  );

  for (const expediente of expedientes) {
    const archivosActivos = await desactivarArchivosActivosExpediente(env, expediente.id);
    if (archivosActivos.length > 0) {
      afectadosConRemision.push({
        ...expediente,
        archivos_activos: archivosActivos
      });
    }

    await env.DB.prepare(`
      UPDATE centro_admin_documentacion
      SET
        version_requerida = ?,
        version_aportada = 0,
        estado = ?,
        fecha_ultima_entrega = NULL,
        fecha_validacion = NULL,
        validado_por_admin_id = NULL,
        observaciones_admin = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      versionNueva,
      (documentosNuevoMarco || []).length > 0 ? "NO_INICIADO" : "NO_REQUERIDA",
      expediente.id
    ).run();
  }

  return {
    expedientes,
    afectadosConRemision,
    versionNueva
  };
}

async function notificarAfectadosCambioMarco(env, admin, secretaria, afectados, totalDocumentos) {
  const notificaciones = [];

  for (const afectado of afectados || []) {
    const tieneReservas = await env.DB.prepare(`
      SELECT r.id
      FROM reservas r
      INNER JOIN actividades a ON a.id = r.actividad_id
      WHERE a.admin_id = ?
        AND r.usuario_id = ?
        AND r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
      LIMIT 1
    `).bind(admin?.id || 0, Number(afectado.centro_usuario_id || 0)).first();

    if (tieneReservas?.id) {
      notificaciones.push({
        centro_usuario_id: Number(afectado.centro_usuario_id || 0),
        email: afectado.email || "",
        enviada: false,
        omitida: true,
        error: "",
        motivo: "GESTIONADA_POR_NOTIFICACION_DE_RESERVA"
      });
      continue;
    }

    const payload = {
      admin,
      secretaria,
      centro: {
        centro: afectado.centro || "",
        email: afectado.email || ""
      },
      totalDocumentos
    };

    const resultado = await enviarEmail(env, {
      to: afectado.email || "",
      subject: `[Documentación] Nuevo marco documental para ${nombreVisibleAdmin(admin)}`,
      text: construirEmailTextoCambioMarcoDocumental(payload),
      html: construirEmailHtmlCambioMarcoDocumental(payload)
    });

    notificaciones.push({
      centro_usuario_id: Number(afectado.centro_usuario_id || 0),
      email: afectado.email || "",
      enviada: !!resultado.ok,
      omitida: !!resultado.skipped,
      error: resultado.ok ? "" : (resultado.error || "")
    });
  }

  return notificaciones;
}

async function eliminarDocumentosBasePropiosAdmin(env, adminId) {
  await env.DB.prepare(`
    DELETE FROM admin_documentos_comunes
    WHERE admin_id = ?
  `).bind(adminId).run();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const baseUrl = new URL(request.url).origin;
    const adminId = await resolverAdminObjetivo(env, session, body?.admin_id);
    const secretariaUsuarioId = parsearIdPositivo(body?.secretaria_usuario_id);
    const accion = String(body?.accion || "").trim().toLowerCase();

    if (!["adscribir_secretaria", "activar_autogestion"].includes(accion)) {
      return json({ ok: false, error: "La acción solicitada no es válida." }, 400);
    }

    const resolucionActual = await resolverResponsableDocumental(env, adminId);
    if (!resolucionActual?.admin) {
      return json({ ok: false, error: "Administrador no encontrado." }, 404);
    }

    const admin = resolucionActual.admin;

    if (accion === "adscribir_secretaria") {
      if (!secretariaUsuarioId) {
        return json({ ok: false, error: "Debes indicar una secretaría válida." }, 400);
      }

      if (String(resolucionActual.modo || "").toUpperCase() !== "AUTOGESTION") {
        return json(
          { ok: false, error: "Solo puede adscribirse a una secretaría un administrador que esté actualmente en autogestión." },
          400
        );
      }

      const secretaria = await obtenerSecretaria(env, secretariaUsuarioId);
      if (!secretaria) {
        return json({ ok: false, error: "La secretaría indicada no existe o no es válida." }, 404);
      }

      if (Number(secretaria.id || 0) === Number(adminId || 0)) {
        return json({ ok: false, error: "La secretaría indicada no puede coincidir con el propio administrador." }, 400);
      }

      const documentosSecretaria = await obtenerDocumentosActivosDeUsuario(env, secretariaUsuarioId);
      const recalculo = await recalcularExpedientesPorCambioDeMarco(env, adminId, documentosSecretaria);

      await env.DB.prepare(`
        UPDATE usuarios
        SET
          modulo_secretaria = 0,
          secretaria_usuario_id = ?
        WHERE id = ?
      `).bind(secretariaUsuarioId, adminId).run();

      await eliminarDocumentosBasePropiosAdmin(env, adminId);

      const notificaciones = await notificarAfectadosCambioMarco(
        env,
        admin,
        secretaria,
        recalculo.afectadosConRemision,
        documentosSecretaria.length
      );
      const impactoReservas = await recalcularImpactoDocumentalReservas(env, {
        adminId,
        baseUrl,
        motivo: "cambio_responsable"
      });

      return json({
        ok: true,
        mensaje: "El administrador ha pasado a depender de la secretaría indicada y se ha actualizado el marco documental de los usuarios afectados.",
        admin_id: adminId,
        secretaria_usuario_id: secretariaUsuarioId,
        documentos_nuevo_marco: documentosSecretaria.length,
        expedientes_actualizados: recalculo.expedientes.length,
        usuarios_notificados: notificaciones.filter((item) => item.enviada).length,
        notificaciones,
        impacto_reservas: impactoReservas
      });
    }

    if (String(resolucionActual.modo || "").toUpperCase() !== "SECRETARIA_EXTERNA") {
      return json(
        { ok: false, error: "Solo puede activarse la autogestión cuando el administrador está actualmente adscrito a una secretaría." },
        400
      );
    }

    const recalculo = await recalcularExpedientesPorCambioDeMarco(env, adminId, []);

    await env.DB.prepare(`
      UPDATE usuarios
      SET
        modulo_secretaria = 1,
        secretaria_usuario_id = NULL
      WHERE id = ?
    `).bind(adminId).run();

    const secretariaActual = resolucionActual.responsable || null;
    const notificaciones = await notificarAfectadosCambioMarco(
      env,
      admin,
      secretariaActual,
      recalculo.afectadosConRemision,
      0
    );
    const impactoReservas = await recalcularImpactoDocumentalReservas(env, {
      adminId,
      baseUrl,
      motivo: "cambio_responsable"
    });

    return json({
      ok: true,
      mensaje: "El administrador ha pasado a autogestión y se ha reiniciado su marco documental para los usuarios afectados.",
      admin_id: adminId,
      secretaria_usuario_id: null,
      documentos_nuevo_marco: 0,
      expedientes_actualizados: recalculo.expedientes.length,
      usuarios_notificados: notificaciones.filter((item) => item.enviada).length,
      notificaciones,
      impacto_reservas: impactoReservas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo cambiar el modo documental del administrador.",
        detalle: error.message
      },
      500
    );
  }
}
