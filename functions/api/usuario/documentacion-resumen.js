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

function calcularEstadoEfectivo(row) {
  const versionRequerida = Number(row?.version_requerida || 0);
  const versionAportada = Number(row?.version_aportada || 0);
  const estado = String(row?.estado || "").toUpperCase();

  if (!versionRequerida) return "NO_REQUERIDA";
  if (!row?.expediente_id) return "PENDIENTE";
  if (versionAportada !== versionRequerida) return "DESACTUALIZADA";

  if (["VALIDADA", "EN_REVISION", "RECHAZADA", "PENDIENTE"].includes(estado)) {
    return estado;
  }

  return "PENDIENTE";
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

    const result = await env.DB.prepare(`
      SELECT
        u.id AS admin_id,
        u.nombre AS admin_nombre,
        u.email AS admin_email,
        MAX(adc.version_documental) AS version_requerida,
        COUNT(adc.id) AS total_documentos,
        cad.id AS expediente_id,
        cad.version_aportada,
        cad.estado,
        cad.fecha_ultima_entrega,
        cad.fecha_validacion,
        cad.observaciones_admin
      FROM admin_documentos_comunes adc
      INNER JOIN usuarios u
        ON u.id = adc.admin_id
      LEFT JOIN centro_admin_documentacion cad
        ON cad.admin_id = u.id
       AND cad.centro_usuario_id = ?
      WHERE adc.activo = 1
        AND u.rol IN ('ADMIN', 'SUPERADMIN')
      GROUP BY
        u.id,
        u.nombre,
        u.email,
        cad.id,
        cad.version_aportada,
        cad.estado,
        cad.fecha_ultima_entrega,
        cad.fecha_validacion,
        cad.observaciones_admin
      HAVING COUNT(adc.id) > 0
      ORDER BY COALESCE(u.nombre, u.email) ASC
    `).bind(usuario.id).all();

    const administradores = (result?.results || []).map((row) => {
      const estadoEfectivo = calcularEstadoEfectivo(row);
      const versionRequerida = Number(row.version_requerida || 0);
      const versionAportada = Number(row.version_aportada || 0);

      return {
        admin_id: Number(row.admin_id || 0),
        admin_nombre: row.admin_nombre || "",
        admin_email: row.admin_email || "",
        version_requerida: versionRequerida,
        version_aportada: versionAportada,
        total_documentos: Number(row.total_documentos || 0),
        expediente_id: Number(row.expediente_id || 0),
        estado: row.estado || "",
        estado_efectivo: estadoEfectivo,
        fecha_ultima_entrega: row.fecha_ultima_entrega || "",
        fecha_validacion: row.fecha_validacion || "",
        observaciones_admin: row.observaciones_admin || "",
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
