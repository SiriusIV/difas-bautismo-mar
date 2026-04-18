import { getUserSession } from "./_auth.js";
import {
  construirEmailHtmlDocumentacionRemitidaAgrupada,
  construirEmailTextoDocumentacionRemitidaAgrupada,
  enviarEmail,
  nombreVisibleAdmin
} from "../_email.js";
import { crearNotificacion } from "../_notificaciones.js";
import { resolverResponsableDocumental } from "../_documentacion_responsable.js";

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

function indexarArchivosActivosPorDocumento(archivos = []) {
  const porNombre = new Map();
  const duplicados = [];

  for (const archivo of Array.isArray(archivos) ? archivos : []) {
    const nombre = limpiarTexto(archivo?.nombre_documento);
    if (!nombre) continue;

    const existente = porNombre.get(nombre);
    if (!existente) {
      porNombre.set(nombre, archivo);
      continue;
    }

    if (Number(archivo?.id || 0) > Number(existente?.id || 0)) {
      duplicados.push(existente);
      porNombre.set(nombre, archivo);
    } else {
      duplicados.push(archivo);
    }
  }

  return {
    porNombre,
    vigentes: Array.from(porNombre.values()),
    duplicados
  };
}

function extraerKeyDesdeArchivoUrl(archivoUrl) {
  const texto = limpiarTexto(archivoUrl);
  if (!texto) return null;

  try {
    const base = texto.startsWith("http://") || texto.startsWith("https://")
      ? texto
      : `https://local${texto.startsWith("/") ? "" : "/"}${texto}`;
    const url = new URL(base);
    const key = limpiarTexto(url.searchParams.get("key"));
    return key || null;
  } catch {
    return null;
  }
}

async function borrarArchivoBucketSiExiste(env, archivoUrl) {
  const key = extraerKeyDesdeArchivoUrl(archivoUrl);
  if (!key || !env.DOCS_BUCKET) return false;
  await env.DOCS_BUCKET.delete(key);
  return true;
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
  const resolucion = await resolverResponsableDocumental(env, adminId);
  return resolucion?.admin || null;
}

async function obtenerPropietarioDocumentalId(env, adminId) {
  const resolucion = await resolverResponsableDocumental(env, adminId);
  if (!resolucion) return null;

  if (String(resolucion.modo || "").toUpperCase() === "SECRETARIA_EXTERNA") {
    return Number(resolucion.responsable?.id || 0) || null;
  }

  return Number(resolucion.admin?.id || 0) || null;
}

async function obtenerVersionRequerida(env, adminId) {
  const propietarioDocumentalId = await obtenerPropietarioDocumentalId(env, adminId);
  if (!propietarioDocumentalId) return 0;

  const row = await env.DB.prepare(`
    SELECT COALESCE(MAX(version_documental), 0) AS version_actual
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND activo = 1
  `).bind(propietarioDocumentalId).first();

  return Number(row?.version_actual || 0);
}

async function obtenerDocumentosActivos(env, adminId) {
  const propietarioDocumentalId = await obtenerPropietarioDocumentalId(env, adminId);
  if (!propietarioDocumentalId) return [];

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
  `).bind(propietarioDocumentalId).all();

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
  if (!Array.isArray(entregas)) {
    return "Debes indicar la documentación a guardar.";
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

function construirEntregasDesdeOperaciones(documentos, archivosExistentes, operaciones) {
  const docsPorId = new Map((documentos || []).map((doc) => [Number(doc.id), doc]));
  const archivosPorNombre = indexarArchivosActivosPorDocumento(archivosExistentes || []).porNombre;
  const operacionesPorId = new Map();

  (operaciones || []).forEach((item) => {
    const documentoId = parsearIdPositivo(item?.documento_id);
    if (!documentoId) return;
    operacionesPorId.set(documentoId, {
      accion: limpiarTexto(item?.accion).toLowerCase(),
      archivo_url: limpiarTexto(item?.archivo_url)
    });
  });

  const entregas = [];
  for (const doc of documentos) {
    const op = operacionesPorId.get(Number(doc.id));
    const existente = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;

    if (op?.accion === "eliminar") {
      continue;
    }

    if (op?.accion === "subir") {
      if (op.archivo_url) {
        entregas.push({ documento_id: doc.id, archivo_url: op.archivo_url });
      }
      continue;
    }

    if (existente?.archivo_url) {
      entregas.push({ documento_id: doc.id, archivo_url: existente.archivo_url });
    }
  }

  return entregas;
}

function resumirCambiosParaCorreo(documentos, archivosFinales, cambiosIds = []) {
  const archivosPorNombre = new Map(
    (archivosFinales || []).map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo])
  );
  const ids = new Set((cambiosIds || []).map((id) => Number(id)));

  return (documentos || [])
    .filter((doc) => ids.has(Number(doc.id)))
    .map((doc) => {
      const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;
      return {
        nombre: doc.nombre,
        estado: calcularEstadoDocumento(doc, entrega)
      };
    });
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

    const body = await request.json().catch(() => null);
    const adminId = parsearIdPositivo(body?.admin_id);

    if (!adminId) {
      return json({ ok: false, error: "Debes indicar un administrador válido." }, 400);
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

    let expediente = await obtenerExpediente(env, usuario.id, adminId);
    const archivosExistentes = await obtenerArchivosActivos(env, expediente?.id);
    const indiceArchivosExistentes = indexarArchivosActivosPorDocumento(archivosExistentes);
    const docsPorId = new Map(documentos.map((doc) => [Number(doc.id), doc]));
    const archivosPorNombre = indiceArchivosExistentes.porNombre;

    let entregas = [];
    let cambiosIds = [];

    if (Array.isArray(body?.operaciones)) {
      const operaciones = body.operaciones || [];
      entregas = construirEntregasDesdeOperaciones(documentos, archivosExistentes, operaciones);
      cambiosIds = operaciones
        .map((item) => parsearIdPositivo(item?.documento_id))
        .filter((id) => Number.isInteger(id) && id > 0);
    } else {
      const errorEntregas = validarEntregas(body?.entregas);
      if (errorEntregas) {
        return json({ ok: false, error: errorEntregas }, 400);
      }
      entregas = (body.entregas || []).map((item) => ({
        documento_id: parsearIdPositivo(item.documento_id),
        archivo_url: limpiarTexto(item.archivo_url)
      }));
      cambiosIds = entregas.map((item) => Number(item.documento_id));
    }

    const idsEntregados = new Set();
    for (const entrega of entregas) {
      if (!docsPorId.has(Number(entrega.documento_id))) {
        return json(
          { ok: false, error: "Se ha indicado un documento que no corresponde al administrador actual." },
          400
        );
      }

      if (idsEntregados.has(Number(entrega.documento_id))) {
        return json(
          { ok: false, error: "No debes repetir documentos en la misma operación." },
          400
        );
      }

      idsEntregados.add(Number(entrega.documento_id));
    }

    const entregasDeseadasPorDocumento = new Map(entregas.map((item) => [Number(item.documento_id), item]));
    const aDesactivar = [];
    const idsADesactivar = new Set();
    const aInsertar = [];
    const cambiosRealesIds = new Set();

    for (const duplicado of indiceArchivosExistentes.duplicados) {
      const duplicadoId = Number(duplicado?.id || 0);
      if (!(duplicadoId > 0) || idsADesactivar.has(duplicadoId)) continue;
      aDesactivar.push(duplicado);
      idsADesactivar.add(duplicadoId);
    }

    for (const doc of documentos) {
      const existente = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;
      const deseada = entregasDeseadasPorDocumento.get(Number(doc.id)) || null;

      if (!existente && !deseada) {
        continue;
      }

      if (!existente && deseada) {
        aInsertar.push({
          documento: doc,
          archivo_url: deseada.archivo_url
        });
        cambiosRealesIds.add(Number(doc.id));
        continue;
      }

      if (existente && !deseada) {
        const existenteId = Number(existente.id || 0);
        if (existenteId > 0 && !idsADesactivar.has(existenteId)) {
          aDesactivar.push(existente);
          idsADesactivar.add(existenteId);
        }
        cambiosRealesIds.add(Number(doc.id));
        continue;
      }

      if (existente && deseada) {
        if (limpiarTexto(existente.archivo_url) !== limpiarTexto(deseada.archivo_url)) {
          const existenteId = Number(existente.id || 0);
          if (existenteId > 0 && !idsADesactivar.has(existenteId)) {
            aDesactivar.push(existente);
            idsADesactivar.add(existenteId);
          }
          aInsertar.push({
            documento: doc,
            archivo_url: deseada.archivo_url
          });
          cambiosRealesIds.add(Number(doc.id));
        }
      }
    }

    const necesitaExpediente = !!expediente || entregas.length > 0 || aDesactivar.length > 0 || aInsertar.length > 0;

    if (!expediente && necesitaExpediente) {
      await env.DB.prepare(`
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
        VALUES (?, ?, ?, 0, 'NO_INICIADO', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        usuario.id,
        adminId,
        versionRequerida
      ).run();

      expediente = await obtenerExpediente(env, usuario.id, adminId);
    }

    if (expediente) {
      for (const archivo of aDesactivar) {
        await env.DB.prepare(`
          UPDATE centro_admin_documentacion_archivos
          SET activo = 0
          WHERE id = ?
        `).bind(archivo.id).run();
      }

      for (const item of aInsertar) {
        await env.DB.prepare(`
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
          item.documento.nombre,
          item.archivo_url,
          Number(item.documento.version_documental || 0)
        ).run();
      }

    }

    const archivosFinales = expediente ? await obtenerArchivosActivos(env, expediente.id) : [];
    const urlsActivasFinales = new Set(
      archivosFinales
        .map((archivo) => limpiarTexto(archivo.archivo_url))
        .filter(Boolean)
    );
    for (const archivo of aDesactivar) {
      const archivoUrl = limpiarTexto(archivo?.archivo_url);
      if (!archivoUrl || urlsActivasFinales.has(archivoUrl)) continue;
      await borrarArchivoBucketSiExiste(env, archivoUrl);
    }
    const estadoExpediente = calcularEstadoEfectivo(documentos, archivosFinales);
    const versionAportada = archivosFinales.reduce((max, archivo) => Math.max(max, Number(archivo.version_documental || 0)), 0);

    if (expediente) {
      await env.DB.prepare(`
        UPDATE centro_admin_documentacion
        SET
          version_requerida = ?,
          version_aportada = ?,
          estado = ?,
          fecha_ultima_entrega = CASE WHEN ? > 0 THEN CURRENT_TIMESTAMP ELSE fecha_ultima_entrega END,
          fecha_validacion = CASE WHEN ? = 'VALIDADA' THEN COALESCE(fecha_validacion, CURRENT_TIMESTAMP) ELSE NULL END,
          validado_por_admin_id = CASE WHEN ? = 'VALIDADA' THEN validado_por_admin_id ELSE NULL END,
          observaciones_admin = CASE WHEN ? = 'VALIDADA' THEN observaciones_admin ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        versionRequerida,
        versionAportada,
        estadoExpediente,
        cambiosRealesIds.size,
        estadoExpediente,
        estadoExpediente,
        estadoExpediente,
        expediente.id
      ).run();

      expediente = await obtenerExpediente(env, usuario.id, adminId);
    }

    const cambiosCorreo = resumirCambiosParaCorreo(documentos, archivosFinales, Array.from(cambiosRealesIds));
    let notificacionAdmin = { ok: false, skipped: true, error: "", destinatario: "" };
    let notificacionInternaResponsable = { ok: false, skipped: true, error: "" };

    if (cambiosCorreo.length > 0) {
      const responsableDocumental = await resolverResponsableDocumental(env, adminId);
      const destinatarioResponsable = responsableDocumental?.responsable?.email || admin.email || "";
      const payloadEmail = {
        admin,
        centro: usuario,
        versionRequerida,
        cambios: cambiosCorreo
      };

      try {
      notificacionAdmin = await enviarEmail(env, {
        to: destinatarioResponsable,
        subject: `[Documentación] Cambios guardados - ${usuario.centro || "Centro"}`,
        text: construirEmailTextoDocumentacionRemitidaAgrupada(payloadEmail),
        html: construirEmailHtmlDocumentacionRemitidaAgrupada(payloadEmail)
      });
      notificacionAdmin.destinatario = destinatarioResponsable;

      if (Number(responsableDocumental?.responsable?.id || 0) > 0) {
        notificacionInternaResponsable = await crearNotificacion(env, {
          usuarioId: Number(responsableDocumental.responsable.id || 0),
          rolDestino: responsableDocumental?.responsable?.rol || "",
          tipo: "DOCUMENTACION",
          titulo: "Nueva documentación remitida",
          mensaje: `${usuario.centro || "Un usuario"} ha remitido documentación para revisión en ${nombreVisibleAdmin(admin)}.`,
          urlDestino: "/usuario-perfil.html"
        });
      }

      if (!notificacionAdmin.ok && !notificacionAdmin.skipped) {
        console.error("No se pudo enviar el correo al responsable documental tras guardar cambios documentales.", {
          admin_id: admin.id,
          admin_nombre: nombreVisibleAdmin(admin),
          responsable_documental_id: responsableDocumental?.responsable?.id || null,
          responsable_documental_email: destinatarioResponsable,
          modo_responsable_documental: responsableDocumental?.modo || "",
          centro_usuario_id: usuario.id,
          error: notificacionAdmin.error || ""
        });
      }
      } catch (errorNotificacionResponsable) {
        console.error("No se pudo notificar al responsable documental tras guardar cambios documentales.", {
          admin_id: admin.id,
          centro_usuario_id: usuario.id,
          responsable_documental_id: responsableDocumental?.responsable?.id || null,
          error: errorNotificacionResponsable?.message || String(errorNotificacionResponsable || "")
        });
      }
    }

    return json({
      ok: true,
      mensaje: cambiosRealesIds.size > 0
        ? "Cambios documentales guardados correctamente."
        : "No había cambios pendientes para guardar.",
      documentacion: {
        id: expediente?.id || null,
        admin_id: adminId,
        version_requerida: versionRequerida,
        version_aportada: versionAportada,
        estado: estadoExpediente,
        fecha_ultima_entrega: expediente?.fecha_ultima_entrega || "",
        archivos: archivosFinales
      },
      cambios_documentales: cambiosCorreo,
      notificacion_admin: {
        enviada: !!notificacionAdmin.ok,
        omitida: !!notificacionAdmin.skipped,
        error: notificacionAdmin.ok ? "" : (notificacionAdmin.error || ""),
        destinatario: notificacionAdmin.destinatario || ""
      },
      notificacion_interna_responsable: {
        creada: !!notificacionInternaResponsable.ok,
        error: notificacionInternaResponsable.ok ? "" : (notificacionInternaResponsable.error || "")
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al guardar la documentación del administrador.",
        detalle: error.message
      },
      500
    );
  }
}
