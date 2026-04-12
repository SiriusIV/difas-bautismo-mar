import { getUserSession } from "./_auth.js";

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

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function calcularEstadoEfectivo(expediente, documentosActivos, archivosActivos) {
  if (!Array.isArray(documentosActivos) || documentosActivos.length === 0) {
    return "NO_REQUERIDA";
  }

  if (!expediente) {
    return "PENDIENTE";
  }

  const estadoExpediente = String(expediente.estado || "").toUpperCase();
  const archivosPorNombre = new Map(
    (archivosActivos || []).map((archivo) => [limpiarTexto(archivo.nombre_documento), archivo])
  );

  let faltaAlgunoNuncaRemitido = false;
  let hayAlgunoDesactualizado = false;

  for (const doc of documentosActivos) {
    const entrega = archivosPorNombre.get(limpiarTexto(doc.nombre));

    if (!entrega) {
      faltaAlgunoNuncaRemitido = true;
      continue;
    }

    if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) {
      hayAlgunoDesactualizado = true;
    }
  }

  if (hayAlgunoDesactualizado) {
    return "DESACTUALIZADA";
  }

  if (faltaAlgunoNuncaRemitido) {
    return "PENDIENTE";
  }

  if (estadoExpediente === "VALIDADA") {
    return "VALIDADA";
  }

  if (estadoExpediente === "RECHAZADA") {
    return "RECHAZADA";
  }

  return "EN_REVISION";
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

    const adminsRows = await env.DB.prepare(`
      SELECT
        u.id AS admin_id,
        u.nombre AS admin_nombre,
        u.nombre_publico AS admin_nombre_publico,
        u.localidad AS admin_localidad,
        u.email AS admin_email,
        adc.id AS documento_id,
        adc.nombre AS documento_nombre,
        adc.version_documental
      FROM admin_documentos_comunes adc
      INNER JOIN usuarios u
        ON u.id = adc.admin_id
      WHERE adc.activo = 1
        AND u.rol IN ('ADMIN', 'SUPERADMIN')
      ORDER BY COALESCE(u.nombre_publico, u.nombre, u.email) ASC, adc.orden ASC, adc.id ASC
    `).all();

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
          documentos: []
        });
      }

      adminsAgrupados.get(adminId).documentos.push({
        id: Number(row.documento_id || 0),
        nombre: row.documento_nombre || "",
        version_documental: Number(row.version_documental || 0)
      });
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
          version_documental
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
      const estadoEfectivo = calcularEstadoEfectivo(expediente, admin.documentos, archivosActivos);
      const versionRequerida = admin.documentos.reduce((max, doc) => Math.max(max, Number(doc.version_documental || 0)), 0);

      return {
        admin_id: admin.admin_id,
        admin_nombre: admin.admin_nombre,
        admin_nombre_publico: admin.admin_nombre_publico,
        admin_localidad: admin.admin_localidad,
        admin_email: admin.admin_email,
        version_requerida: versionRequerida,
        version_aportada: Number(expediente?.version_aportada || 0),
        total_documentos: admin.documentos.length,
        expediente_id: Number(expediente?.id || 0),
        estado: expediente?.estado || "",
        estado_efectivo: estadoEfectivo,
        fecha_ultima_entrega: expediente?.fecha_ultima_entrega || "",
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
