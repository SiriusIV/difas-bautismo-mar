import { getUserSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
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
    const base = texto.startsWith("http://") || texto.startsWith("https://")
      ? texto
      : `https://local${texto.startsWith("/") ? "" : "/"}${texto}`;
    const url = new URL(base);
    const key = String(url.searchParams.get("key") || "").trim();
    return key || null;
  } catch {
    return null;
  }
}

async function obtenerUsuarioSolicitante(env, userId) {
  return await env.DB.prepare(`
    SELECT id, rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first();
}

async function obtenerArchivoPorDocumento(env, centroUsuarioId, documentoId) {
  return await env.DB.prepare(`
    SELECT
      a.id,
      a.documentacion_id,
      a.nombre_documento,
      a.archivo_url
    FROM centro_admin_documentacion_archivos a
    INNER JOIN centro_admin_documentacion d ON d.id = a.documentacion_id
    INNER JOIN admin_documentos_comunes c
      ON c.admin_id = d.admin_id
     AND c.nombre = a.nombre_documento
     AND c.id = ?
    WHERE d.centro_usuario_id = ?
      AND a.activo = 1
    LIMIT 1
  `).bind(documentoId, centroUsuarioId).first();
}

async function obtenerArchivoPorId(env, centroUsuarioId, archivoId) {
  return await env.DB.prepare(`
    SELECT
      a.id,
      a.documentacion_id,
      a.nombre_documento,
      a.archivo_url
    FROM centro_admin_documentacion_archivos a
    INNER JOIN centro_admin_documentacion d ON d.id = a.documentacion_id
    WHERE a.id = ?
      AND d.centro_usuario_id = ?
    LIMIT 1
  `).bind(archivoId, centroUsuarioId).first();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    if (!session?.id) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    if (!env.DOCS_BUCKET) {
      return json(
        {
          ok: false,
          error: "Falta configurar el binding DOCS_BUCKET en Cloudflare Pages."
        },
        500
      );
    }

    const usuario = await obtenerUsuarioSolicitante(env, session.id);
    if (!usuario || usuario.rol !== "SOLICITANTE") {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    const body = await request.json().catch(() => null);
    const documentoId = parsearIdPositivo(body?.documento_id);
    const archivoId = parsearIdPositivo(body?.archivo_id);

    if (!documentoId && !archivoId) {
      return json({ ok: false, error: "Debes indicar un documento válido." }, 400);
    }

    const archivo = archivoId
      ? await obtenerArchivoPorId(env, usuario.id, archivoId)
      : await obtenerArchivoPorDocumento(env, usuario.id, documentoId);
    if (!archivo) {
      return json({ ok: false, error: "No se encontró un documento remitido para eliminar." }, 404);
    }

    const key = extraerKeyDesdeArchivoUrl(archivo.archivo_url);
    if (key) {
      await env.DOCS_BUCKET.delete(key);
    }

    await env.DB.prepare(`
      DELETE FROM centro_admin_documentacion_archivos
      WHERE id = ?
    `).bind(archivo.id).run();

    return json({
      ok: true,
      mensaje: "Documento remitido eliminado correctamente.",
      documento_id: documentoId || null,
      archivo_id: archivo.id,
      archivo_eliminado: Boolean(key)
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo eliminar el documento remitido.",
        detalle: error?.message || String(error)
      },
      500
    );
  }
}
