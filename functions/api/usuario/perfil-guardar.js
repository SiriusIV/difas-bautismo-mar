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

function esTelefonoValido(telefono) {
  const valor = String(telefono || "").replace(/\s+/g, "");
  return /^\+?[0-9]{9,15}$/.test(valor);
}

function letraDni(numero) {
  const letras = "TRWAGMYFPDXBNJZSQVHLCKE";
  return letras[numero % 23];
}

function esDocumentoValido(tipo, documento) {
  const t = String(tipo || "").toUpperCase();
  const d = String(documento || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (t === "DNI_NIF") {
    if (!/^[0-9]{8}[A-Z]$/.test(d)) return false;
    return letraDni(parseInt(d.slice(0, 8), 10)) === d.slice(-1);
  }

  if (t === "NIE") {
    if (!/^[XYZ][0-9]{7}[A-Z]$/.test(d)) return false;
    const mapa = { X: "0", Y: "1", Z: "2" };
    const numero = parseInt(mapa[d[0]] + d.slice(1, 8), 10);
    return letraDni(numero) === d.slice(-1);
  }

  if (t === "CIF") {
    return /^[A-Z][0-9]{7}[A-Z0-9]$/.test(d);
  }

  return false;
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

function esTipoDocumentoValido(tipo) {
  return ["DNI_NIF", "NIE", "CIF"].includes(String(tipo || "").toUpperCase());
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
    const nombrePublicoRecibido = limpiarTexto(body.nombre_publico);
    const localidadRecibida = limpiarTexto(body.localidad);
    const email = limpiarTexto(body.email).toLowerCase();
    const telefono_contacto = limpiarTexto(body.telefono_contacto);
    const webExternaRecibida = limpiarTexto(body.web_externa_url);
    const webExternaActivaRecibida = Number(body.web_externa_activa || 0) === 1 ? 1 : 0;
    const logo_url_recibido = normalizarNullable(body.logo_url);
    const responsableLegalRecibido = limpiarTexto(body.responsable_legal);
    const tipoDocumentoRecibido = limpiarTexto(body.tipo_documento).toUpperCase();
    const documentoIdentificacionRecibido = limpiarTexto(body.documento_identificacion).toUpperCase();

    if (!email) {
      return json({ ok: false, error: "Faltan campos obligatorios" }, 400);
    }

    if (!esEmailValido(email)) {
      return json({ ok: false, error: "El email no es valido" }, 400);
    }

    if (!esTelefonoValido(telefono_contacto)) {
      return json({ ok: false, error: "El telefono no es valido" }, 400);
    }

    if (!esUrlValidaOpcional(webExternaRecibida)) {
      return json({ ok: false, error: "La web externa no es valida" }, 400);
    }

    let user = null;
    try {
      user = await env.DB.prepare(`
        SELECT
          id,
          nombre,
          nombre_publico,
          localidad,
          centro,
          email,
          rol,
          responsable_legal,
          tipo_documento,
          documento_identificacion,
          logo_url,
          web_externa_url,
          web_externa_activa
        FROM usuarios
        WHERE id = ?
        LIMIT 1
      `).bind(session.id).first();
    } catch (_) {
      user = await env.DB.prepare(`
        SELECT
          id,
          nombre,
          nombre_publico,
          localidad,
          centro,
          email,
          rol,
          responsable_legal,
          tipo_documento,
          documento_identificacion,
          logo_url,
          web_externa_url
        FROM usuarios
        WHERE id = ?
        LIMIT 1
      `).bind(session.id).first();
    }

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

    const centro = user.centro == null ? null : String(user.centro);
    const esAdmin = user.rol === "ADMIN";
    const esSecretaria = user.rol === "SECRETARIA";
    const esSuperadmin = user.rol === "SUPERADMIN";
    const esSolicitante = user.rol === "SOLICITANTE";
    const esPerfilOrganizador = esAdmin || esSecretaria;

    const nombre = esSolicitante
      ? centro
      : (nombreRecibido || user.nombre || "");

    const nombre_publico = esPerfilOrganizador
      ? (nombrePublicoRecibido || "")
      : (user.nombre_publico || "");

    const localidad = localidadRecibida || "";

    const responsable_legal = esSolicitante
      ? responsableLegalRecibido
      : (user.responsable_legal || "");

    const tipo_documento = esSolicitante
      ? tipoDocumentoRecibido
      : (user.tipo_documento || "");

    const documento_identificacion = esSolicitante
      ? documentoIdentificacionRecibido
      : (user.documento_identificacion || "");

    if (!nombre && (esPerfilOrganizador || esSuperadmin)) {
      return json({ ok: false, error: "El nombre es obligatorio" }, 400);
    }

    if (esSolicitante) {
      if (!responsable_legal) {
        return json({ ok: false, error: "El responsable legal o titular es obligatorio" }, 400);
      }

      if (!esTipoDocumentoValido(tipo_documento)) {
        return json({ ok: false, error: "Debe seleccionar un tipo de documento valido" }, 400);
      }

      if (!documento_identificacion) {
        return json({ ok: false, error: "El documento identificativo es obligatorio" }, 400);
      }

      if (!esDocumentoValido(tipo_documento, documento_identificacion)) {
        return json({ ok: false, error: "El documento no coincide con el tipo seleccionado" }, 400);
      }
    }

    const web_externa_url = esPerfilOrganizador ? webExternaRecibida : "";
    const web_externa_activa = esPerfilOrganizador ? webExternaActivaRecibida : 0;
    const logo_url = esPerfilOrganizador ? logo_url_recibido : "";

    try {
      await env.DB.prepare(`
        UPDATE usuarios
        SET
          nombre = ?,
          nombre_publico = ?,
          localidad = ?,
          centro = ?,
          email = ?,
          telefono_contacto = ?,
          responsable_legal = ?,
          tipo_documento = ?,
          documento_identificacion = ?,
          web_externa_url = ?,
          web_externa_activa = ?,
          logo_url = ?
        WHERE id = ?
      `).bind(
        nombre,
        nombre_publico,
        localidad,
        centro,
        email,
        telefono_contacto,
        responsable_legal,
        tipo_documento,
        documento_identificacion,
        web_externa_url,
        web_externa_activa,
        logo_url,
        user.id
      ).run();
    } catch (_) {
      await env.DB.prepare(`
        UPDATE usuarios
        SET
          nombre = ?,
          nombre_publico = ?,
          localidad = ?,
          centro = ?,
          email = ?,
          telefono_contacto = ?,
          responsable_legal = ?,
          tipo_documento = ?,
        documento_identificacion = ?,
        web_externa_url = ?,
        logo_url = ?
        WHERE id = ?
      `).bind(
        nombre,
        nombre_publico,
        localidad,
        centro,
        email,
        telefono_contacto,
        responsable_legal,
        tipo_documento,
        documento_identificacion,
        web_externa_url,
        logo_url,
        user.id
      ).run();
    }

    let perfil = null;
    const webExternaActivaRespuesta = web_externa_activa;
    try {
      perfil = await env.DB.prepare(`
        SELECT
          id,
          nombre,
          nombre_publico,
          localidad,
          centro,
          email,
          telefono_contacto,
          responsable_legal,
          tipo_documento,
          documento_identificacion,
          web_externa_url,
          web_externa_activa,
          logo_url,
          rol
        FROM usuarios
        WHERE id = ?
        LIMIT 1
      `).bind(user.id).first();
    } catch (_) {
      perfil = await env.DB.prepare(`
        SELECT
          id,
          nombre,
          nombre_publico,
          localidad,
          centro,
          email,
          telefono_contacto,
          responsable_legal,
          tipo_documento,
          documento_identificacion,
          web_externa_url,
          logo_url,
          rol
        FROM usuarios
        WHERE id = ?
        LIMIT 1
      `).bind(user.id).first();
    }

    const cookie = await createSessionCookie(
      {
        id: perfil.id,
        nombre: perfil.nombre || "",
        nombre_publico: perfil.nombre_publico || "",
        localidad: perfil.localidad || "",
        centro: perfil.centro || "",
        email: perfil.email || "",
        rol: perfil.rol || "",
        responsable_legal: perfil.responsable_legal || "",
        tipo_documento: perfil.tipo_documento || "",
        documento_identificacion: perfil.documento_identificacion || "",
        logo_url: perfil.logo_url || "",
        web_externa_url: perfil.web_externa_url || "",
        web_externa_activa: Number(perfil.web_externa_activa ?? webExternaActivaRespuesta ?? 0)
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
          nombre_publico: perfil.nombre_publico || "",
          localidad: perfil.localidad || "",
          centro: perfil.centro || "",
          email: perfil.email || "",
          telefono_contacto: perfil.telefono_contacto || "",
          responsable_legal: perfil.responsable_legal || "",
          tipo_documento: perfil.tipo_documento || "",
          documento_identificacion: perfil.documento_identificacion || "",
          web_externa_url: perfil.web_externa_url || "",
          web_externa_activa: Number(perfil.web_externa_activa ?? webExternaActivaRespuesta ?? 0),
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
