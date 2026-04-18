import { getSecretariaSession, recalcularImpactoSecretaria } from "./_documental.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsearVersionPositiva(valor) {
  const texto = limpiarTexto(valor).replace(",", ".");
  const n = Number.parseFloat(texto);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function obtenerDocumentoObjetivo(env, secretariaId, documentoId) {
  return await env.DB.prepare(`
    SELECT id, admin_id, nombre, descripcion, archivo_url, orden, activo, version_documental
    FROM admin_documentos_comunes
    WHERE id = ?
      AND admin_id = ?
    LIMIT 1
  `).bind(documentoId, secretariaId).first();
}

async function existeDuplicadoActivo(env, adminId, nombre, documentoId = 0) {
  const row = await env.DB.prepare(`
    SELECT id
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      AND activo = 1
      AND UPPER(TRIM(nombre)) = UPPER(TRIM(?))
      AND id <> ?
    LIMIT 1
  `).bind(adminId, nombre, Number(documentoId || 0)).first();
  return Boolean(row?.id);
}

async function siguienteOrden(env, adminId) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(MAX(orden), -1) AS max_orden
    FROM admin_documentos_comunes
    WHERE admin_id = ?
  `).bind(adminId).first();
  return Number(row?.max_orden ?? -1) + 1;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getSecretariaSession(request, env);
    if (!session) return json({ ok: false, error: "No autorizado." }, 401);

    const body = await request.json().catch(() => null);
    const baseUrl = new URL(request.url).origin;
    const documentoId = parsearIdPositivo(body?.documento_id);
    const titulo = limpiarTexto(body?.nombre);
    const descripcion = limpiarTexto(body?.descripcion);
    const version = parsearVersionPositiva(body?.version_documental);

    if (!titulo) return json({ ok: false, error: "Debes indicar un título válido para el documento." }, 400);
    if (!version) return json({ ok: false, error: "Debes indicar una versión válida del documento." }, 400);

    if (documentoId) {
      const actual = await obtenerDocumentoObjetivo(env, session.usuario_id, documentoId);
      if (!actual) return json({ ok: false, error: "No se encontró el documento seleccionado." }, 404);
      if (Number(actual.activo || 0) === 1 && await existeDuplicadoActivo(env, actual.admin_id, titulo, documentoId)) {
        return json({ ok: false, error: "Ya existe otro documento activo con ese mismo título." }, 400);
      }
      await env.DB.prepare(`
        UPDATE admin_documentos_comunes
        SET nombre = ?, descripcion = ?, version_documental = ?, fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(titulo, descripcion || null, version, documentoId).run();

      const impacto = await recalcularImpactoSecretaria(env, session.usuario_id, baseUrl, "documentos_actualizados");
      return json({ ok: true, mensaje: "Documento actualizado correctamente.", documento_id: documentoId, impacto_reservas: impacto });
    }

    if (await existeDuplicadoActivo(env, session.usuario_id, titulo, 0)) {
      return json({ ok: false, error: "Ya existe un documento activo con ese mismo título." }, 400);
    }

    const orden = await siguienteOrden(env, session.usuario_id);
    const result = await env.DB.prepare(`
      INSERT INTO admin_documentos_comunes (
        admin_id, nombre, descripcion, archivo_url, orden, activo, version_documental, fecha_actualizacion
      ) VALUES (?, ?, ?, '', ?, 1, ?, CURRENT_TIMESTAMP)
    `).bind(session.usuario_id, titulo, descripcion || null, orden, version).run();

    const impacto = await recalcularImpactoSecretaria(env, session.usuario_id, baseUrl, "documento_creado");
    return json({ ok: true, mensaje: "Documento creado correctamente.", documento_id: Number(result?.meta?.last_row_id || 0), impacto_reservas: impacto });
  } catch (error) {
    return json({ ok: false, error: "No se pudo guardar el documento de la secretaría.", detalle: error.message }, 500);
  }
}
