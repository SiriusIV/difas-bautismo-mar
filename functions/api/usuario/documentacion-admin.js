import { getUserSession } from "./_auth.js";
import {
  construirEmailHtmlDocumentacionRemitidaAgrupada,
  construirEmailTextoDocumentacionRemitidaAgrupada,
  enviarEmail,
  nombreVisibleAdmin
} from "../_email.js";
import { crearNotificacion } from "../_notificaciones.js";
import { resolverResponsableDocumental } from "../_documentacion_responsable.js";
import {
  obtenerCatalogoDocumentosActivosAdmin,
  leerConfiguracionDocumentalActividad,
  resolverDocumentosExigiblesActividad
} from "../_actividad_documentacion.js";
import { obtenerCatalogoDocumentalVinculadoAdmin } from "../_documentacion_propietarios.js";
import { recalcularImpactoDocumentalReservas } from "../_impacto_documental_reservas.js";

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

function parsearFechaComparable(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return null;
  const fecha = new Date(texto.replace(" ", "T"));
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizarEstadoDocumento(estado) {
  const valor = String(estado || "").trim().toUpperCase();
  return valor || "EN_REVISION";
}

function obtenerPropietarioDocumentalDocumento(doc) {
  return Number(doc?.propietario_id || doc?.admin_id || 0);
}

function claveEntregaDocumento(nombre, propietarioId = 0) {
  const nombreNormalizado = limpiarTexto(nombre);
  const propietario = Number(propietarioId || 0);
  return propietario > 0
    ? `${propietario}::${nombreNormalizado}`
    : nombreNormalizado;
}

function obtenerEntregaDocumento(doc, indiceArchivos) {
  const nombre = limpiarTexto(doc?.nombre);
  if (!nombre || !indiceArchivos?.porNombre) return null;
  const propietarioId = obtenerPropietarioDocumentalDocumento(doc);
  return indiceArchivos.porNombre.get(claveEntregaDocumento(nombre, propietarioId)) ||
    indiceArchivos.porNombre.get(nombre) ||
    null;
}

function indexarArchivosActivosPorDocumento(archivos = []) {
  const porNombre = new Map();
  const duplicados = [];

  for (const archivo of Array.isArray(archivos) ? archivos : []) {
    const nombre = limpiarTexto(archivo?.nombre_documento);
    if (!nombre) continue;
    const key = claveEntregaDocumento(nombre, archivo?.propietario_documental_id || archivo?.admin_id || 0);

    const existente = porNombre.get(key);
    if (!existente) {
      porNombre.set(key, archivo);
      if (!porNombre.has(nombre)) {
        porNombre.set(nombre, archivo);
      }
      continue;
    }

    if (Number(archivo?.id || 0) > Number(existente?.id || 0)) {
      duplicados.push(existente);
      porNombre.set(key, archivo);
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

async function obtenerUsuarioPorId(env, usuarioId) {
  const id = parsearIdPositivo(usuarioId);
  if (!id) return null;

  return await env.DB.prepare(`
    SELECT
      id,
      nombre,
      nombre_publico,
      email,
      localidad,
      rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(id).first();
}

async function obtenerActividadMinima(env, actividadId) {
  const id = parsearIdPositivo(actividadId);
  if (!id) return null;

  return await env.DB.prepare(`
    SELECT
      id,
      admin_id,
      COALESCE(titulo_publico, nombre, 'Actividad') AS nombre_publico
    FROM actividades
    WHERE id = ?
    LIMIT 1
  `).bind(id).first();
}

async function obtenerActividadesAdmin(env, adminId) {
  const id = parsearIdPositivo(adminId);
  if (!id) return [];

  const rows = await env.DB.prepare(`
    SELECT
      id,
      admin_id,
      COALESCE(titulo_publico, nombre, 'Actividad') AS nombre_publico
    FROM actividades
    WHERE admin_id = ?
      AND COALESCE(activa, 1) = 1
      AND COALESCE(visible_portal, 1) = 1
    ORDER BY COALESCE(titulo_publico, nombre, 'Actividad') COLLATE NOCASE ASC, id ASC
  `).bind(id).all();

  return (rows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    nombre_publico: limpiarTexto(row.nombre_publico) || "Actividad"
  })).filter((row) => row.id > 0);
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
      version_documental,
      fecha_actualizacion
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND activo = 1
    ORDER BY orden ASC, id ASC
  `).bind(propietarioDocumentalId).all();

  return (rows?.results || []).map((row) => ({
    ...row,
    propietario_id: Number(row.admin_id || 0),
    propietario_rol: "",
    propietario_nombre: ""
  }));
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

async function obtenerContextoDocumental(env, adminId, actividadId = null) {
  const actividad = actividadId ? await obtenerActividadMinima(env, actividadId) : null;
  if (actividadId && !actividad) {
    return { error: "Actividad no encontrada." };
  }
  if (actividad && Number(actividad.admin_id || 0) !== Number(adminId)) {
    return { error: "La actividad no corresponde al administrador indicado." };
  }

  const catalogoLegacy = await obtenerCatalogoDocumentosActivosAdmin(env, adminId);
  const documentosBase = actividadId
    ? await obtenerCatalogoDocumentalVinculadoAdmin(env, adminId, catalogoLegacy)
    : await obtenerDocumentosActivos(env, adminId);
  const configuracionActividad = actividadId
    ? await leerConfiguracionDocumentalActividad(env, actividadId)
    : null;
  const documentos = actividadId
    ? resolverDocumentosExigiblesActividad(documentosBase, configuracionActividad)
    : documentosBase;

  return {
    actividad,
    configuracionActividad,
    documentosBase,
    documentos
  };
}

function obtenerPropietariosDocumentalesDocumentos(documentos = []) {
  return Array.from(new Set(
    (Array.isArray(documentos) ? documentos : [])
      .map((doc) => obtenerPropietarioDocumentalDocumento(doc))
      .filter((id) => id > 0)
  ));
}

function agruparDocumentosPorPropietario(documentos = []) {
  const mapa = new Map();
  for (const doc of Array.isArray(documentos) ? documentos : []) {
    const propietarioId = obtenerPropietarioDocumentalDocumento(doc);
    if (!(propietarioId > 0)) continue;
    if (!mapa.has(propietarioId)) {
      mapa.set(propietarioId, []);
    }
    mapa.get(propietarioId).push(doc);
  }
  return mapa;
}

async function obtenerExpedientesPorPropietario(env, centroUsuarioId, propietarios = []) {
  const ids = obtenerPropietariosDocumentalesDocumentos(
    propietarios.map((id) => ({ propietario_id: id }))
  );
  const mapa = new Map();
  if (!ids.length) return mapa;

  const placeholders = ids.map(() => "?").join(", ");
  const rows = await env.DB.prepare(`
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
      AND admin_id IN (${placeholders})
  `).bind(centroUsuarioId, ...ids).all();

  for (const row of rows?.results || []) {
    mapa.set(Number(row.admin_id || 0), row);
  }
  return mapa;
}

async function obtenerArchivosActivosPorExpedientes(env, expedientesPorPropietario = new Map()) {
  const expedientes = Array.from(expedientesPorPropietario.values())
    .filter((expediente) => Number(expediente?.id || 0) > 0);
  const mapaExpedienteAPropietario = new Map(
    expedientes.map((expediente) => [Number(expediente.id || 0), Number(expediente.admin_id || 0)])
  );
  const salida = [];
  if (!expedientes.length) return salida;

  const placeholders = expedientes.map(() => "?").join(", ");
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
    WHERE documentacion_id IN (${placeholders})
      AND activo = 1
    ORDER BY id ASC
  `).bind(...expedientes.map((expediente) => expediente.id)).all();

  for (const row of rows?.results || []) {
    salida.push({
      ...row,
      propietario_documental_id: mapaExpedienteAPropietario.get(Number(row.documentacion_id || 0)) || 0
    });
  }
  return salida;
}

async function asegurarExpedienteDocumental(env, centroUsuarioId, propietarioId, versionRequerida) {
  const existente = await obtenerExpediente(env, centroUsuarioId, propietarioId);
  if (existente) return existente;

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
    centroUsuarioId,
    propietarioId,
    versionRequerida
  ).run();

  return await obtenerExpediente(env, centroUsuarioId, propietarioId);
}

function calcularEstadoDocumento(doc, entrega) {
  if (!entrega) {
    return "NO_ENVIADO";
  }

  if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) {
    return "NO_ACTUALIZADO";
  }

  const fechaMarco = parsearFechaComparable(doc.fecha_actualizacion);
  const fechaEntrega = parsearFechaComparable(entrega.fecha_subida);
  if (fechaMarco && fechaEntrega && fechaEntrega < fechaMarco) {
    return "NO_ACTUALIZADO";
  }

  return normalizarEstadoDocumento(entrega.estado);
}

function calcularEstadoEfectivo(documentosActivos, archivosActivos) {
  if (!Array.isArray(documentosActivos) || documentosActivos.length === 0) {
    return "NO_REQUERIDA";
  }

  const indiceArchivos = indexarArchivosActivosPorDocumento(archivosActivos || []);

  const estados = documentosActivos.map((doc) => {
    const entrega = obtenerEntregaDocumento(doc, indiceArchivos);
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
  const indiceArchivos = indexarArchivosActivosPorDocumento(archivosActivos || []);

  return (documentos || []).map((doc) => {
    const entrega = obtenerEntregaDocumento(doc, indiceArchivos);
    const estadoDocumento = calcularEstadoDocumento(doc, entrega);
    const propietarioId = obtenerPropietarioDocumentalDocumento(doc);

    return {
      id: doc.id,
      nombre: doc.nombre,
      descripcion: doc.descripcion || "",
      archivo_url: doc.archivo_url,
      orden: Number(doc.orden || 0),
      version_documental: Number(doc.version_documental || 0),
      propietario_id: propietarioId,
      propietario_rol: limpiarTexto(doc.propietario_rol),
      propietario_nombre: limpiarTexto(doc.propietario_nombre),
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

function construirActividadesPorDocumento(documentosBase = [], actividades = [], configuraciones = new Map()) {
  const mapa = new Map();

  for (const doc of Array.isArray(documentosBase) ? documentosBase : []) {
    const key = limpiarTexto(doc?.nombre).toUpperCase();
    if (!key) continue;
    mapa.set(key, []);
  }

  for (const actividad of Array.isArray(actividades) ? actividades : []) {
    const actividadId = Number(actividad?.id || 0);
    if (!(actividadId > 0)) continue;
    const configuracion = configuraciones.get(actividadId) || null;
    const exigidos = resolverDocumentosExigiblesActividad(documentosBase, configuracion);
    for (const doc of exigidos) {
      const key = limpiarTexto(doc?.nombre).toUpperCase();
      if (!key) continue;
      if (!mapa.has(key)) {
        mapa.set(key, []);
      }
      mapa.get(key).push({
        id: actividadId,
        nombre: limpiarTexto(actividad?.nombre_publico) || "Actividad"
      });
    }
  }

  for (const [key, lista] of mapa.entries()) {
    const unicos = [];
    const vistos = new Set();
    for (const item of lista) {
      const id = Number(item?.id || 0);
      if (!(id > 0) || vistos.has(id)) continue;
      vistos.add(id);
      unicos.push(item);
    }
    mapa.set(key, unicos);
  }

  return mapa;
}

function enriquecerResumenDocumentosConActividades(documentosResumen = [], actividadesPorDocumento = new Map()) {
  return (documentosResumen || []).map((doc) => {
    const key = limpiarTexto(doc?.nombre).toUpperCase();
    return {
      ...doc,
      actividades_relacionadas: (actividadesPorDocumento.get(key) || []).map((actividad) => ({
        id: Number(actividad.id || 0),
        nombre: actividad.nombre || "Actividad"
      }))
    };
  });
}

function construirDocumentosPendientes(documentos, archivosActivos) {
  return construirResumenDocumentos(documentos, archivosActivos)
    .filter((doc) => String(doc.estado_documento || "").toUpperCase() !== "VALIDADO")
    .map((doc) => doc.nombre)
    .filter(Boolean);
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
  const indiceArchivos = indexarArchivosActivosPorDocumento(archivosExistentes || []);
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
    const existente = obtenerEntregaDocumento(doc, indiceArchivos);

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

function construirArchivosSimuladosDesdeEntregas(documentos, entregas, archivosExistentes = []) {
  const entregasPorId = new Map((entregas || []).map((item) => [Number(item.documento_id || 0), item]));
  const indiceExistentes = indexarArchivosActivosPorDocumento(archivosExistentes || []);
  const ahora = new Date().toISOString().replace("T", " ").slice(0, 19);

  return (documentos || [])
    .map((doc) => {
      const entrega = entregasPorId.get(Number(doc.id || 0));
      if (!entrega?.archivo_url) return null;
      const existente = obtenerEntregaDocumento(doc, indiceExistentes);
      if (existente && limpiarTexto(existente.archivo_url) === limpiarTexto(entrega.archivo_url)) {
        return existente;
      }
      return {
        nombre_documento: doc.nombre,
        propietario_documental_id: obtenerPropietarioDocumentalDocumento(doc),
        archivo_url: entrega.archivo_url,
        version_documental: Number(doc.version_documental || 0),
        estado: "EN_REVISION",
        fecha_subida: ahora
      };
    })
    .filter(Boolean);
}

function documentacionCompletaParaReserva(documentosActividad, archivosSimulados) {
  return calcularEstadoEfectivo(documentosActividad, archivosSimulados) === "VALIDADA";
}

function estaEnPlazoCriticoDocumental(reserva = {}) {
  const fecha = parsearFechaComparable(reserva?.inicio_reserva);
  if (!fecha) return false;
  const limite = new Date(fecha.getTime() - 24 * 60 * 60 * 1000);
  return limite.getTime() <= Date.now();
}

async function obtenerReservasCriticasAfectadasPorEntregas(env, adminId, usuarioId, documentosBase, archivosSimulados) {
  const rows = await env.DB.prepare(`
    SELECT
      r.id,
      r.codigo_reserva,
      r.actividad_id,
      r.estado,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      COALESCE(
        CASE
          WHEN f.fecha IS NOT NULL AND f.hora_inicio IS NOT NULL
            THEN f.fecha || ' ' || f.hora_inicio
          ELSE NULL
        END,
        CASE
          WHEN a.fecha_inicio IS NOT NULL
            THEN a.fecha_inicio || ' 00:00:00'
          ELSE NULL
        END
      ) AS inicio_reserva
    FROM reservas r
    INNER JOIN actividades a ON a.id = r.actividad_id
    LEFT JOIN franjas f ON f.id = r.franja_id
    WHERE a.admin_id = ?
      AND r.usuario_id = ?
      AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
  `).bind(adminId, usuarioId).all();

  const reservas = rows?.results || [];
  if (!reservas.length) return [];

  const actividadIds = Array.from(new Set(reservas.map((reserva) => Number(reserva.actividad_id || 0)).filter(Boolean)));
  const configuraciones = new Map();
  for (const actividadId of actividadIds) {
    configuraciones.set(actividadId, await leerConfiguracionDocumentalActividad(env, actividadId));
  }

  return reservas.filter((reserva) => {
    if (!estaEnPlazoCriticoDocumental(reserva)) return false;
    const documentosActividad = resolverDocumentosExigiblesActividad(
      documentosBase,
      configuraciones.get(Number(reserva.actividad_id || 0)) || null
    );
    return !documentacionCompletaParaReserva(documentosActividad, archivosSimulados);
  });
}

function resumirCambiosParaCorreo(documentos, archivosFinales, cambiosIds = []) {
  const indiceArchivos = indexarArchivosActivosPorDocumento(archivosFinales || []);
  const ids = new Set((cambiosIds || []).map((id) => Number(id)));

  return (documentos || [])
    .filter((doc) => ids.has(Number(doc.id)))
    .map((doc) => {
      const entrega = obtenerEntregaDocumento(doc, indiceArchivos);
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
    const actividadId = parsearIdPositivo(url.searchParams.get("actividad_id"));

    if (!adminId) {
      return json({ ok: false, error: "Debes indicar un administrador válido." }, 400);
    }

    const admin = await obtenerAdmin(env, adminId);
    if (!admin) {
      return json({ ok: false, error: "Administrador no encontrado." }, 404);
    }

    const contextoDocumental = await obtenerContextoDocumental(env, adminId, actividadId);
    if (contextoDocumental.error) {
      return json({ ok: false, error: contextoDocumental.error }, contextoDocumental.error.includes("no corresponde") ? 400 : 404);
    }
    const actividad = contextoDocumental.actividad;
    const configuracionActividad = contextoDocumental.configuracionActividad;
    const documentosBase = contextoDocumental.documentosBase;
    const documentos = contextoDocumental.documentos;
    const actividadesAdmin = await obtenerActividadesAdmin(env, adminId);
    const configuracionesActividades = actividadesAdmin.length
      ? await Promise.all(
          actividadesAdmin.map(async (actividadItem) => [
            Number(actividadItem.id || 0),
            await leerConfiguracionDocumentalActividad(env, Number(actividadItem.id || 0))
          ])
        ).then((pares) => new Map(pares))
      : new Map();
    const actividadesPorDocumento = construirActividadesPorDocumento(
      documentosBase,
      actividadesAdmin,
      configuracionesActividades
    );
    const versionRequerida = documentos.reduce(
      (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
      0
    );
    const propietariosDocumentales = obtenerPropietariosDocumentalesDocumentos(documentos);
    const expedientesPorPropietario = await obtenerExpedientesPorPropietario(env, usuario.id, propietariosDocumentales);
    const expediente = expedientesPorPropietario.get(adminId) ||
      Array.from(expedientesPorPropietario.values())[0] ||
      null;
    const archivosActivos = await obtenerArchivosActivosPorExpedientes(env, expedientesPorPropietario);
    const estadoEfectivo = calcularEstadoEfectivo(documentos, archivosActivos);
    const requiereDocumentacion = documentos.length > 0;
    const documentosPendientes = construirDocumentosPendientes(documentos, archivosActivos);

    return json({
      ok: true,
      admin: {
        id: admin.id,
        nombre: admin.nombre || "",
        nombre_publico: admin.nombre_publico || "",
        localidad: admin.localidad || "",
        email: admin.email || ""
      },
      actividad: actividad ? {
        id: Number(actividad.id || 0),
        nombre: actividad.nombre_publico || ""
      } : null,
      centro: {
        id: usuario.id,
        centro: usuario.centro || "",
        email: usuario.email || ""
      },
      requiere_documentacion: requiereDocumentacion,
      al_dia: !requiereDocumentacion || estadoEfectivo === "VALIDADA",
      estado_efectivo: estadoEfectivo,
      version_requerida: versionRequerida || 0,
      documentos_pendientes: documentosPendientes,
      documentacion_actividad: actividadId ? {
        modo: configuracionActividad?.modo || "HEREDADA"
      } : null,
      expediente: expediente ? {
        id: expediente.id,
        version_requerida: Number(versionRequerida || expediente.version_requerida || 0),
        version_aportada: Number(expediente.version_aportada || 0),
        estado: expediente.estado || "",
        estado_efectivo: estadoEfectivo,
        fecha_ultima_entrega: expediente.fecha_ultima_entrega || "",
        fecha_validacion: expediente.fecha_validacion || "",
        observaciones_admin: expediente.observaciones_admin || ""
      } : null,
      documentos: enriquecerResumenDocumentosConActividades(
        construirResumenDocumentos(documentos, archivosActivos),
        actividadesPorDocumento
      )
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
    const actividadId = parsearIdPositivo(body?.actividad_id);

    if (!adminId) {
      return json({ ok: false, error: "Debes indicar un administrador válido." }, 400);
    }

    const admin = await obtenerAdmin(env, adminId);
    if (!admin) {
      return json({ ok: false, error: "Administrador no encontrado." }, 404);
    }

    const contextoDocumental = await obtenerContextoDocumental(env, adminId, actividadId);
    if (contextoDocumental.error) {
      return json({ ok: false, error: contextoDocumental.error }, contextoDocumental.error.includes("no corresponde") ? 400 : 404);
    }
    const documentos = contextoDocumental.documentos;
    const versionRequerida = documentos.reduce(
      (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
      0
    );

    if (!versionRequerida || documentos.length === 0) {
      return json(
        { ok: false, error: "No hay documentación activa exigible para este trámite." },
        400
      );
    }

    const propietariosDocumentales = obtenerPropietariosDocumentalesDocumentos(documentos);
    let expedientesPorPropietario = await obtenerExpedientesPorPropietario(env, usuario.id, propietariosDocumentales);
    const archivosExistentes = await obtenerArchivosActivosPorExpedientes(env, expedientesPorPropietario);
    const indiceArchivosExistentes = indexarArchivosActivosPorDocumento(archivosExistentes);
    const docsPorId = new Map(documentos.map((doc) => [Number(doc.id), doc]));

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
      const existente = obtenerEntregaDocumento(doc, indiceArchivosExistentes);
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

    if (cambiosRealesIds.size > 0 && body?.confirmar_eliminacion_documental_critica !== true) {
      const archivosSimulados = construirArchivosSimuladosDesdeEntregas(documentos, entregas, archivosExistentes);
      const reservasCriticas = await obtenerReservasCriticasAfectadasPorEntregas(
        env,
        adminId,
        Number(usuario.id || 0),
        documentos,
        archivosSimulados
      );

      if (reservasCriticas.length > 0) {
        return json({
          ok: false,
          requiere_confirmacion_eliminacion_documental_critica: true,
          total_reservas_afectadas: reservasCriticas.length,
          reservas_afectadas: reservasCriticas.map((reserva) => ({
            id: Number(reserva.id || 0),
            codigo_reserva: reserva.codigo_reserva || "",
            actividad_nombre: reserva.actividad_nombre || "Actividad",
            inicio_reserva: reserva.inicio_reserva || ""
          })),
          mensaje: reservasCriticas.length === 1
            ? "La modificación documental dejará sin documentación obligatoria una solicitud dentro del plazo crítico previo al inicio. Si continúas, esa solicitud será eliminada del sistema."
            : `La modificación documental dejará sin documentación obligatoria ${reservasCriticas.length} solicitudes dentro del plazo crítico previo al inicio. Si continúas, esas solicitudes serán eliminadas del sistema.`
        }, 409);
      }
    }

    const propietariosConCambios = new Set();
    for (const archivo of aDesactivar) {
      const propietarioId = Number(archivo?.propietario_documental_id || archivo?.admin_id || 0);
      if (propietarioId > 0) propietariosConCambios.add(propietarioId);
    }
    for (const item of aInsertar) {
      const propietarioId = obtenerPropietarioDocumentalDocumento(item.documento);
      if (propietarioId > 0) propietariosConCambios.add(propietarioId);
    }

    for (const propietarioId of propietariosConCambios) {
      const documentosPropietario = documentos.filter((doc) => obtenerPropietarioDocumentalDocumento(doc) === propietarioId);
      const versionRequeridaPropietario = documentosPropietario.reduce(
        (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
        0
      );
      const expedientePropietario = await asegurarExpedienteDocumental(
        env,
        usuario.id,
        propietarioId,
        versionRequeridaPropietario || versionRequerida
      );
      expedientesPorPropietario.set(propietarioId, expedientePropietario);
    }

    for (const archivo of aDesactivar) {
      await env.DB.prepare(`
        UPDATE centro_admin_documentacion_archivos
        SET activo = 0
        WHERE id = ?
      `).bind(archivo.id).run();
    }

    for (const item of aInsertar) {
      const propietarioId = obtenerPropietarioDocumentalDocumento(item.documento);
      const expedientePropietario = expedientesPorPropietario.get(propietarioId) || null;
      if (!expedientePropietario) continue;

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
        expedientePropietario.id,
        item.documento.nombre,
        item.archivo_url,
        Number(item.documento.version_documental || 0)
      ).run();
    }

    expedientesPorPropietario = await obtenerExpedientesPorPropietario(env, usuario.id, propietariosDocumentales);
    const archivosFinales = await obtenerArchivosActivosPorExpedientes(env, expedientesPorPropietario);
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

    for (const propietarioId of propietariosDocumentales) {
      const expedientePropietario = expedientesPorPropietario.get(propietarioId) || null;
      if (!expedientePropietario) continue;
      const documentosPropietario = documentos.filter((doc) => obtenerPropietarioDocumentalDocumento(doc) === propietarioId);
      const archivosPropietario = archivosFinales.filter((archivo) =>
        Number(archivo?.propietario_documental_id || 0) === propietarioId
      );
      const estadoPropietario = calcularEstadoEfectivo(documentosPropietario, archivosPropietario);
      const versionRequeridaPropietario = documentosPropietario.reduce(
        (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
        0
      );
      const versionAportadaPropietario = archivosPropietario.reduce(
        (max, archivo) => Math.max(max, Number(archivo.version_documental || 0)),
        0
      );
      const cambiosPropietario = documentosPropietario.some((doc) => cambiosRealesIds.has(Number(doc.id || 0))) ? 1 : 0;

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
        versionRequeridaPropietario,
        versionAportadaPropietario,
        estadoPropietario,
        cambiosPropietario,
        estadoPropietario,
        estadoPropietario,
        estadoPropietario,
        expedientePropietario.id
      ).run();
    }

    expedientesPorPropietario = await obtenerExpedientesPorPropietario(env, usuario.id, propietariosDocumentales);
    const expediente = expedientesPorPropietario.get(adminId) ||
      Array.from(expedientesPorPropietario.values())[0] ||
      null;

    const cambiosCorreo = resumirCambiosParaCorreo(documentos, archivosFinales, Array.from(cambiosRealesIds));
    let notificacionAdmin = { ok: false, skipped: true, error: "", destinatario: "" };
    let notificacionInternaResponsable = { ok: false, skipped: true, error: "" };

    if (cambiosCorreo.length > 0) {
      const documentosCambiados = documentos.filter((doc) => cambiosRealesIds.has(Number(doc.id || 0)));
      const documentosPorPropietario = agruparDocumentosPorPropietario(documentosCambiados);

      for (const [propietarioId, documentosPropietario] of documentosPorPropietario.entries()) {
        const propietario = await obtenerUsuarioPorId(env, propietarioId);
        const cambiosPropietario = resumirCambiosParaCorreo(
          documentosPropietario,
          archivosFinales,
          documentosPropietario.map((doc) => Number(doc.id || 0))
        );
        if (!propietario?.email || !cambiosPropietario.length) continue;

        const payloadEmail = {
          admin: propietario,
          centro: usuario,
          versionRequerida: documentosPropietario.reduce(
            (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
            0
          ),
          cambios: cambiosPropietario
        };

        try {
          const resultadoCorreo = await enviarEmail(env, {
            to: propietario.email,
            subject: `[Documentaci?n] Cambios guardados - ${usuario.centro || "Centro"}`,
            text: construirEmailTextoDocumentacionRemitidaAgrupada(payloadEmail),
            html: construirEmailHtmlDocumentacionRemitidaAgrupada(payloadEmail),
            dedupe: true,
            dedupeSegundos: 900
          });

          if (!notificacionAdmin.ok && !notificacionAdmin.destinatario) {
            notificacionAdmin = {
              ...resultadoCorreo,
              destinatario: propietario.email
            };
          }

          const resultadoNotificacion = await crearNotificacion(env, {
            usuarioId: propietarioId,
            rolDestino: propietario.rol || "",
            tipo: "DOCUMENTACION",
            titulo: "Nueva documentaci?n remitida",
            mensaje: `${usuario.centro || "Un usuario"} ha remitido documentaci?n para revisi?n en ${nombreVisibleAdmin(propietario)}.`,
            urlDestino: `/usuario-perfil.html?admin_id=${encodeURIComponent(String(propietarioId))}&tab=bandeja`,
            dedupeSegundos: 900
          });

          if (!notificacionInternaResponsable.ok) {
            notificacionInternaResponsable = resultadoNotificacion;
          }

          if (!resultadoCorreo.ok && !resultadoCorreo.skipped) {
            console.error("No se pudo enviar el correo al propietario documental tras guardar cambios documentales.", {
              organizador_id: admin.id,
              propietario_documental_id: propietarioId,
              propietario_documental_email: propietario.email,
              centro_usuario_id: usuario.id,
              error: resultadoCorreo.error || ""
            });
          }
        } catch (errorNotificacionResponsable) {
          console.error("No se pudo notificar al propietario documental tras guardar cambios documentales.", {
            organizador_id: admin.id,
            propietario_documental_id: propietarioId,
            centro_usuario_id: usuario.id,
            error: errorNotificacionResponsable?.message || String(errorNotificacionResponsable || "")
          });
        }
      }
    }

    let impactoReservas = {
      ok: true,
      skipped: true,
      motivo: "Sin cambios documentales reales del solicitante."
    };
    if (cambiosRealesIds.size > 0) {
      try {
        impactoReservas = await recalcularImpactoDocumentalReservas(env, {
          adminId,
          baseUrl: new URL(request.url).origin,
          motivo: "documentacion_solicitante_actualizada"
        });
      } catch (errorImpacto) {
        impactoReservas = {
          ok: false,
          error: errorImpacto?.message || String(errorImpacto || "")
        };
        console.error("No se pudo recalcular impacto documental de reservas tras cambios del solicitante.", {
          admin_id: Number(adminId || 0),
          centro_usuario_id: Number(usuario.id || 0),
          documentacion_id: Number(expediente?.id || 0),
          error: impactoReservas.error
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
      },
      impacto_reservas: impactoReservas
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
