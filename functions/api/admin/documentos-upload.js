import { getAdminSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function sanitizarSegmento(valor = "") {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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

    const formData = await request.formData();
    const file = formData.get("file");
    const nombreDocumento = limpiarTexto(formData.get("nombre_documento"));

    if (!(file instanceof File)) {
      return json({ ok: false, error: "Debes adjuntar un archivo PDF válido." }, 400);
    }

    if (!nombreDocumento) {
      return json({ ok: false, error: "Indica antes el nombre del documento." }, 400);
    }

    const contentType = String(file.type || "").toLowerCase();
    const nombreArchivo = String(file.name || "").toLowerCase();

    if (contentType !== "application/pdf" && !nombreArchivo.endsWith(".pdf")) {
      return json({ ok: false, error: "Solo se admiten documentos PDF." }, 400);
    }

    const nombreSeguro = sanitizarSegmento(nombreDocumento) || "documento";
    const key = `documentos/admin-${session.usuario_id}/${nombreSeguro}.pdf`;
    const buffer = await file.arrayBuffer();

    await env.DOCS_BUCKET.put(key, buffer, {
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: `inline; filename="${nombreSeguro}.pdf"`
      },
      customMetadata: {
        admin_id: String(session.usuario_id),
        nombre_documento: nombreDocumento,
        original_filename: String(file.name || "")
      }
    });

    return json({
      ok: true,
      mensaje: "Documento PDF subido correctamente.",
      key,
      archivo_url: `/api/documentos?key=${encodeURIComponent(key)}`,
      nombre_documento: nombreDocumento
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al subir el documento PDF.",
        detalle: error?.message || String(error)
      },
      500
    );
  }
}
