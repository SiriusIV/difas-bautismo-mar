import { getUserSession } from "./_auth.js";
import { resolverResponsableDocumental } from "../_documentacion_responsable.js";

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

async function asegurarTablaSeleccion(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS usuario_documentacion_organizadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      centro_usuario_id INTEGER NOT NULL,
      admin_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(centro_usuario_id, admin_id)
    )
  `).run();
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarEstadoDocumento(estado) {
  const valor = String(estado || "").trim().toUpperCase();
  return valor || "EN_REVISION";
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

function contarDocumentosValidados(documentosActivos, archivosActivos) {
  const archivosPorNombre = new Map(
    (archivosActivos || []).map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo])
  );

  let validados = 0;
  for (const doc of documentosActivos || []) {
    const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre)) || null;
    if (!entrega) continue;
    if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) continue;
    if (normalizarEstadoDocumento(entrega.estado) === "VALIDADO") {
      validados += 1;
    }
  }

  return validados;
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

    await asegurarTablaSeleccion(env);

    const adminsRows = await env.DB.prepare(`
      SELECT
        u.id AS admin_id,
        u.nombre AS admin_nombre,
        u.nombre_publico AS admin_nombre_publico,
        u.localidad AS admin_localidad,
        u.email AS admin_email
      FROM usuario_documentacion_organizadores sel
      INNER JOIN usuarios u
        ON u.id = sel.admin_id
      WHERE sel.centro_usuario_id = ?
        AND u.rol IN ('ADMIN', 'SUPERADMIN')
      ORDER BY COALESCE(u.nombre_publico, u.nombre, u.email) ASC
    `).bind(usuario.id).all();

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
          propietario_documental_id: null,
          documentos: []
        });
      }
    }

    for (const admin of adminsAgrupados.values()) {
      const resolucion = await resolverResponsableDocumental(env, admin.admin_id);
      const propietarioDocumentalId = Number(
        String(resolucion?.modo || "").toUpperCase() === "SECRETARIA_EXTERNA"
          ? resolucion?.responsable?.id || 0
          : resolucion?.admin?.id || 0
      );

      admin.propietario_documental_id = propietarioDocumentalId || admin.admin_id;

      const documentosRows = await env.DB.prepare(`
        SELECT
          id,
          nombre,
          version_documental
        FROM admin_documentos_comunes
        WHERE admin_id = ?
          AND activo = 1
        ORDER BY orden ASC, id ASC
      `).bind(admin.propietario_documental_id).all();

      admin.documentos = (documentosRows?.results || []).map((row) => ({
        id: Number(row.id || 0),
        nombre: row.nombre || "",
        version_documental: Number(row.version_documental || 0)
      }));
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
          documentacion_id,
          nombre_documento,
          version_documental,
          estado
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
      const expediente = expedientesPorAdmin.get(admin.admin_id) || null;
      const archivosActivos = expediente ? (archivosPorExpediente.get(Number(expediente.id || 0)) || []) : [];
      const estadoEfectivo = calcularEstadoGlobal(admin.documentos, archivosActivos);
      const versionRequerida = admin.documentos.reduce((max, doc) => Math.max(max, Number(doc.version_documental || 0)), 0);
      const totalValidados = contarDocumentosValidados(admin.documentos, archivosActivos);

      return {
        admin_id: admin.admin_id,
        admin_nombre: admin.admin_nombre,
        admin_nombre_publico: admin.admin_nombre_publico,
        admin_localidad: admin.admin_localidad,
        admin_email: admin.admin_email,
        version_requerida: versionRequerida,
        version_aportada: Number(expediente?.version_aportada || 0),
        total_documentos: admin.documentos.length,
        total_documentos_validados: totalValidados,
        expediente_id: Number(expediente?.id || 0),
        estado: expediente?.estado || "",
        estado_efectivo: estadoEfectivo,
        fecha_ultima_entrega: archivosActivos.length ? (expediente?.fecha_ultima_entrega || "") : "",
        fecha_validacion: expediente?.fecha_validacion || "",
        observaciones_admin: expediente?.observaciones_admin || "",
        al_dia: estadoEfectivo === "VALIDADA"
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
