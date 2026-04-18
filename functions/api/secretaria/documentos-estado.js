import { getSecretariaSession, recalcularImpactoSecretaria } from "./_documental.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function obtenerDocumentoObjetivo(env, secretariaId, documentoId) {
  return await env.DB.prepare(`
    SELECT id, admin_id, nombre, activo
    FROM admin_documentos_comunes
    WHERE id = ?
      AND admin_id = ?
    LIMIT 1
  `).bind(documentoId, secretariaId).first();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getSecretariaSession(request, env);
    if (!session) return json({ ok: false, error: "No autorizado." }, 401);

    const body = await request.json().catch(() => null);
    const baseUrl = new URL(request.url).origin;
    const documentoId = parsearIdPositivo(body?.documento_id);
    const activar = body?.activar === true;
    if (!documentoId) return json({ ok: false, error: "Debes indicar un documento válido." }, 400);

    const documento = await obtenerDocumentoObjetivo(env, session.usuario_id, documentoId);
    if (!documento) return json({ ok: false, error: "No se encontró el documento solicitado." }, 404);

    await env.DB.prepare(`
      UPDATE admin_documentos_comunes
      SET activo = ?, fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(activar ? 1 : 0, documentoId).run();

    const impacto = await recalcularImpactoSecretaria(env, session.usuario_id, baseUrl, activar ? "documento_activado" : "documentos_actualizados");
    return json({
      ok: true,
      mensaje: activar ? "Documento activado correctamente." : "Documento desactivado correctamente.",
      documento_id: documentoId,
      activo: activar,
      impacto_reservas: impacto
    });
  } catch (error) {
    return json({ ok: false, error: "No se pudo actualizar el estado del documento de la secretaría.", detalle: error.message }, 500);
  }
}
