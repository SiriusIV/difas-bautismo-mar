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

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const rol = await getRolUsuario(env, session.usuario_id);
    if (rol !== "ADMIN" && rol !== "SUPERADMIN") {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    if (!env.CF_IMAGES_ACCOUNT_ID || !env.CF_IMAGES_API_TOKEN) {
      return json(
        {
          ok: false,
          error: "Falta configurar CF_IMAGES_ACCOUNT_ID o CF_IMAGES_API_TOKEN."
        },
        500
      );
    }

    const body = await request.json().catch(() => ({}));
    const imageId = String(body.image_id || "").trim();

    if (!imageId) {
      return json({ ok: false, error: "Falta image_id." }, 400);
    }

    const cfResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_IMAGES_ACCOUNT_ID}/images/v1/${encodeURIComponent(imageId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${env.CF_IMAGES_API_TOKEN}`
        }
      }
    );

    const cfData = await cfResp.json().catch(() => null);

    if (!cfResp.ok || !cfData?.success) {
      return json(
        {
          ok: false,
          error: "No se pudo eliminar la imagen en Cloudflare.",
          detalle: cfData?.errors || cfData || null
        },
        502
      );
    }

    return json({
      ok: true,
      mensaje: "Imagen eliminada correctamente.",
      image_id: imageId
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error interno al eliminar la imagen.",
        detalle: error?.message || String(error)
      },
      500
    );
  }
}
