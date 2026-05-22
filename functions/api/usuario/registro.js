import { createSessionCookie } from "./_auth.js";
import {
  hashPassword,
  mensajePoliticaPassword,
  validarPoliticaPassword
} from "./_password.js";
import {
  asegurarTablaSolicitudesArmada,
  normalizarCentro
} from "../admin/_solicitudes_armada.js";

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

function esTipoDocumentoValido(tipo) {
  return ["DNI_NIF", "NIE", "CIF"].includes(String(tipo || "").toUpperCase());
}

function validarDocumentoDetallado(tipo, documento) {
  const t = String(tipo || "").toUpperCase();
  const d = String(documento || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (t === "DNI_NIF") {
    if (!d) {
      return { ok: false, error: "Debes indicar el documento identificativo." };
    }
    if (d.length < 9) {
      return { ok: false, error: "El DNI/NIF debe tener 8 dígitos y 1 letra." };
    }
    if (d.length > 9) {
      return { ok: false, error: "El DNI/NIF no puede tener más de 8 dígitos y 1 letra." };
    }
    if (!/^[0-9]{8}[A-Z]$/.test(d)) {
      return { ok: false, error: "El DNI/NIF debe tener 8 dígitos seguidos de una letra." };
    }
    const letraEsperada = letraDni(parseInt(d.slice(0, 8), 10));
    if (letraEsperada !== d.slice(-1)) {
      return { ok: false, error: `La letra del DNI/NIF no es correcta. Debe ser ${letraEsperada}.` };
    }
    return { ok: true };
  }

  if (t === "NIE") {
    if (!d) {
      return { ok: false, error: "Debes indicar el documento identificativo." };
    }
    if (d.length < 9) {
      return { ok: false, error: "El NIE debe tener una letra inicial, 7 dígitos y una letra final." };
    }
    if (d.length > 9) {
      return { ok: false, error: "El NIE no puede tener más de una letra inicial, 7 dígitos y una letra final." };
    }
    if (!/^[XYZ][0-9]{7}[A-Z]$/.test(d)) {
      return { ok: false, error: "El NIE debe comenzar por X, Y o Z, seguir con 7 dígitos y terminar en letra." };
    }
    const mapa = { X: "0", Y: "1", Z: "2" };
    const numero = parseInt(mapa[d[0]] + d.slice(1, 8), 10);
    const letraEsperada = letraDni(numero);
    if (letraEsperada !== d.slice(-1)) {
      return { ok: false, error: `La letra del NIE no es correcta. Debe ser ${letraEsperada}.` };
    }
    return { ok: true };
  }

  if (t === "CIF") {
    if (!d) {
      return { ok: false, error: "Debes indicar el documento identificativo." };
    }
    if (d.length < 9) {
      return { ok: false, error: "El CIF debe tener 1 letra, 7 dígitos y 1 carácter de control." };
    }
    if (d.length > 9) {
      return { ok: false, error: "El CIF no puede tener más de 1 letra, 7 dígitos y 1 carácter de control." };
    }
    if (!/^[A-Z][0-9]{7}[A-Z0-9]$/.test(d)) {
      return { ok: false, error: "El CIF debe comenzar por una letra, seguir con 7 dígitos y terminar en carácter de control." };
    }
    return { ok: true };
  }

  return { ok: false, error: "Debe seleccionar un tipo de documento valido" };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;

  const body = await request.json();

  const tipo_cuenta = limpiarTexto(body.tipo_cuenta).toUpperCase() === "ARMADA"
    ? "ARMADA"
    : "PUBLICO";
  const centro = limpiarTexto(body.centro);
  const localidad = limpiarTexto(body.localidad);
  const responsable_legal = limpiarTexto(body.responsable_legal);
  const tipo_documento = limpiarTexto(body.tipo_documento).toUpperCase();
  const documento_identificacion = limpiarTexto(body.documento_identificacion).toUpperCase();
  const email = limpiarTexto(body.email).toLowerCase();
  const telefono_contacto = limpiarTexto(body.telefono_contacto);
  const password = String(body.password || "");
  const nombre = centro;

  if (!centro || !responsable_legal || !tipo_documento || !documento_identificacion || !email || !telefono_contacto || (tipo_cuenta === "PUBLICO" && !password)) {
    return json({ ok: false, error: "Faltan campos obligatorios" }, 400);
  }

  if (!esEmailValido(email)) {
    return json({ ok: false, error: "El email no es valido" }, 400);
  }

  if (!esTelefonoValido(telefono_contacto)) {
    return json({ ok: false, error: "El telefono no es valido" }, 400);
  }

  if (!esTipoDocumentoValido(tipo_documento)) {
    return json({ ok: false, error: "Debe seleccionar un tipo de documento valido" }, 400);
  }

  const validacionDocumento = validarDocumentoDetallado(tipo_documento, documento_identificacion);
  if (!validacionDocumento.ok) {
    return json({ ok: false, error: validacionDocumento.error || "El documento no coincide con el tipo seleccionado" }, 400);
  }

  if (tipo_cuenta === "PUBLICO") {
    const validacionPassword = validarPoliticaPassword(password);
    if (!validacionPassword.ok) {
      return json({
        ok: false,
        error: mensajePoliticaPassword(),
        detalles: validacionPassword.errores
      }, 400);
    }
  }

  // comprobar email existente
  const existingEmail = await db
    .prepare("SELECT id FROM usuarios WHERE email = ?")
    .bind(email)
    .first();

  if (existingEmail) {
    return json({ ok: false, error: "Email ya registrado" }, 400);
  }

  // comprobar centro existente solo entre solicitantes
  const existingCentro = await db
    .prepare("SELECT id FROM usuarios WHERE UPPER(TRIM(centro)) = ? AND rol = 'SOLICITANTE'")
    .bind(normalizarCentro(centro))
    .first();

  if (existingCentro) {
    return json({ ok: false, error: "Ya existe un usuario para ese centro" }, 400);
  }

  if (tipo_cuenta === "ARMADA") {
    await asegurarTablaSolicitudesArmada(db);

    const solicitudPendiente = await db.prepare(`
      SELECT id
      FROM solicitudes_registro_armada
      WHERE estado = 'PENDIENTE'
        AND (
          email = ?
          OR UPPER(TRIM(centro)) = ?
          OR UPPER(TRIM(documento_identificacion)) = ?
        )
      LIMIT 1
    `).bind(email, normalizarCentro(centro), documento_identificacion).first();

    if (solicitudPendiente) {
      return json({
        ok: false,
        error: "Ya existe una solicitud pendiente de Usuario Armada con esos datos."
      }, 400);
    }

    await db.prepare(`
      INSERT INTO solicitudes_registro_armada (
        centro,
        localidad,
        responsable_legal,
        tipo_documento,
        documento_identificacion,
        email,
        telefono_contacto,
        estado,
        fecha_solicitud
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', datetime('now'))
    `).bind(
      centro,
      localidad,
      responsable_legal,
      tipo_documento,
      documento_identificacion,
      email,
      telefono_contacto
    ).run();

    return json({
      ok: true,
      pendiente_aprobacion: true,
      mensaje: "Solicitud de Usuario Armada enviada correctamente. Queda pendiente de revisión por el superadministrador."
    });
  }

  const password_hash = await hashPassword(password);

  const result = await db
    .prepare(`
      INSERT INTO usuarios (
        nombre,
        centro,
        localidad,
        email,
        password_hash,
        rol,
        telefono_contacto,
        responsable_legal,
        tipo_documento,
        documento_identificacion,
        activo,
        fecha_alta
      )
      VALUES (?, ?, ?, ?, ?, 'SOLICITANTE', ?, ?, ?, ?, 1, datetime('now'))
    `)
    .bind(
      nombre,
      centro,
      localidad,
      email,
      password_hash,
      telefono_contacto,
      responsable_legal,
      tipo_documento,
      documento_identificacion
    )
    .run();

  const user = {
    id: result.meta.last_row_id,
    nombre,
    centro,
    localidad,
    email,
    telefono_contacto,
    responsable_legal,
    tipo_documento,
    documento_identificacion,
    logo_url: "",
    web_externa_url: "",
    rol: "SOLICITANTE"
  };

  const cookie = await createSessionCookie(user, env.SECRET_KEY);

  return json(
    { ok: true, user },
    200,
    { "Set-Cookie": cookie }
  );
}
