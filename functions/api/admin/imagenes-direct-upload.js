import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";

function json(data, init = 200) {
  const status = typeof init === "number" ? init : (init.status || 200);
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function sanitizeFilename(name = "") {
  return String(name)
    .trim()
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1. Autenticación
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const rol = await getRolUsuario(env, session.usuario_id);
    if (rol !== "ADMIN" && rol !== "SUPERADMIN") {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    // 2. Validación configuración Cloudflare
    if (!env.CF_IMAGES_ACCOUNT_ID || !env.CF_IMAGES_API_TOKEN || !env.CF_IMAGES_DELIVERY_HASH) {
      return json(
        {
          ok: false,
          error: "Falta configurar CF_IMAGES_ACCOUNT_ID, CF_IMAGES_API_TOKEN o CF_IMAGES_DELIVERY_HASH."
        },
        500
      );
    }

    // 3. Datos de entrada
    const body = await request.json().catch(() => ({}));
    const filename = sanitizeFilename(body.filename || "actividad");
    const actividadId = body.actividad_id ? String(body.actividad_id) : "";
    const contentType = String(body.content_type || "");

    // 4. Metadata (útil para auditoría futura)
    const metadata = {
      origen: "admin-actividades",
      actividad_id: actividadId,
      filename,
      usuario_id: String(session.usuario_id),
      content_type: contentType
    };

    const form = new FormData();
    form.append("requireSignedURLs", "false");
    form.append("metadata", JSON.stringify(metadata));

    // 5. Petición a Cloudflare Images
    const cfResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_IMAGES_ACCOUNT_ID}/images/v2/direct_upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CF_IMAGES_API_TOKEN}`
        },
        body: form
      }
    );

    const cfData = await cfResp.json();

    if (!cfResp.ok || !cfData?.success || !cfData?.result?.uploadURL || !cfData?.result?.id) {
      return json(
        {
          ok: false,
          error: "No se pudo crear la subida directa de imagen.",
          detalle: cfData?.errors || cfData || null
        },
        502
      );
    }

    // 6. Datos clave
    const imageId = cfData.result.id;
    const uploadURL = cfData.result.uploadURL;
    const publicBase = `https://imagedelivery.net/${env.CF_IMAGES_DELIVERY_HASH}/${imageId}`;

    // 7. Respuesta final (IMPORTANTE)
    return json({
      ok: true,
      image_id: imageId,                       // ← CLAVE para borrado
      upload_url: uploadURL,
      image_url: `${publicBase}/public`,       // ← imagen final
      image_url_thumbnail: `${publicBase}/w=600`
    });

  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error interno al preparar la subida de imagen.",
        detalle: error?.message || String(error)
      },
      500
    );
  }
}
