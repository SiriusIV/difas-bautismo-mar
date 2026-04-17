import { getAdminSession } from "./_auth.js";
import { recalcularImpactoDocumentalReservas } from "../_impacto_documental_reservas.js";

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

async function obtenerDocumentoObjetivo(env, session, documentoId) {
  if (session.rol === "SUPERADMIN") {
    return await env.DB.prepare(`
      SELECT id, admin_id, nombre, archivo_url
      FROM admin_documentos_comunes
      WHERE id = ?
      LIMIT 1
    `).bind(documentoId).first();
  }

  return await env.DB.prepare(`
    SELECT id, admin_id, nombre, archivo_url
    FROM admin_documentos_comunes
    WHERE id = ?
      AND admin_id = ?
    LIMIT 1
  `).bind(documentoId, session.usuario_id).first();
}

async function obtenerArchivosRelacionados(env, adminId, nombreDocumento) {
  const rows = await env.DB.prepare(`
    SELECT
      a.id,
      a.archivo_url
    FROM centro_admin_documentacion_archivos a
    INNER JOIN centro_admin_documentacion d ON d.id = a.documentacion_id
    WHERE d.admin_id = ?
      AND TRIM(a.nombre_documento) = TRIM(?)
  `).bind(adminId, nombreDocumento).all();

  return rows?.results || [];
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
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

    const body = await request.json().catch(() => null);
    const baseUrl = new URL(request.url).origin;
    const documentoId = parsearIdPositivo(body?.documento_id);

    if (!documentoId) {
      return json({ ok: false, error: "Debes indicar un documento válido." }, 400);
    }

    const documento = await obtenerDocumentoObjetivo(env, session, documentoId);
    if (!documento) {
      return json({ ok: false, error: "No se encontró el documento solicitado." }, 404);
    }

    const archivosRelacionados = await obtenerArchivosRelacionados(env, documento.admin_id, documento.nombre);
    const key = extraerKeyDesdeArchivoUrl(documento.archivo_url);
    if (key) {
      await env.DOCS_BUCKET.delete(key);
    }

    for (const archivo of archivosRelacionados) {
      const archivoKey = extraerKeyDesdeArchivoUrl(archivo.archivo_url);
      if (archivoKey) {
        await env.DOCS_BUCKET.delete(archivoKey);
      }
    }

    if (archivosRelacionados.length) {
      await env.DB.prepare(`
        DELETE FROM centro_admin_documentacion_archivos
        WHERE id IN (
          SELECT a.id
          FROM centro_admin_documentacion_archivos a
          INNER JOIN centro_admin_documentacion d ON d.id = a.documentacion_id
          WHERE d.admin_id = ?
            AND TRIM(a.nombre_documento) = TRIM(?)
        )
      `).bind(documento.admin_id, documento.nombre).run();
    }

    await env.DB.prepare(`
      DELETE FROM admin_documentos_comunes
      WHERE id = ?
    `).bind(documentoId).run();

    const impactoReservas = await recalcularImpactoDocumentalReservas(env, {
      adminId: Number(documento.admin_id || 0),
      baseUrl,
      motivo: "documento_eliminado"
    });

    return json({
      ok: true,
      mensaje: "Documento eliminado correctamente.",
      documento_id: documentoId,
      admin_id: documento.admin_id,
      nombre: documento.nombre,
      archivo_eliminado: Boolean(key),
      remisiones_eliminadas: archivosRelacionados.length,
      impacto_reservas: impactoReservas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo eliminar el documento.",
        detalle: error?.message || String(error)
      },
      500
    );
  }
}
