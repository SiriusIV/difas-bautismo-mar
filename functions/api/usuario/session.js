import { getUserSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const session = await getUserSession(request, env.SECRET_KEY);

  if (!session) {
    return json({
      ok: false,
      authenticated: false
    }, 401);
  }

  return json({
    ok: true,
    authenticated: true,
    user: session
  });
}
