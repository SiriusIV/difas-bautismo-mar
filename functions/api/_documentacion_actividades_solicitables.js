import {
  obtenerCatalogoDocumentosActivosAdmin,
  obtenerConfiguracionDocumentalPorActividades,
  resolverDocumentosExigiblesActividad
} from "./_actividad_documentacion.js";
import {
  asegurarColumnasContextoDocumental,
  construirCondicionContextoDocumental,
  normalizarContextoDocumental
} from "./_documentacion_contextual.js";
import { obtenerCatalogoDocumentalVinculadoAdmin } from "./_documentacion_propietarios.js";

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarClaveDocumento(valor) {
  return limpiarTexto(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function normalizarEstadoDocumento(estado) {
  const valor = String(estado || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (valor === "VALIDADA" || valor === "APROBADA" || valor === "APROBADO") return "VALIDADO";
  if (valor === "EN REVISION") return "EN_REVISION";
  return valor || "EN_REVISION";
}

function calcularEstadoDocumento(doc, entrega) {
  if (!entrega) return "NO_ENVIADO";
  if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) return "NO_ACTUALIZADO";
  return normalizarEstadoDocumento(entrega.estado);
}

function documentoCumple(doc, entrega) {
  return calcularEstadoDocumento(doc, entrega) === "VALIDADO";
}

function esActividadConReserva(row = {}) {
  return Number(row.requiere_reserva || 0) === 1;
}

function mapNombreAdmin(row = {}) {
  return limpiarTexto(row.admin_nombre_publico || row.admin_nombre || "Organizador");
}

function resultadoVacio() {
  return {
    total_activas: 0,
    solicitables_total: 0,
    bloqueadas_total: 0,
    puede_todas: false,
    solicitables: [],
    bloqueadas: []
  };
}

function obtenerPropietarioDocumento(doc = {}, fallback = 0) {
  return Number(doc?.propietario_id || doc?.admin_id || fallback || 0);
}

async function construirArchivosPorPropietario(env, expedientes = []) {
  const archivosPorPropietario = new Map();
  for (const exp of expedientes) {
    const propietarioId = Number(exp.admin_id || 0);
    if (!(propietarioId > 0)) continue;
    const rows = await env.DB.prepare(`
      SELECT nombre_documento, version_documental, estado
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
    `).bind(exp.id).all();
    archivosPorPropietario.set(
      propietarioId,
      new Map((rows?.results || []).map((item) => [normalizarClaveDocumento(item.nombre_documento), item]))
    );
  }
  return archivosPorPropietario;
}

function documentosCumplidosPorPropietario(documentos = [], archivosPorPropietario = new Map(), fallbackPropietario = 0) {
  return (documentos || []).every((doc) => {
    const propietarioId = obtenerPropietarioDocumento(doc, fallbackPropietario);
    const archivosMap = archivosPorPropietario.get(propietarioId) || new Map();
    const entrega = archivosMap.get(normalizarClaveDocumento(doc.nombre)) || null;
    return documentoCumple(doc, entrega);
  });
}

export async function construirResumenActividadesSolicitables(env, {
  adminId,
  documentacionId
} = {}) {
  const admin = Number(adminId || 0);
  const docId = Number(documentacionId || 0);
  if (!(admin > 0) || !(docId > 0)) {
    return resultadoVacio();
  }

  await asegurarColumnasContextoDocumental(env);

  const expediente = await env.DB.prepare(`
    SELECT admin_id, centro_usuario_id, actividad_id, reserva_id
    FROM centro_admin_documentacion
    WHERE id = ?
    LIMIT 1
  `).bind(docId).first();
  const actividadContexto = Number(expediente?.actividad_id || 0);
  const contextoExpediente = normalizarContextoDocumental({
    actividadId: expediente?.actividad_id || null,
    reservaId: expediente?.reserva_id || null
  });
  const condicionContexto = construirCondicionContextoDocumental(contextoExpediente, "cad");

  const [catalogo, actividadesRows, archivosRows] = await Promise.all([
    obtenerCatalogoDocumentalVinculadoAdmin(
      env,
      admin,
      await obtenerCatalogoDocumentosActivosAdmin(env, admin)
    ),
    env.DB.prepare(`
      SELECT
        id,
        COALESCE(NULLIF(TRIM(titulo_publico), ''), NULLIF(TRIM(nombre), ''), 'Actividad') AS nombre,
        COALESCE(requiere_reserva, 0) AS requiere_reserva,
        COALESCE(usa_franjas, 0) AS usa_franjas,
        COALESCE(aforo_limitado, 0) AS aforo_limitado
      FROM actividades
      WHERE admin_id = ?
        AND activa = 1
        ${actividadContexto > 0 ? "AND id = ?" : ""}
        AND (
          fecha_fin IS NULL
          OR date(fecha_fin) >= date('now')
        )
      ORDER BY id DESC
    `).bind(...(actividadContexto > 0 ? [admin, actividadContexto] : [admin])).all(),
    env.DB.prepare(`
      SELECT nombre_documento, version_documental, estado
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
    `).bind(docId).all()
  ]);

  const actividades = (actividadesRows?.results || [])
    .map((row) => ({
      id: Number(row.id || 0),
      nombre: limpiarTexto(row.nombre || "Actividad"),
      requiere_reserva: Number(row.requiere_reserva || 0),
      usa_franjas: Number(row.usa_franjas || 0),
      aforo_limitado: Number(row.aforo_limitado || 0)
    }))
    .filter((row) => row.id > 0)
    .filter((row) => esActividadConReserva(row));

  if (!actividades.length) {
    return resultadoVacio();
  }

  const configuraciones = await obtenerConfiguracionDocumentalPorActividades(
    env,
    actividades.map((item) => item.id)
  );

  let expedientesContexto = [{
    id: docId,
    admin_id: Number(expediente?.admin_id || admin)
  }];
  if (Number(expediente?.centro_usuario_id || 0) > 0 && contextoExpediente.actividadId) {
    const expedientesRows = await env.DB.prepare(`
      SELECT cad.id, cad.admin_id
      FROM centro_admin_documentacion cad
      WHERE cad.centro_usuario_id = ?
        AND ${condicionContexto.sql}
    `).bind(Number(expediente.centro_usuario_id || 0), ...condicionContexto.valores).all();
    expedientesContexto = (expedientesRows?.results || [])
      .map((row) => ({ id: Number(row.id || 0), admin_id: Number(row.admin_id || 0) }))
      .filter((row) => row.id > 0 && row.admin_id > 0);
  }
  if (!expedientesContexto.length && archivosRows?.results?.length) {
    expedientesContexto = [{ id: docId, admin_id: Number(expediente?.admin_id || admin) }];
  }
  const archivosPorPropietario = await construirArchivosPorPropietario(env, expedientesContexto);

  const solicitables = [];
  const bloqueadas = [];
  for (const actividad of actividades) {
    const config = configuraciones.get(actividad.id) || { modo: "HEREDADA", documentos: [] };
    const docsExigibles = resolverDocumentosExigiblesActividad(catalogo, config);
    if (!docsExigibles.length) {
      bloqueadas.push(actividad.nombre);
      continue;
    }
    const cumple = documentosCumplidosPorPropietario(docsExigibles, archivosPorPropietario, admin);
    if (cumple) solicitables.push(actividad.nombre);
    else bloqueadas.push(actividad.nombre);
  }

  return {
    total_activas: actividades.length,
    solicitables_total: solicitables.length,
    bloqueadas_total: bloqueadas.length,
    puede_todas: actividades.length > 0 && solicitables.length === actividades.length,
    solicitables,
    bloqueadas
  };
}

export async function construirResumenActividadesSolicitablesSecretaria(env, {
  secretariaId,
  centroUsuarioId,
  actividadId = null,
  reservaId = null
} = {}) {
  const secretaria = Number(secretariaId || 0);
  const centroUsuario = Number(centroUsuarioId || 0);
  if (!(secretaria > 0) || !(centroUsuario > 0)) {
    return resultadoVacio();
  }

  await asegurarColumnasContextoDocumental(env);

  const contexto = normalizarContextoDocumental({ actividadId, reservaId });
  const condicionContexto = construirCondicionContextoDocumental(contexto, "cad");

  const [expedientesRows, actividadesRows] = await Promise.all([
    env.DB.prepare(`
      SELECT
        cad.id,
        cad.admin_id,
        admin.nombre AS admin_nombre,
        admin.nombre_publico AS admin_nombre_publico
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios admin ON admin.id = cad.admin_id
      WHERE cad.centro_usuario_id = ?
        AND ${condicionContexto.sql}
        AND admin.rol = 'ADMIN'
        AND admin.secretaria_usuario_id = ?
        AND COALESCE(admin.modulo_secretaria, 0) = 0
    `).bind(centroUsuario, ...condicionContexto.valores, secretaria).all(),
    env.DB.prepare(`
      SELECT
        a.id,
        a.admin_id,
        COALESCE(NULLIF(TRIM(a.titulo_publico), ''), NULLIF(TRIM(a.nombre), ''), 'Actividad') AS nombre,
        COALESCE(a.requiere_reserva, 0) AS requiere_reserva,
        COALESCE(a.usa_franjas, 0) AS usa_franjas,
        COALESCE(a.aforo_limitado, 0) AS aforo_limitado,
        admin.nombre AS admin_nombre,
        admin.nombre_publico AS admin_nombre_publico
      FROM actividades a
      INNER JOIN usuarios admin ON admin.id = a.admin_id
      WHERE a.activa = 1
        ${contexto.actividadId ? "AND a.id = ?" : ""}
        AND admin.rol = 'ADMIN'
        AND admin.secretaria_usuario_id = ?
        AND COALESCE(admin.modulo_secretaria, 0) = 0
        AND (
          a.fecha_fin IS NULL
          OR date(a.fecha_fin) >= date('now')
        )
      ORDER BY a.id DESC
    `).bind(...(contexto.actividadId ? [contexto.actividadId, secretaria] : [secretaria])).all()
  ]);

  const expedientes = (expedientesRows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    admin_nombre: mapNombreAdmin(row)
  })).filter((row) => row.id > 0 && row.admin_id > 0);

  const actividades = (actividadesRows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    nombre: limpiarTexto(row.nombre || "Actividad"),
    admin_nombre: mapNombreAdmin(row),
    requiere_reserva: Number(row.requiere_reserva || 0),
    usa_franjas: Number(row.usa_franjas || 0),
    aforo_limitado: Number(row.aforo_limitado || 0)
  })).filter((row) => row.id > 0 && row.admin_id > 0 && esActividadConReserva(row));

  if (!actividades.length) {
    return resultadoVacio();
  }

  const adminIds = [...new Set(actividades.map((item) => item.admin_id))];
  const catalogosPorAdmin = new Map(
    await Promise.all(adminIds.map(async (id) => [
      id,
      await obtenerCatalogoDocumentalVinculadoAdmin(
        env,
        id,
        await obtenerCatalogoDocumentosActivosAdmin(env, id)
      )
    ]))
  );

  const actividadesPorAdmin = new Map();
  for (const actividad of actividades) {
    if (!actividadesPorAdmin.has(actividad.admin_id)) actividadesPorAdmin.set(actividad.admin_id, []);
    actividadesPorAdmin.get(actividad.admin_id).push(actividad.id);
  }

  const configuracionesPorActividad = new Map();
  for (const [adminId, actividadIds] of actividadesPorAdmin.entries()) {
    const configMap = await obtenerConfiguracionDocumentalPorActividades(env, actividadIds);
    for (const [actividadId, cfg] of configMap.entries()) configuracionesPorActividad.set(actividadId, cfg);
  }

  const archivosPorPropietario = await construirArchivosPorPropietario(env, expedientes);

  const solicitables = [];
  const bloqueadas = [];
  for (const actividad of actividades) {
    const catalogo = catalogosPorAdmin.get(actividad.admin_id) || [];
    const config = configuracionesPorActividad.get(actividad.id) || { modo: "HEREDADA", documentos: [] };
    const docsExigibles = resolverDocumentosExigiblesActividad(catalogo, config);
    if (!docsExigibles.length) {
      bloqueadas.push({
        actividad: actividad.nombre,
        organizador: actividad.admin_nombre
      });
      continue;
    }
    const cumple = documentosCumplidosPorPropietario(docsExigibles, archivosPorPropietario, actividad.admin_id);

    const item = {
      actividad: actividad.nombre,
      organizador: actividad.admin_nombre
    };
    if (cumple) solicitables.push(item);
    else bloqueadas.push(item);
  }

  return {
    total_activas: actividades.length,
    solicitables_total: solicitables.length,
    bloqueadas_total: bloqueadas.length,
    puede_todas: actividades.length > 0 && solicitables.length === actividades.length,
    solicitables,
    bloqueadas
  };
}

export async function construirResumenActividadesSolicitablesGlobalCentro(env, {
  centroUsuarioId,
  actividadId = null,
  reservaId = null
} = {}) {
  const centroUsuario = Number(centroUsuarioId || 0);
  if (!(centroUsuario > 0)) {
    return resultadoVacio();
  }

  await asegurarColumnasContextoDocumental(env);

  const contexto = normalizarContextoDocumental({ actividadId, reservaId });
  const condicionContexto = construirCondicionContextoDocumental(contexto, "cad");

  const [expedientesRows, actividadesRows] = await Promise.all([
    env.DB.prepare(`
      SELECT
        cad.id,
        cad.admin_id,
        admin.nombre AS admin_nombre,
        admin.nombre_publico AS admin_nombre_publico
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios admin ON admin.id = cad.admin_id
      WHERE cad.centro_usuario_id = ?
        AND ${condicionContexto.sql}
        AND admin.rol = 'ADMIN'
    `).bind(centroUsuario, ...condicionContexto.valores).all(),
    env.DB.prepare(`
      SELECT
        a.id,
        a.admin_id,
        COALESCE(NULLIF(TRIM(a.titulo_publico), ''), NULLIF(TRIM(a.nombre), ''), 'Actividad') AS nombre,
        COALESCE(a.requiere_reserva, 0) AS requiere_reserva,
        COALESCE(a.usa_franjas, 0) AS usa_franjas,
        COALESCE(a.aforo_limitado, 0) AS aforo_limitado,
        admin.nombre AS admin_nombre,
        admin.nombre_publico AS admin_nombre_publico
      FROM actividades a
      INNER JOIN usuarios admin ON admin.id = a.admin_id
      WHERE a.activa = 1
        ${contexto.actividadId ? "AND a.id = ?" : ""}
        AND COALESCE(a.visible_portal, 0) = 1
        AND admin.rol = 'ADMIN'
        AND (
          a.fecha_fin IS NULL
          OR date(a.fecha_fin) >= date('now')
        )
      ORDER BY a.id DESC
    `).bind(...(contexto.actividadId ? [contexto.actividadId] : [])).all()
  ]);

  const expedientes = (expedientesRows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    admin_nombre: mapNombreAdmin(row)
  })).filter((row) => row.id > 0 && row.admin_id > 0);

  const actividades = (actividadesRows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    nombre: limpiarTexto(row.nombre || "Actividad"),
    admin_nombre: mapNombreAdmin(row),
    requiere_reserva: Number(row.requiere_reserva || 0),
    usa_franjas: Number(row.usa_franjas || 0),
    aforo_limitado: Number(row.aforo_limitado || 0)
  }))
    .filter((row) => row.id > 0 && row.admin_id > 0 && esActividadConReserva(row));

  if (!actividades.length) {
    return resultadoVacio();
  }

  const adminIds = [...new Set(actividades.map((item) => item.admin_id))];
  const catalogosPorAdmin = new Map(
    await Promise.all(adminIds.map(async (id) => [
      id,
      await obtenerCatalogoDocumentalVinculadoAdmin(
        env,
        id,
        await obtenerCatalogoDocumentosActivosAdmin(env, id)
      )
    ]))
  );

  const actividadesPorAdmin = new Map();
  for (const actividad of actividades) {
    if (!actividadesPorAdmin.has(actividad.admin_id)) actividadesPorAdmin.set(actividad.admin_id, []);
    actividadesPorAdmin.get(actividad.admin_id).push(actividad.id);
  }

  const configuracionesPorActividad = new Map();
  for (const [, actividadIds] of actividadesPorAdmin.entries()) {
    const configMap = await obtenerConfiguracionDocumentalPorActividades(env, actividadIds);
    for (const [actividadId, cfg] of configMap.entries()) configuracionesPorActividad.set(actividadId, cfg);
  }

  const archivosPorPropietario = await construirArchivosPorPropietario(env, expedientes);

  const solicitables = [];
  const bloqueadas = [];
  for (const actividad of actividades) {
    const catalogo = catalogosPorAdmin.get(actividad.admin_id) || [];
    const config = configuracionesPorActividad.get(actividad.id) || { modo: "HEREDADA", documentos: [] };
    const docsExigibles = resolverDocumentosExigiblesActividad(catalogo, config);
    if (!docsExigibles.length) {
      bloqueadas.push({
        actividad: actividad.nombre,
        organizador: actividad.admin_nombre
      });
      continue;
    }
    const cumple = documentosCumplidosPorPropietario(docsExigibles, archivosPorPropietario, actividad.admin_id);

    const item = { actividad: actividad.nombre, organizador: actividad.admin_nombre };
    if (cumple) solicitables.push(item);
    else bloqueadas.push(item);
  }

  return {
    total_activas: actividades.length,
    solicitables_total: solicitables.length,
    bloqueadas_total: bloqueadas.length,
    puede_todas: actividades.length > 0 && solicitables.length === actividades.length,
    solicitables,
    bloqueadas
  };
}
