import { getUserSession } from "./_auth.js";
import { recalcularImpactoDocumentalReservas } from "../_impacto_documental_reservas.js";
import { enviarEmail, nombreVisibleAdmin } from "../_email.js";
import { crearNotificacion } from "../_notificaciones.js";

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

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizarEstadoDocumento(estado) {
  const valor = limpiarTexto(estado).toUpperCase();
  return valor || "EN_REVISION";
}

function extraerKeyDesdeArchivoUrl(archivoUrl) {
  const texto = String(archivoUrl || "").trim();
  if (!texto) return null;

  try {
    const base = texto.startsWith("http://") || texto.startsWith("https://")
      ? texto
      : `https://local${texto.startsWith("/") ? "" : "/"}${texto}`;
    const url = new URL(base);
    const key = String(url.searchParams.get("key") || "").trim();
    return key || null;
  } catch {
    return null;
  }
}

async function obtenerUsuarioSolicitante(env, userId) {
  return await env.DB.prepare(`
    SELECT id, centro, email, rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first();
}

async function obtenerArchivoPorDocumento(env, centroUsuarioId, documentoId) {
  return await env.DB.prepare(`
    SELECT
      a.id,
      a.documentacion_id,
      a.nombre_documento,
      a.archivo_url,
      d.admin_id,
      c.id AS documento_base_id
    FROM centro_admin_documentacion_archivos a
    INNER JOIN centro_admin_documentacion d ON d.id = a.documentacion_id
    INNER JOIN admin_documentos_comunes c
      ON c.admin_id = d.admin_id
     AND c.nombre = a.nombre_documento
     AND c.id = ?
    WHERE d.centro_usuario_id = ?
      AND a.activo = 1
    LIMIT 1
  `).bind(documentoId, centroUsuarioId).first();
}

async function obtenerArchivoPorId(env, centroUsuarioId, archivoId) {
  return await env.DB.prepare(`
    SELECT
      a.id,
      a.documentacion_id,
      a.nombre_documento,
      a.archivo_url,
      d.admin_id,
      c.id AS documento_base_id
    FROM centro_admin_documentacion_archivos a
    INNER JOIN centro_admin_documentacion d ON d.id = a.documentacion_id
    LEFT JOIN admin_documentos_comunes c
      ON c.admin_id = d.admin_id
     AND c.nombre = a.nombre_documento
    WHERE a.id = ?
      AND d.centro_usuario_id = ?
    LIMIT 1
  `).bind(archivoId, centroUsuarioId).first();
}

async function obtenerPropietarioDocumental(env, propietarioId) {
  const id = Number(propietarioId || 0);
  if (!(id > 0)) return null;

  return await env.DB.prepare(`
    SELECT id, nombre, nombre_publico, email, rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(id).first();
}

async function obtenerDocumentosBaseActivos(env, propietarioId) {
  const rows = await env.DB.prepare(`
    SELECT nombre, version_documental
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND COALESCE(activo, 1) = 1
    ORDER BY orden ASC, id ASC
  `).bind(propietarioId).all();

  return rows?.results || [];
}

async function obtenerArchivosActivos(env, documentacionId) {
  const rows = await env.DB.prepare(`
    SELECT id, nombre_documento, version_documental, estado, fecha_subida
    FROM centro_admin_documentacion_archivos
    WHERE documentacion_id = ?
      AND activo = 1
    ORDER BY id ASC
  `).bind(documentacionId).all();

  const porNombre = new Map();
  for (const archivo of rows?.results || []) {
    const nombre = limpiarTexto(archivo?.nombre_documento);
    if (!nombre) continue;
    const existente = porNombre.get(nombre);
    if (!existente || Number(archivo?.id || 0) > Number(existente?.id || 0)) {
      porNombre.set(nombre, archivo);
    }
  }
  return Array.from(porNombre.values());
}

function calcularEstadoExpediente(documentosBaseActivos = [], archivosActivos = []) {
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
    return normalizarEstadoDocumento(entrega.estado);
  });

  if (estados.every((estado) => estado === "NO_ENVIADO")) return "NO_INICIADO";
  if (estados.some((estado) => estado === "RECHAZADO")) return "RECHAZADA";
  if (estados.some((estado) => estado === "NO_ACTUALIZADO")) return "NO_ACTUALIZADO";
  if (estados.some((estado) => estado === "NO_ENVIADO")) return "NO_COMPLETADO";
  if (estados.every((estado) => estado === "VALIDADO")) return "VALIDADA";
  return "EN_REVISION";
}

async function actualizarEstadoExpediente(env, documentacionId, propietarioId) {
  const documentosBase = await obtenerDocumentosBaseActivos(env, propietarioId);
  const archivosActivos = await obtenerArchivosActivos(env, documentacionId);
  const estado = calcularEstadoExpediente(documentosBase, archivosActivos);
  const versionRequerida = documentosBase.reduce((max, doc) =>
    Math.max(max, Number(doc.version_documental || 0)), 0);
  const versionAportada = archivosActivos.reduce((max, archivo) =>
    Math.max(max, Number(archivo.version_documental || 0)), 0);

  await env.DB.prepare(`
    UPDATE centro_admin_documentacion
    SET
      version_requerida = ?,
      version_aportada = ?,
      estado = ?,
      fecha_validacion = CASE WHEN ? = 'VALIDADA' THEN fecha_validacion ELSE NULL END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    versionRequerida,
    versionAportada,
    estado,
    estado,
    documentacionId
  ).run();

  return estado;
}

function construirCorreoDocumentoEliminado({ propietario, usuario, archivo, estadoExpediente }) {
  const propietarioNombre = nombreVisibleAdmin(propietario || {});
  const centro = limpiarTexto(usuario?.centro || usuario?.email || "Solicitante");
  const documento = limpiarTexto(archivo?.nombre_documento || "Documento");
  const asunto = `[Documentación] Documento eliminado por ${centro}`;
  const texto = [
    `El solicitante ${centro} ha eliminado un documento remitido.`,
    "",
    `Documento: ${documento}`,
    `Propietario documental: ${propietarioNombre}`,
    `Nuevo estado del expediente: ${estadoExpediente || "-"}`,
    "",
    "Accede a la bandeja de entrada documental para consultar el detalle actualizado."
  ].join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.45;">
      <p>El solicitante <strong>${escaparHtml(centro)}</strong> ha eliminado un documento remitido.</p>
      <table style="border-collapse:collapse;margin:12px 0;width:100%;max-width:640px;">
        <tr><td style="padding:6px 8px;border:1px solid #d7e0ea;font-weight:700;">Documento</td><td style="padding:6px 8px;border:1px solid #d7e0ea;">${escaparHtml(documento)}</td></tr>
        <tr><td style="padding:6px 8px;border:1px solid #d7e0ea;font-weight:700;">Propietario documental</td><td style="padding:6px 8px;border:1px solid #d7e0ea;">${escaparHtml(propietarioNombre)}</td></tr>
        <tr><td style="padding:6px 8px;border:1px solid #d7e0ea;font-weight:700;">Nuevo estado</td><td style="padding:6px 8px;border:1px solid #d7e0ea;">${escaparHtml(estadoExpediente || "-")}</td></tr>
      </table>
      <p>Accede a la bandeja de entrada documental para consultar el detalle actualizado.</p>
    </div>`;

  return { asunto, texto, html };
}

async function notificarPropietarioDocumentoEliminado(env, { propietario, usuario, archivo, estadoExpediente }) {
  const propietarioId = Number(propietario?.id || 0);
  if (!(propietarioId > 0)) {
    return {
      correo: { ok: false, skipped: true, error: "Sin propietario documental." },
      notificacion: { ok: false, skipped: true, error: "Sin propietario documental." }
    };
  }

  const rolDestino = String(propietario?.rol || "").toUpperCase() === "SECRETARIA" ? "SECRETARIA" : "ADMIN";
  const documento = limpiarTexto(archivo?.nombre_documento || "Documento");
  const centro = limpiarTexto(usuario?.centro || usuario?.email || "Solicitante");
  const urlDestino = rolDestino === "SECRETARIA"
    ? "/usuario-perfil.html?tab=bandeja"
    : `/usuario-perfil.html?admin_id=${encodeURIComponent(String(propietarioId))}&tab=bandeja`;

  let notificacion = { ok: false, skipped: true, error: "" };
  try {
    notificacion = await crearNotificacion(env, {
      usuarioId: propietarioId,
      rolDestino,
      tipo: "DOCUMENTACION",
      titulo: "Documento eliminado por el solicitante",
      mensaje: `${centro} ha eliminado el documento ${documento}. El expediente documental queda actualizado.`,
      urlDestino
    });
  } catch (errorNotificacion) {
    notificacion = {
      ok: false,
      skipped: true,
      error: errorNotificacion?.message || String(errorNotificacion || "")
    };
  }

  const destinatario = limpiarTexto(propietario?.email || "");
  if (!destinatario) {
    return {
      notificacion,
      correo: { ok: false, skipped: true, error: "El propietario documental no tiene correo." }
    };
  }

  const correo = construirCorreoDocumentoEliminado({ propietario, usuario, archivo, estadoExpediente });
  const envio = await enviarEmail(env, {
    to: destinatario,
    subject: correo.asunto,
    text: correo.texto,
    html: correo.html
  });

  return { notificacion, correo: envio };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    if (!session?.id) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    if (!env.DOCS_BUCKET) {
      return json(
        {
          ok: false,
          error: "Falta configurar el binding DOCS_BUCKET en Cloudflare Pages."
        },
        500
      );
    }

    const usuario = await obtenerUsuarioSolicitante(env, session.id);
    if (!usuario || usuario.rol !== "SOLICITANTE") {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    const body = await request.json().catch(() => null);
    const documentoId = parsearIdPositivo(body?.documento_id);
    const archivoId = parsearIdPositivo(body?.archivo_id);

    if (!documentoId && !archivoId) {
      return json({ ok: false, error: "Debes indicar un documento válido." }, 400);
    }

    const archivo = archivoId
      ? await obtenerArchivoPorId(env, usuario.id, archivoId)
      : await obtenerArchivoPorDocumento(env, usuario.id, documentoId);
    if (!archivo) {
      return json({ ok: false, error: "No se encontró un documento remitido para eliminar." }, 404);
    }

    const key = extraerKeyDesdeArchivoUrl(archivo.archivo_url);
    if (key) {
      await env.DOCS_BUCKET.delete(key);
    }

    await env.DB.prepare(`
      DELETE FROM centro_admin_documentacion_archivos
      WHERE id = ?
    `).bind(archivo.id).run();

    const adminId = Number(archivo.admin_id || 0);
    const propietario = await obtenerPropietarioDocumental(env, adminId);
    const estadoExpediente = adminId > 0
      ? await actualizarEstadoExpediente(env, archivo.documentacion_id, adminId)
      : "";
    const avisoPropietario = await notificarPropietarioDocumentoEliminado(env, {
      propietario,
      usuario,
      archivo,
      estadoExpediente
    });

    let impactoReservas = {
      ok: true,
      skipped: true,
      motivo: "Documento eliminado sin administrador asociado."
    };
    if (adminId > 0) {
      try {
        impactoReservas = await recalcularImpactoDocumentalReservas(env, {
          adminId,
          baseUrl: new URL(request.url).origin,
          motivo: "documentacion_solicitante_eliminada"
        });
      } catch (errorImpacto) {
        impactoReservas = {
          ok: false,
          error: errorImpacto?.message || String(errorImpacto || "")
        };
        console.error("No se pudo recalcular impacto documental de reservas tras eliminar documento del solicitante.", {
          admin_id: adminId,
          centro_usuario_id: Number(usuario.id || 0),
          documentacion_id: Number(archivo.documentacion_id || 0),
          archivo_id: Number(archivo.id || 0),
          error: impactoReservas.error
        });
      }
    }

    return json({
      ok: true,
      mensaje: "Documento remitido eliminado correctamente.",
      documento_id: documentoId || null,
      archivo_id: archivo.id,
      archivo_eliminado: Boolean(key),
      estado_expediente: estadoExpediente,
      aviso_propietario: {
        notificacion_creada: !!avisoPropietario?.notificacion?.ok,
        correo_enviado: !!avisoPropietario?.correo?.ok,
        correo_omitido: !!avisoPropietario?.correo?.skipped,
        error: avisoPropietario?.notificacion?.error || avisoPropietario?.correo?.error || ""
      },
      impacto_reservas: impactoReservas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo eliminar el documento remitido.",
        detalle: error?.message || String(error)
      },
      500
    );
  }
}
