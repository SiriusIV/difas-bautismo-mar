import { createSessionCookie, getUserSession } from "./_auth.js";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function esEmailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function esUrlValidaOpcional(url) {
  if (!url) return true;

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizarNullable(valor) {
  const v = String(valor || "").trim();
  return v === "" ? "" : v;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);

    if (!session || !session.id) {
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    const body = await request.json();

    const nombreRecibido = limpiarTexto(body.nombre);
    const email = limpiarTexto(body.email).toLowerCase();
    const telefono_contacto = limpiarTexto(body.telefono_contacto);
    const webExternaRecibida = limpiarTexto(body.web_externa_url);
    const logo_url_recibido = normalizarNullable(body.logo_url);

    if (!email) {
      return json({ ok: false, error: "Faltan campos obligatorios" }, 400);
    }

    if (!esEmailValido(email)) {
      return json({ ok: false, error: "El email no es valido" }, 400);
    }

    if (!esUrlValidaOpcional(webExternaRecibida)) {
      return json({ ok: false, error: "La web externa no es valida" }, 400);
    }

    const user = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        centro,
        email,
        rol,
        logo_url,
        web_externa_url
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(session.id).first();

    if (!user) {
      return json({ ok: false, error: "Usuario no encontrado" }, 404);
    }

    const existeEmail = await env.DB.prepare(`
      SELECT id
      FROM usuarios
      WHERE lower(email) = ?
        AND id <> ?
      LIMIT 1
    `).bind(email, user.id).first();

    if (existeEmail) {
      return json({ ok: false, error: "Email ya registrado" }, 400);
    }

    const centro = user.centro || "";
    const esAdmin = user.rol === "ADMIN";
    const esSuperadmin = user.rol === "SUPERADMIN";
    const esSolicitante = user.rol === "SOLICITANTE";

    const nombre = esSolicitante
      ? centro
      : (nombreRecibido || user.nombre || "");

    if (!nombre && (esAdmin || esSuperadmin)) {
      return json({ ok: false, error: "El nombre es obligatorio" }, 400);
    }

    const web_externa_url = esAdmin ? webExternaRecibida : "";
    const logo_url = esAdmin ? logo_url_recibido : "";

    await env.DB.prepare(`
      UPDATE usuarios
      SET
        nombre = ?,
        centro = ?,
        email = ?,
        telefono_contacto = ?,
        web_externa_url = ?,
        logo_url = ?
      WHERE id = ?
    `).bind(
      nombre,
      centro,
      email,
      telefono_contacto,
      web_externa_url,
      logo_url,
      user.id
    ).run();

    const perfil = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        centro,
        email,
        telefono_contacto,
        web_externa_url,
        logo_url,
        rol
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(user.id).first();

    const cookie = await createSessionCookie(
      {
        id: perfil.id,
        nombre: perfil.nombre || "",
        centro: perfil.centro || "",
        email: perfil.email || "",
        rol: perfil.rol || "",
        logo_url: perfil.logo_url || "",
        web_externa_url: perfil.web_externa_url || ""
      },
      env.SECRET_KEY
    );

    return json(
      {
        ok: true,
        mensaje: "Perfil actualizado correctamente",
        perfil: {
          id: perfil.id,
          nombre: perfil.nombre || "",
          centro: perfil.centro || "",
          email: perfil.email || "",
          telefono_contacto: perfil.telefono_contacto || "",
          web_externa_url: perfil.web_externa_url || "",
          logo_url: perfil.logo_url || "",
          rol: perfil.rol || ""
        }
      },
      200,
      { "Set-Cookie": cookie }
    );
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al guardar el perfil",
        detalle: error.message
      },
      500
    );
  }
}
