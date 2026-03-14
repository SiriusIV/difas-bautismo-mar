import { getAdminSession } from "./_auth.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    ...init
  });
}

export async function onRequestGet(context) {
  const session = await getAdminSession(context.request, context.env);

  if (!session) {
    return json(
      {
        ok: false,
        authenticated: false
      },
      { status: 401 }
    );
  }

  return json({
    ok: true,
    authenticated: true,
    user: {
      username: session.username
    }
  });
}
