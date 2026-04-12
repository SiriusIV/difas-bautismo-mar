import { getUserSession } from "./_auth.js";
import {
  construirEmailHtmlDocumentacionRemitida,
  construirEmailTextoDocumentacionRemitida,
  enviarEmail,
  nombreVisibleAdmin
} from "../_email.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
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

async function obtenerUsuarioSolicitante(env, userId) {
  return await env.DB.prepare(`
    SELECT
      id,
      centro,
      email,
      rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first();
}

async function obtenerAdmin(env, adminId) {
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
      AND rol IN ('ADMIN', 'SUPERADMIN')
    LIMIT 1
  `).bind(adminId).first();
}

async function obtenerVersionRequerida(env, adminId) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(MAX(version_documental), 0) AS version_actual
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND activo = 1
  `).bind(adminId).first();

  return Number(row?.version_actual || 0);
}

async function obtenerDocumentosActivos(env, adminId) {
  const rows = await env.DB.prepare(`
    SELECT
      id,
      admin_id,
      nombre,
      descripcion,
      archivo_url,
      orden,
      version_documental
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND activo = 1
    ORDER BY orden ASC, id ASC
  `).bind(adminId).all();

  return rows?.results || [];
}

async function obtenerExpediente(env, centroUsuarioId, adminId) {
  return await env.DB.prepare(`
    SELECT
      id,
      centro_usuario_id,
      admin_id,
      version_requerida,
      version_aportada,
      estado,
      fecha_ultima_entrega,
      fecha_validacion,
      validado_por_admin_id,
      observaciones_admin,
      created_at,
      updated_at
    FROM centro_admin_documentacion
    WHERE centro_usuario_id = ?
      AND admin_id = ?
    LIMIT 1
  `).bind(centroUsuarioId, adminId).first();
}

async function obtenerArchivosActivos(env, documentacionId) {
  if (!documentacionId) return [];

  const rows = await env.DB.prepare(`
    SELECT
      id,
      documentacion_id,
      nombre_documento,
      archivo_url,
      version_documental,
      estado,
      fecha_validacion,
      validado_por_admin_id,
      observaciones_admin,
      fecha_subida,
      activo
    FROM centro_admin_documentacion_archivos
    WHERE documentacion_id = ?
      AND activo = 1
    ORDER BY id ASC
  `).bind(documentacionId).all();

  return rows?.results || [];
}

function calcularEstadoDocumento(doc, entrega) {
  if (!entrega) {
    return "NO_ENVIADO";
  }

  if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) {
    return "NO_ACTUALIZADO";
  }

  return normalizarEstadoDocumento(entrega.estado);
}

function calcularEstadoEfectivo(documentosActivos, archivosActivos) {
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

function construirResumenDocumentos(documentos, archivosActivos) {
  const archivosPorNombre = new Map(
    (archivosActivos || []).map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo])
  );

  return (documentos || []).map((doc) => {
    const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;
    const estadoDocumento = calcularEstadoDocumento(doc, entrega);

    return {
      id: doc.id,
      nombre: doc.nombre,
      descripcion: doc.descripcion || "",
      archivo_url: doc.archivo_url,
      orden: Number(doc.orden || 0),
      version_documental: Number(doc.version_documental || 0),
      estado_documento: estadoDocumento,
      entregado: !!entrega,
      entrega_archivo_id: Number(entrega?.id || 0),
      entrega_archivo_url: entrega?.archivo_url || "",
      entrega_fecha_subida: entrega?.fecha_subida || "",
      entrega_version_documental: Number(entrega?.version_documental || 0),
      entrega_estado: entrega ? normalizarEstadoDocumento(entrega?.estado) : "NO_ENVIADO",
      entrega_fecha_validacion: entrega?.fecha_validacion || "",
      entrega_observaciones_admin: entrega?.observaciones_admin || ""
    };
  });
}

function validarEntregas(entregas) {
  if (!Array.isArray(entregas) || entregas.length === 0) {
    return "Debes indicar la documentación a remitir.";
  }

  for (let i = 0; i < entregas.length; i++) {
    const item = entregas[i] || {};
    const documentoId = parsearIdPositivo(item.documento_id);
    const archivoUrl = limpiarTexto(item.archivo_url);

    if (!documentoId) {
      return `El documento ${i + 1} no es válido.`;
    }

    if (!archivoUrl) {
      return `Debes indicar el archivo remitido para el documento ${i + 1}.`;
    }
  }

  return null;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    if (!session?.id) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const usuario = await obtenerUsuarioSolicitante(env, session.id);
    if (!usuario || usuario.rol !== "SOLICITANTE") {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    const url = new URL(request.url);
    const adminId = parsearIdPositivo(url.searchParams.get("admin_id"));

    if (!adminId) {
      return json({ ok: false, error: "Debes indicar un administrador válido." }, 400);
    }

    const admin = await obtenerAdmin(env, adminId);
    if (!admin) {
      return json({ ok: false, error: "Administrador no encontrado." }, 404);
    }

    const versionRequerida = await obtenerVersionRequerida(env, adminId);
    const documentos = await obtenerDocumentosActivos(env, adminId);
    const expediente = await obtenerExpediente(env, usuario.id, adminId);
    const archivosActivos = await obtenerArchivosActivos(env, expediente?.id);
    const estadoEfectivo = calcularEstadoEfectivo(documentos, archivosActivos);
    const requiereDocumentacion = documentos.length > 0;

    return json({
      ok: true,
      admin: {
        id: admin.id,
        nombre: admin.nombre || "",
        nombre_publico: admin.nombre_publico || "",
        localidad: admin.localidad || "",
        email: admin.email || ""
      },
      centro: {
        id: usuario.id,
        centro: usuario.centro || "",
        email: usuario.email || ""
      },
      requiere_documentacion: requiereDocumentacion,
      al_dia: !requiereDocumentacion || estadoEfectivo === "VALIDADA",
      version_requerida: versionRequerida || 0,
      expediente: expediente ? {
        id: expediente.id,
        version_requerida: Number(expediente.version_requerida || 0),
        version_aportada: Number(expediente.version_aportada || 0),
        estado: expediente.estado || "",
        estado_efectivo: estadoEfectivo,
        fecha_ultima_entrega: expediente.fecha_ultima_entrega || "",
        fecha_validacion: expediente.fecha_validacion || "",
        observaciones_admin: expediente.observaciones_admin || ""
      } : null,
      documentos: construirResumenDocumentos(documentos, archivosActivos)
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al consultar la documentación del administrador.",
        detalle: error.message
      },
      500
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    if (!session?.id) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const usuario = await obtenerUsuarioSolicitante(env, session.id);
    if (!usuario || usuario.rol !== "SOLICITANTE") {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    const body = await request.json();
    const adminId = parsearIdPositivo(body?.admin_id);
    const errorEntregas = validarEntregas(body?.entregas);

    if (!adminId) {
      return json({ ok: false, error: "Debes indicar un administrador válido." }, 400);
    }

    if (errorEntregas) {
      return json({ ok: false, error: errorEntregas }, 400);
    }

    const admin = await obtenerAdmin(env, adminId);
    if (!admin) {
      return json({ ok: false, error: "Administrador no encontrado." }, 404);
    }

    const versionRequerida = await obtenerVersionRequerida(env, adminId);
    const documentos = await obtenerDocumentosActivos(env, adminId);

    if (!versionRequerida || documentos.length === 0) {
      return json(
        { ok: false, error: "Este administrador no tiene documentación común activa." },
        400
      );
    }

    const documentosPorId = new Map(documentos.map((doc) => [Number(doc.id), doc]));
    const entregas = body.entregas.map((item) => ({
      documento_id: parsearIdPositivo(item.documento_id),
      archivo_url: limpiarTexto(item.archivo_url)
    }));

    const idsEntregados = new Set();
    for (const entrega of entregas) {
      if (!documentosPorId.has(Number(entrega.documento_id))) {
        return json(
          { ok: false, error: "Se ha indicado un documento que no corresponde al administrador actual." },
          400
        );
      }

      if (idsEntregados.has(Number(entrega.documento_id))) {
        return json(
          { ok: false, error: "No debes repetir documentos en la misma remisión." },
          400
        );
      }

      idsEntregados.add(Number(entrega.documento_id));
    }

    if (idsEntregados.size !== documentos.length) {
      return json(
        { ok: false, error: "Debes remitir todos los documentos exigidos por el administrador." },
        400
      );
    }

    const versionAportada = documentos.reduce((max, doc) => Math.max(max, Number(doc.version_documental || 0)), 0);
    let expediente = await obtenerExpediente(env, usuario.id, adminId);

    if (!expediente) {
      const insert = await env.DB.prepare(`
        INSERT INTO centro_admin_documentacion (
          centro_usuario_id,
          admin_id,
          version_requerida,
          version_aportada,
          estado,
          fecha_ultima_entrega,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'EN_REVISION', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        usuario.id,
        adminId,
        versionRequerida,
        versionAportada
      ).run();

      expediente = await obtenerExpediente(env, usuario.id, adminId);

      if (!insert?.meta?.last_row_id || !expediente) {
        return json({ ok: false, error: "No se pudo crear el expediente documental." }, 500);
      }
    } else {
      await env.DB.prepare(`
        UPDATE centro_admin_documentacion
        SET
          version_requerida = ?,
          version_aportada = ?,
          estado = 'EN_REVISION',
          fecha_ultima_entrega = CURRENT_TIMESTAMP,
          fecha_validacion = NULL,
          validado_por_admin_id = NULL,
          observaciones_admin = NULL
        WHERE id = ?
      `).bind(
        versionRequerida,
        versionAportada,
        expediente.id
      ).run();

      expediente = await obtenerExpediente(env, usuario.id, adminId);
    }

    await env.DB.prepare(`
      UPDATE centro_admin_documentacion_archivos
      SET activo = 0
      WHERE documentacion_id = ?
    `).bind(expediente.id).run();

    const inserts = entregas.map((entrega) => {
      const doc = documentosPorId.get(Number(entrega.documento_id));

      return env.DB.prepare(`
        INSERT INTO centro_admin_documentacion_archivos (
          documentacion_id,
          nombre_documento,
          archivo_url,
          version_documental,
          estado,
          fecha_validacion,
          validado_por_admin_id,
          observaciones_admin,
          fecha_subida,
          activo
        )
        VALUES (?, ?, ?, ?, 'EN_REVISION', NULL, NULL, NULL, CURRENT_TIMESTAMP, 1)
      `).bind(
        expediente.id,
        doc.nombre,
        entrega.archivo_url,
        Number(doc.version_documental || 0)
      );
    });

    await env.DB.batch(inserts);

    const archivosActivos = await obtenerArchivosActivos(env, expediente.id);
    const estadoExpediente = calcularEstadoEfectivo(documentos, archivosActivos);

    await env.DB.prepare(`
      UPDATE centro_admin_documentacion
      SET
        estado = ?,
        fecha_validacion = CASE WHEN ? = 'VALIDADA' THEN CURRENT_TIMESTAMP ELSE NULL END,
        validado_por_admin_id = NULL,
        observaciones_admin = NULL
      WHERE id = ?
    `).bind(
      estadoExpediente,
      estadoExpediente,
      expediente.id
    ).run();

    const notificacionAdmin = await enviarEmail(env, {
      to: admin.email || "",
      subject: `[Documentación] Remisión pendiente de revisión - ${usuario.centro || "Centro"}`,
      text: construirEmailTextoDocumentacionRemitida({
        admin,
        centro: usuario,
        versionRequerida
      }),
      html: construirEmailHtmlDocumentacionRemitida({
        admin,
        centro: usuario,
        versionRequerida
      })
    });

    if (!notificacionAdmin.ok && !notificacionAdmin.skipped) {
      console.error("No se pudo enviar el correo al administrador tras la remisión documental.", {
        admin_id: admin.id,
        admin_nombre: nombreVisibleAdmin(admin),
        centro_usuario_id: usuario.id,
        error: notificacionAdmin.error || ""
      });
    }

    return json({
      ok: true,
      mensaje: "Documentación remitida correctamente. Queda pendiente de revisión por el administrador.",
      documentacion: {
        id: expediente.id,
        admin_id: adminId,
        version_requerida: versionRequerida,
        version_aportada: versionAportada,
        estado: estadoExpediente,
        fecha_ultima_entrega: expediente?.fecha_ultima_entrega || "",
        archivos: archivosActivos
      },
      notificacion_admin: {
        enviada: !!notificacionAdmin.ok,
        omitida: !!notificacionAdmin.skipped,
        error: notificacionAdmin.ok ? "" : (notificacionAdmin.error || "")
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al remitir la documentación al administrador.",
        detalle: error.message
      },
      500
    );
  }
}
