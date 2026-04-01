function json(data, init = 200) {
  const status = typeof init === "number" ? init : (init.status || 200);
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function getAdminSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)session_id=([^;]+)/);
  if (!match) return null;

  const sessionId = decodeURIComponent(match[1]);

  const session = await env.DB.prepare(`
    SELECT s.id, s.usuario_id, u.email, u.nombre, u.rol
    FROM sesiones s
    JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.id = ?
      AND s.activa = 1
      AND (s.expira_en IS NULL OR s.expira_en > datetime('now'))
    LIMIT 1
  `).bind(sessionId).first();

  if (!session) return null;

  const rol = String(session.rol || "").toUpperCase();
  if (rol !== "ADMIN" && rol !== "SUPERADMIN") return null;

  return session;
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
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    if (!env.CF_IMAGES_ACCOUNT_ID || !env.CF_IMAGES_API_TOKEN || !env.CF_IMAGES_DELIVERY_HASH) {
      return json(
        {
          ok: false,
          error: "Falta configurar CF_IMAGES_ACCOUNT_ID, CF_IMAGES_API_TOKEN o CF_IMAGES_DELIVERY_HASH."
        },
        500
      );
    }

    const body = await request.json().catch(() => ({}));
    const filename = sanitizeFilename(body.filename || "actividad");
    const actividadId = body.actividad_id ? String(body.actividad_id) : "";
    const contentType = String(body.content_type || "");

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

    const imageId = cfData.result.id;
    const uploadURL = cfData.result.uploadURL;
    const publicBase = `https://imagedelivery.net/${env.CF_IMAGES_DELIVERY_HASH}/${imageId}`;

    return json({
      ok: true,
      image_id: imageId,
      upload_url: uploadURL,
      image_url: `${publicBase}/public`,
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
