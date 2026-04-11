function respuestaError(texto, status = 404) {
  return new Response(texto, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    if (!env.DOCS_BUCKET) {
      return respuestaError("No está configurado el repositorio de documentos.", 500);
    }

    const url = new URL(request.url);
    const key = String(url.searchParams.get("key") || "").trim();

    if (!key) {
      return respuestaError("Documento no encontrado.", 404);
    }

    const objeto = await env.DOCS_BUCKET.get(key);
    if (!objeto) {
      return respuestaError("Documento no encontrado.", 404);
    }

    const headers = new Headers();
    objeto.writeHttpMetadata(headers);
    headers.set("etag", objeto.httpEtag);
    headers.set("Cache-Control", "public, max-age=3600");

    if (!headers.get("Content-Type")) {
      headers.set("Content-Type", "application/pdf");
    }

    return new Response(objeto.body, {
      status: 200,
      headers
    });
  } catch (error) {
    return respuestaError(error?.message || "No se pudo recuperar el documento.", 500);
  }
}
