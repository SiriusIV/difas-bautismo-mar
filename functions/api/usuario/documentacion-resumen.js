import { getUserSession } from "./_auth.js";
import { obtenerCatalogoDocumentosActivosAdmin } from "../_actividad_documentacion.js";
import { obtenerCatalogoDocumentalVinculadoAdmin } from "../_documentacion_propietarios.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
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

async function obtenerAdminVisible(env, adminId) {
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
    LIMIT 1
  `).bind(adminId).first();
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

function normalizarEstadoDocumento(estado) {
  const valor = String(estado || "").trim().toUpperCase();
  return valor || "EN_REVISION";
}

function obtenerPropietarioDocumentalDocumento(doc) {
  return Number(doc?.propietario_id || doc?.admin_id || 0);
}

function claveDocumento(nombre, propietarioId = 0) {
  const nombreNormalizado = limpiarTexto(nombre);
  const propietario = Number(propietarioId || 0);
  return propietario > 0
    ? `${propietario}::${nombreNormalizado}`
    : nombreNormalizado;
}

function seleccionarUltimosArchivosPorDocumento(archivos = []) {
  const porNombre = new Map();

  for (const archivo of Array.isArray(archivos) ? archivos : []) {
    const nombre = limpiarTexto(archivo?.nombre_documento);
    if (!nombre) continue;
    const propietarioId = Number(archivo?.propietario_documental_id || archivo?.admin_id || 0);
    const key = claveDocumento(nombre, propietarioId);

    const existente = porNombre.get(key);
    if (!existente || Number(archivo?.id || 0) > Number(existente?.id || 0)) {
      porNombre.set(key, archivo);
      if (!porNombre.has(nombre)) {
        porNombre.set(nombre, archivo);
      }
    }
  }

  return Array.from(new Set(porNombre.values()));
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

function calcularEstadoGlobal(documentosActivos, archivosActivos) {
  if (!Array.isArray(documentosActivos) || documentosActivos.length === 0) {
    return "NO_REQUERIDA";
  }

  const archivosPorNombre = new Map();
  for (const archivo of archivosActivos || []) {
    const nombre = limpiarTexto(archivo.nombre_documento);
    if (!nombre) continue;
    const propietarioId = Number(archivo?.propietario_documental_id || archivo?.admin_id || 0);
    archivosPorNombre.set(claveDocumento(nombre, propietarioId), archivo);
    if (!archivosPorNombre.has(nombre)) archivosPorNombre.set(nombre, archivo);
  }

  const estados = documentosActivos.map((doc) => {
    const nombre = limpiarTexto(doc.nombre);
    const entrega = archivosPorNombre.get(claveDocumento(nombre, obtenerPropietarioDocumentalDocumento(doc))) ||
      archivosPorNombre.get(nombre) ||
      null;
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

  if (estados.some((estado) => estado === "EN_REVISION")) {
    return "EN_REVISION";
  }

  if (estados.every((estado) => estado === "VALIDADO")) {
    return "VALIDADA";
  }

  return "VALIDACION_PARCIAL";
}

function contarDocumentosValidados(documentosActivos, archivosActivos) {
  const archivosPorNombre = new Map();
  for (const archivo of archivosActivos || []) {
    const nombre = limpiarTexto(archivo.nombre_documento);
    if (!nombre) continue;
    const propietarioId = Number(archivo?.propietario_documental_id || archivo?.admin_id || 0);
    archivosPorNombre.set(claveDocumento(nombre, propietarioId), archivo);
    if (!archivosPorNombre.has(nombre)) archivosPorNombre.set(nombre, archivo);
  }

  let validados = 0;
  for (const doc of documentosActivos || []) {
    const nombre = limpiarTexto(doc.nombre);
    const entrega = archivosPorNombre.get(claveDocumento(nombre, obtenerPropietarioDocumentalDocumento(doc))) ||
      archivosPorNombre.get(nombre) ||
      null;
    const estadoDocumento = calcularEstadoDocumento(doc, entrega);
    if (estadoDocumento === "VALIDADO") {
      validados += 1;
    }
  }

  return validados;
}

function obtenerPropietariosDocumentales(documentos = []) {
  return Array.from(new Set(
    (Array.isArray(documentos) ? documentos : [])
      .map((doc) => obtenerPropietarioDocumentalDocumento(doc))
      .filter((id) => id > 0)
  ));
}

async function obtenerDocumentosPropios(env, propietarioId) {
  const rows = await env.DB.prepare(`
    SELECT
      d.id,
      d.admin_id,
      d.nombre,
      d.version_documental,
      d.fecha_actualizacion,
      u.rol AS propietario_rol,
      COALESCE(NULLIF(TRIM(u.nombre_publico), ''), NULLIF(TRIM(u.nombre), ''), NULLIF(TRIM(u.email), ''), '') AS propietario_nombre
    FROM admin_documentos_comunes d
    LEFT JOIN usuarios u ON u.id = d.admin_id
    WHERE d.admin_id = ?
      AND COALESCE(d.activo, 1) = 1
    ORDER BY d.orden ASC, d.id ASC
  `).bind(propietarioId).all();

  return (rows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    propietario_id: Number(row.admin_id || 0),
    propietario_rol: limpiarTexto(row.propietario_rol),
    propietario_nombre: limpiarTexto(row.propietario_nombre),
    nombre: row.nombre || "",
    version_documental: Number(row.version_documental || 0),
    fecha_actualizacion: row.fecha_actualizacion || ""
  }));
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
    const adminPreferenteId = Number.parseInt(url.searchParams.get("admin_id") || "", 10);
    const adminPreferenteValido = Number.isInteger(adminPreferenteId) && adminPreferenteId > 0
      ? adminPreferenteId
      : null;

    const adminsRows = await env.DB.prepare(`
      WITH admins_fuente AS (
        SELECT DISTINCT a.admin_id AS admin_id
        FROM reservas r
        INNER JOIN actividades a
          ON a.id = r.actividad_id
        LEFT JOIN franjas f
          ON f.id = r.franja_id
        WHERE r.usuario_id = ?
          AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA', 'RECHAZADA')
          AND (
            (
              r.franja_id IS NOT NULL
              AND f.fecha IS NOT NULL
              AND datetime(
                f.fecha || ' ' || COALESCE(NULLIF(TRIM(f.hora_fin), ''), '23:59:59')
              ) >= datetime('now')
            )
            OR
            (
              r.franja_id IS NULL
              AND (
                a.fecha_fin IS NULL
                OR datetime(a.fecha_fin || ' 23:59:59') >= datetime('now')
              )
            )
          )

        UNION

        SELECT DISTINCT cad.admin_id AS admin_id
        FROM centro_admin_documentacion cad
        WHERE cad.centro_usuario_id = ?
      )
      SELECT
        af.admin_id,
        u.nombre AS admin_nombre,
        u.nombre_publico AS admin_nombre_publico,
        u.localidad AS admin_localidad,
        u.email AS admin_email,
        u.rol AS admin_rol
      FROM admins_fuente af
      INNER JOIN usuarios u
        ON u.id = af.admin_id
      WHERE u.rol IN ('ADMIN', 'SUPERADMIN', 'SECRETARIA')
      ORDER BY COALESCE(u.nombre_publico, u.nombre, u.email) ASC
    `).bind(usuario.id, usuario.id).all();

    const adminsAgrupados = new Map();
    for (const row of adminsRows?.results || []) {
      const adminId = Number(row.admin_id || 0);
      if (!adminsAgrupados.has(adminId)) {
        adminsAgrupados.set(adminId, {
          admin_id: adminId,
          admin_nombre: row.admin_nombre || "",
          admin_nombre_publico: row.admin_nombre_publico || "",
          admin_localidad: row.admin_localidad || "",
          admin_email: row.admin_email || "",
          admin_rol: row.admin_rol || "",
          propietario_documental_id: null,
          documentos: []
        });
      }
    }

    if (adminPreferenteValido && !adminsAgrupados.has(adminPreferenteValido)) {
      const adminPreferente = await obtenerAdminVisible(env, adminPreferenteValido);
      if (adminPreferente && ["ADMIN", "SUPERADMIN"].includes(String(adminPreferente.rol || "").toUpperCase())) {
        adminsAgrupados.set(adminPreferenteValido, {
          admin_id: adminPreferenteValido,
          admin_nombre: adminPreferente.nombre || "",
          admin_nombre_publico: adminPreferente.nombre_publico || "",
          admin_localidad: adminPreferente.localidad || "",
          admin_email: adminPreferente.email || "",
          admin_rol: adminPreferente.rol || "",
          propietario_documental_id: null,
          documentos: []
        });
      }
    }

    for (const admin of adminsAgrupados.values()) {
      const rolAdmin = String(admin.admin_rol || "").toUpperCase();
      const documentos = rolAdmin === "SECRETARIA"
        ? await obtenerDocumentosPropios(env, admin.admin_id)
        : await obtenerCatalogoDocumentalVinculadoAdmin(
            env,
            admin.admin_id,
            await obtenerCatalogoDocumentosActivosAdmin(env, admin.admin_id)
          );
      const propietarios = obtenerPropietariosDocumentales(documentos);
      admin.propietario_documental_id = propietarios.length === 1 ? propietarios[0] : null;
      admin.propietarios_documentales = propietarios;
      admin.documentos = documentos;
    }

    const expedientesRows = await env.DB.prepare(`
      SELECT
        id,
        admin_id,
        version_requerida,
        version_aportada,
        estado,
        fecha_ultima_entrega,
        fecha_validacion,
        observaciones_admin
      FROM centro_admin_documentacion
      WHERE centro_usuario_id = ?
    `).bind(usuario.id).all();

    const expedientesPorAdmin = new Map(
      (expedientesRows?.results || []).map((row) => [Number(row.admin_id || 0), row])
    );

    const expedientesIds = (expedientesRows?.results || [])
      .map((row) => Number(row.id || 0))
      .filter((id) => id > 0);

    const archivosPorExpediente = new Map();
    if (expedientesIds.length) {
      const placeholders = expedientesIds.map(() => "?").join(", ");
      const archivosRows = await env.DB.prepare(`
        SELECT
          id,
          documentacion_id,
          nombre_documento,
          version_documental,
          estado,
          fecha_subida,
          fecha_validacion,
          observaciones_admin
        FROM centro_admin_documentacion_archivos
        WHERE activo = 1
          AND documentacion_id IN (${placeholders})
      `).bind(...expedientesIds).all();

      for (const row of archivosRows?.results || []) {
        const docId = Number(row.documentacion_id || 0);
        if (!archivosPorExpediente.has(docId)) {
          archivosPorExpediente.set(docId, []);
        }
        archivosPorExpediente.get(docId).push(row);
      }
    }

    const administradores = Array.from(adminsAgrupados.values()).map((admin) => {
      const propietarios = admin.propietarios_documentales?.length
        ? admin.propietarios_documentales
        : [admin.admin_id];
      const expedientes = propietarios
        .map((propietarioId) => expedientesPorAdmin.get(Number(propietarioId || 0)) || null)
        .filter(Boolean);
      const expediente = expedientesPorAdmin.get(admin.admin_id) || expedientes[0] || null;
      const archivosActivos = seleccionarUltimosArchivosPorDocumento(
        expedientes.flatMap((expedienteItem) => {
          const expedienteId = Number(expedienteItem?.id || 0);
          const propietarioId = Number(expedienteItem?.admin_id || 0);
          return (archivosPorExpediente.get(expedienteId) || []).map((archivo) => ({
            ...archivo,
            propietario_documental_id: propietarioId
          }));
        })
      );
      const estadoEfectivo = calcularEstadoGlobal(admin.documentos, archivosActivos);
      const versionRequerida = admin.documentos.reduce((max, doc) => Math.max(max, Number(doc.version_documental || 0)), 0);
      const totalValidados = contarDocumentosValidados(admin.documentos, archivosActivos);
      const archivosPorNombre = new Map();
      for (const archivo of archivosActivos || []) {
        const nombre = limpiarTexto(archivo.nombre_documento);
        if (!nombre) continue;
        const propietarioId = Number(archivo?.propietario_documental_id || archivo?.admin_id || 0);
        archivosPorNombre.set(claveDocumento(nombre, propietarioId), archivo);
        if (!archivosPorNombre.has(nombre)) archivosPorNombre.set(nombre, archivo);
      }
      const alertasRevision = (admin.documentos || []).map((doc) => {
        const nombre = limpiarTexto(doc.nombre);
        const propietarioId = obtenerPropietarioDocumentalDocumento(doc);
        const entrega = archivosPorNombre.get(claveDocumento(nombre, propietarioId)) ||
          archivosPorNombre.get(nombre) ||
          null;
        if (!entrega) return null;
        const estadoDocumento = calcularEstadoDocumento(doc, entrega);
        if (!["VALIDADO", "RECHAZADO", "NO_ACTUALIZADO"].includes(estadoDocumento)) {
          return null;
        }
        return {
          nombre_documento: doc.nombre || "",
          propietario_documental_id: propietarioId,
          propietario_documental_nombre: limpiarTexto(doc.propietario_nombre),
          estado: estadoDocumento,
          fecha_subida: entrega.fecha_subida || "",
          fecha_validacion: entrega.fecha_validacion || "",
          observaciones_admin: entrega.observaciones_admin || ""
        };
      }).filter(Boolean);

      return {
        admin_id: admin.admin_id,
        admin_nombre: admin.admin_nombre,
        admin_nombre_publico: admin.admin_nombre_publico,
        admin_localidad: admin.admin_localidad,
        admin_email: admin.admin_email,
        admin_rol: admin.admin_rol || "",
        propietarios_documentales: propietarios,
        version_requerida: versionRequerida,
        version_aportada: expedientes.reduce((max, item) => Math.max(max, Number(item?.version_aportada || 0)), 0),
        total_documentos: admin.documentos.length,
        total_documentos_validados: totalValidados,
        expediente_id: Number(expediente?.id || 0),
        estado: estadoEfectivo,
        estado_efectivo: estadoEfectivo,
        fecha_ultima_entrega: archivosActivos.length
          ? expedientes.map((item) => item?.fecha_ultima_entrega || "").filter(Boolean).sort().pop() || ""
          : "",
        fecha_validacion: expedientes.map((item) => item?.fecha_validacion || "").filter(Boolean).sort().pop() || "",
        observaciones_admin: expedientes.map((item) => item?.observaciones_admin || "").filter(Boolean).join(" | "),
        al_dia: estadoEfectivo === "VALIDADA",
        total_alertas_revision: alertasRevision.length,
        alertas_revision: alertasRevision
      };
    });

    return json({
      ok: true,
      centro: {
        id: usuario.id,
        centro: usuario.centro || "",
        email: usuario.email || ""
      },
      total: administradores.length,
      administradores
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo cargar el resumen documental del solicitante.",
        detalle: error.message
      },
      500
    );
  }
}
