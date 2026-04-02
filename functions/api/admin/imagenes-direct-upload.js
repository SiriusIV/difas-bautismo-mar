export async function onRequestPost(context) {
  const { request, env } = context;

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  // 1. Pedir URL de subida directa a Cloudflare
  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v2/direct_upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    }
  );

  const cfData = await cfRes.json();

  if (!cfData.success) {
    return new Response(JSON.stringify({ error: "Error generando upload URL" }), {
      status: 500,
    });
  }

  const uploadURL = cfData.result.uploadURL;
  const imageId = cfData.result.id;

  // 2. Construir URL pública (IMPORTANTE)
  const imageURL = `https://imagedelivery.net/${env.CLOUDFLARE_ACCOUNT_HASH}/${imageId}/public`;

  // 3. Devolver TODO al frontend
  return new Response(
    JSON.stringify({
      uploadURL,
      imageId,   // ← NUEVO (clave para poder borrar)
      imageURL,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}
