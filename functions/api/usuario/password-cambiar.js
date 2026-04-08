import { getUserSession } from "./_auth.js";

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

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);

    if (!session || !session.id) {
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    const body = await request.json();
    const passwordActual = limpiarTexto(body.password_actual);
    const passwordNueva = limpiarTexto(body.password_nueva);

    if (!passwordActual || !passwordNueva) {
      return json({ ok: false, error: "Faltan datos obligatorios" }, 400);
    }

    const user = await env.DB.prepare(`
      SELECT
        id,
        password_hash
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(session.id).first();

    if (!user) {
      return json({ ok: false, error: "Usuario no encontrado" }, 404);
    }

    const actualHash = await hashPassword(passwordActual);

    if (String(user.password_hash || "") !== actualHash) {
      return json({ ok: false, error: "La contraseña actual no es correcta" }, 400);
    }

    const nuevaHash = await hashPassword(passwordNueva);

    await env.DB.prepare(`
      UPDATE usuarios
      SET password_hash = ?
      WHERE id = ?
    `).bind(nuevaHash, user.id).run();

    return json({
      ok: true,
      mensaje: "Contraseña actualizada correctamente"
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al cambiar la contraseña",
        detalle: error.message
      },
      500
    );
  }
}
