import {
  obtenerCatalogoDocumentosActivosAdmin,
  obtenerConfiguracionDocumentalPorActividades,
  resolverDocumentosExigiblesActividad
} from "./_actividad_documentacion.js";
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

export async function construirResumenActividadesSolicitables(env, {
  adminId,
  documentacionId
} = {}) {
  const admin = Number(adminId || 0);
  const docId = Number(documentacionId || 0);
  if (!(admin > 0) || !(docId > 0)) {
    return {
      total_activas: 0,
      solicitables_total: 0,
      bloqueadas_total: 0,
      puede_todas: false,
      solicitables: [],
      bloqueadas: []
    };
  }

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
        AND (
          fecha_fin IS NULL
          OR date(fecha_fin) >= date('now')
        )
      ORDER BY id DESC
    `).bind(admin).all(),
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
    return {
      total_activas: 0,
      solicitables_total: 0,
      bloqueadas_total: 0,
      puede_todas: false,
      solicitables: [],
      bloqueadas: []
    };
  }

  const configuraciones = await obtenerConfiguracionDocumentalPorActividades(
    env,
    actividades.map((item) => item.id)
  );

  const archivos = archivosRows?.results || [];
  const archivosPorNombre = new Map(
    archivos.map((item) => [normalizarClaveDocumento(item.nombre_documento), item])
  );

  const solicitables = [];
  const bloqueadas = [];
  for (const actividad of actividades) {
    const config = configuraciones.get(actividad.id) || { modo: "HEREDADA", documentos: [] };
    const docsExigibles = resolverDocumentosExigiblesActividad(catalogo, config);
    if (!docsExigibles.length) {
      bloqueadas.push(actividad.nombre);
      continue;
    }
    const cumple = docsExigibles.every((doc) => {
      const entrega = archivosPorNombre.get(normalizarClaveDocumento(doc.nombre)) || null;
      return documentoCumple(doc, entrega);
    });
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
  centroUsuarioId
} = {}) {
  const secretaria = Number(secretariaId || 0);
  const centroUsuario = Number(centroUsuarioId || 0);
  if (!(secretaria > 0) || !(centroUsuario > 0)) {
    return {
      total_activas: 0,
      solicitables_total: 0,
      bloqueadas_total: 0,
      puede_todas: false,
      solicitables: [],
      bloqueadas: []
    };
  }

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
        AND admin.rol = 'ADMIN'
        AND admin.secretaria_usuario_id = ?
        AND COALESCE(admin.modulo_secretaria, 0) = 0
    `).bind(centroUsuario, secretaria).all(),
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
        AND admin.rol = 'ADMIN'
        AND admin.secretaria_usuario_id = ?
        AND COALESCE(admin.modulo_secretaria, 0) = 0
        AND (
          a.fecha_fin IS NULL
          OR date(a.fecha_fin) >= date('now')
        )
      ORDER BY a.id DESC
    `).bind(secretaria).all()
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
    return {
      total_activas: 0,
      solicitables_total: 0,
      bloqueadas_total: 0,
      puede_todas: false,
      solicitables: [],
      bloqueadas: []
    };
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

  const expedientePorAdmin = new Map(expedientes.map((exp) => [exp.admin_id, exp]));
  const archivosPorExpediente = new Map();
  for (const exp of expedientes) {
    const rows = await env.DB.prepare(`
      SELECT nombre_documento, version_documental, estado
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
    `).bind(exp.id).all();
    const map = new Map((rows?.results || []).map((item) => [normalizarClaveDocumento(item.nombre_documento), item]));
    archivosPorExpediente.set(exp.id, map);
  }

  const solicitables = [];
  const bloqueadas = [];
  for (const actividad of actividades) {
    const expediente = expedientePorAdmin.get(actividad.admin_id) || null;
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
    const archivosMap = expediente ? (archivosPorExpediente.get(expediente.id) || new Map()) : new Map();

    const cumple = docsExigibles.every((doc) => {
      const entrega = archivosMap.get(normalizarClaveDocumento(doc.nombre)) || null;
      return documentoCumple(doc, entrega);
    });

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
  centroUsuarioId
} = {}) {
  const centroUsuario = Number(centroUsuarioId || 0);
  if (!(centroUsuario > 0)) {
    return {
      total_activas: 0,
      solicitables_total: 0,
      bloqueadas_total: 0,
      puede_todas: false,
      solicitables: [],
      bloqueadas: []
    };
  }

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
        AND admin.rol = 'ADMIN'
    `).bind(centroUsuario).all(),
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
        AND COALESCE(a.visible_portal, 0) = 1
        AND admin.rol = 'ADMIN'
        AND (
          a.fecha_fin IS NULL
          OR date(a.fecha_fin) >= date('now')
        )
      ORDER BY a.id DESC
    `).all()
  ]);

  const expedientes = (expedientesRows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    admin_nombre: mapNombreAdmin(row)
  })).filter((row) => row.id > 0 && row.admin_id > 0);

  const expedientePorAdmin = new Map(expedientes.map((exp) => [exp.admin_id, exp]));

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
    return {
      total_activas: 0,
      solicitables_total: 0,
      bloqueadas_total: 0,
      puede_todas: false,
      solicitables: [],
      bloqueadas: []
    };
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

  const archivosPorExpediente = new Map();
  for (const exp of expedientes) {
    const rows = await env.DB.prepare(`
      SELECT nombre_documento, version_documental, estado
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
    `).bind(exp.id).all();
    const map = new Map((rows?.results || []).map((item) => [normalizarClaveDocumento(item.nombre_documento), item]));
    archivosPorExpediente.set(exp.id, map);
  }

  const solicitables = [];
  const bloqueadas = [];
  for (const actividad of actividades) {
    const expediente = expedientePorAdmin.get(actividad.admin_id) || null;
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
    const archivosMap = expediente ? (archivosPorExpediente.get(expediente.id) || new Map()) : new Map();

    const cumple = docsExigibles.every((doc) => {
      const entrega = archivosMap.get(normalizarClaveDocumento(doc.nombre)) || null;
      return documentoCumple(doc, entrega);
    });

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
