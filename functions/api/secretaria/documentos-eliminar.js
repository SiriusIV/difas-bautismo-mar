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

function extraerKeyDesdeArchivoUrl(archivoUrl) {
  const texto = String(archivoUrl || "").trim();
  if (!texto) return null;
  try {
    const base = texto.startsWith("http://") || texto.startsWith("https://") ? texto : `https://local${texto.startsWith("/") ? "" : "/"}${texto}`;
    const url = new URL(base);
    return String(url.searchParams.get("key") || "").trim() || null;
  } catch {
    return null;
  }
}

async function obtenerDocumentoObjetivo(env, secretariaId, documentoId) {
  return await env.DB.prepare(`
    SELECT id, admin_id, nombre, archivo_url
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
    if (!env.DOCS_BUCKET) return json({ ok: false, error: "Falta configurar DOCS_BUCKET." }, 500);

    const body = await request.json().catch(() => null);
    const baseUrl = new URL(request.url).origin;
    const documentoId = parsearIdPositivo(body?.documento_id);
    if (!documentoId) return json({ ok: false, error: "Debes indicar un documento válido." }, 400);

    const documento = await obtenerDocumentoObjetivo(env, session.usuario_id, documentoId);
    if (!documento) return json({ ok: false, error: "No se encontró el documento solicitado." }, 404);

    const key = extraerKeyDesdeArchivoUrl(documento.archivo_url);
    if (key) await env.DOCS_BUCKET.delete(key);

    await env.DB.prepare(`DELETE FROM admin_documentos_comunes WHERE id = ?`).bind(documentoId).run();

    const impacto = await recalcularImpactoSecretaria(env, session.usuario_id, baseUrl, "documento_eliminado");
    return json({
      ok: true,
      mensaje: "Documento eliminado correctamente.",
      documento_id: documentoId,
      impacto_reservas: impacto
    });
  } catch (error) {
    return json({ ok: false, error: "No se pudo eliminar el documento de la secretaría.", detalle: error.message }, 500);
  }
}
