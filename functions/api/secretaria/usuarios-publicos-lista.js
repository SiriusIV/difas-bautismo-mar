import { getSecretariaSession } from "./_documental.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarEstado(valor) {
  return limpiarTexto(valor).toUpperCase();
}

function resolverEstadoGlobal(estados = []) {
  const lista = estados.map(normalizarEstado);
  if (lista.some((e) => e === "RECHAZADA" || e === "RECHAZADO")) return "Rechazada";
  if (lista.some((e) => e === "NO_ACTUALIZADO")) return "Desactualizado";
  if (lista.some((e) => e === "EN_REVISION" || e === "VALIDACION_PARCIAL" || e === "NO_COMPLETADO" || e === "NO_INICIADO")) return "Pendiente";
  if (lista.every((e) => e === "VALIDADA" || e === "NO_REQUERIDA")) return "Validada";
  return "Pendiente";
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const session = await getSecretariaSession(request, env);
    if (!session || session.rol !== "SECRETARIA") {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const rows = await env.DB.prepare(`
      SELECT
        u.id,
        u.centro,
        u.nombre,
        u.email,
        u.telefono_contacto,
        cad.estado AS estado_expediente,
        cad.updated_at
      FROM usuarios admin
      INNER JOIN centro_admin_documentacion cad
        ON cad.admin_id = admin.id
      INNER JOIN usuarios u
        ON u.id = cad.centro_usuario_id
      WHERE admin.rol = 'ADMIN'
        AND COALESCE(admin.modulo_secretaria, 0) = 0
        AND admin.secretaria_usuario_id = ?
        AND u.rol = 'SOLICITANTE'
        AND COALESCE(u.activo, 1) = 1
      ORDER BY datetime(COALESCE(cad.updated_at, cad.created_at, '1970-01-01 00:00:00')) DESC
    `).bind(session.usuario_id).all();

    const porUsuario = new Map();
    for (const row of (rows?.results || [])) {
      const id = Number(row.id || 0);
      if (!id) continue;
      if (!porUsuario.has(id)) {
        porUsuario.set(id, {
          id,
          centro: row.centro || row.nombre || "",
          nombre: row.nombre || "",
          email: row.email || "",
          telefono_contacto: row.telefono_contacto || "",
          estados: [],
          updated_at: row.updated_at || ""
        });
      }
      const item = porUsuario.get(id);
      item.estados.push(row.estado_expediente || "");
      if (limpiarTexto(row.updated_at) > limpiarTexto(item.updated_at)) {
        item.updated_at = row.updated_at || item.updated_at;
      }
    }

    const usuarios = Array.from(porUsuario.values()).map((item) => ({
      id: item.id,
      centro: item.centro,
      nombre: item.nombre,
      email: item.email,
      telefono_contacto: item.telefono_contacto,
      estado_documental: resolverEstadoGlobal(item.estados),
      actualizado_en: item.updated_at || ""
    }));

    return json({ ok: true, total: usuarios.length, usuarios });
  } catch (error) {
    return json({ ok: false, error: "No se pudo cargar el listado de usuarios públicos.", detalle: error?.message || String(error) }, 500);
  }
}
