import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import { hashPassword, validarPoliticaPassword } from "../usuario/_password.js";
import { enviarEmail } from "../_email.js";
import { crearNotificacion } from "../_notificaciones.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function esEmailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function esTelefonoValidoOpcional(telefono) {
  const valor = String(telefono || "").replace(/\s+/g, "");
  return !valor || /^\+?[0-9]{9,15}$/.test(valor);
}

function esTelefonoRpvValidoOpcional(telefono) {
  const valor = String(telefono || "").replace(/\s+/g, "");
  return !valor || /^[0-9]{7}$/.test(valor);
}

function generarPasswordTemporal() {
  const may = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const min = "abcdefghijkmnopqrstuvwxyz";
  const num = "23456789";
  const sym = "!@#$%&*?";
  const todas = may + min + num + sym;
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  let valor = pick(may) + pick(min) + pick(num) + pick(sym);
  while (valor.length < 12) valor += pick(todas);
  valor = valor.split("").sort(() => Math.random() - 0.5).join("");
  if (!validarPoliticaPassword(valor).ok) return generarPasswordTemporal();
  return valor;
}

async function asegurarColumnaUsuario(db, nombre, definicion) {
  try {
    await db.prepare(`ALTER TABLE usuarios ADD COLUMN ${nombre} ${definicion}`).run();
  } catch (error) {
    const detalle = String(error?.message || "").toLowerCase();
    if (
      detalle.includes("duplicate column name") ||
      detalle.includes("already exists") ||
      detalle.includes("duplicate")
    ) {
      return;
    }
    throw error;
  }
}

async function obtenerSecretariasDeAdmin(env, adminId) {
  const rows = await env.DB.prepare(`
    SELECT
      id,
      nombre,
      nombre_publico,
      email,
      telefono_contacto,
      localidad,
      activo,
      fecha_alta
    FROM usuarios
    WHERE rol = 'SECRETARIA'
      AND secretaria_admin_creador_id = ?
      AND COALESCE(secretaria_onboarding_completo, 0) = 1
    ORDER BY
      CASE
        WHEN nombre_publico IS NOT NULL AND TRIM(nombre_publico) <> '' THEN TRIM(nombre_publico)
        ELSE TRIM(nombre)
      END COLLATE NOCASE ASC,
      id ASC
  `).bind(adminId).all();
  return rows?.results || [];
}

async function obtenerAdmin(env, adminId) {
  return await env.DB.prepare(`
    SELECT id, nombre, nombre_publico, email
    FROM usuarios
    WHERE id = ?
      AND rol = 'ADMIN'
    LIMIT 1
  `).bind(adminId).first();
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    await asegurarColumnaUsuario(env.DB, "secretaria_admin_creador_id", "INTEGER");
    await asegurarColumnaUsuario(env.DB, "secretaria_onboarding_completo", "INTEGER NOT NULL DEFAULT 0");
    const session = await getAdminSession(request, env);
    if (!session) return json({ ok: false, error: "No autorizado." }, 401);
    const rol = await getRolUsuario(env, session.usuario_id);
    if (String(rol || "").toUpperCase() !== "ADMIN") {
      return json({ ok: false, error: "Solo disponible para administradores." }, 403);
    }
    const secretarias = await obtenerSecretariasDeAdmin(env, Number(session.usuario_id || 0));
    return json({ ok: true, secretarias });
  } catch (error) {
    return json({ ok: false, error: "No se pudieron cargar las cuentas de secretarÃ­a.", detalle: error.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    await asegurarColumnaUsuario(env.DB, "secretaria_admin_creador_id", "INTEGER");
    await asegurarColumnaUsuario(env.DB, "secretaria_onboarding_completo", "INTEGER NOT NULL DEFAULT 0");
    await asegurarColumnaUsuario(env.DB, "telefono_rpv", "TEXT");
    const session = await getAdminSession(request, env);
    if (!session) return json({ ok: false, error: "No autorizado." }, 401);
    const rol = await getRolUsuario(env, session.usuario_id);
    if (String(rol || "").toUpperCase() !== "ADMIN") {
      return json({ ok: false, error: "Solo disponible para administradores." }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const nombre = limpiarTexto(body?.nombre);
    const nombrePublico = limpiarTexto(body?.nombre_publico);
    const email = limpiarTexto(body?.email).toLowerCase();
    const telefono = limpiarTexto(body?.telefono_contacto);
    const telefonoRpv = limpiarTexto(body?.telefono_rpv);
    const localidad = limpiarTexto(body?.localidad);

    if (!nombre || !email) {
      return json({ ok: false, error: "Debes indicar nombre y email." }, 400);
    }
    if (!esEmailValido(email)) {
      return json({ ok: false, error: "El email no es vÃ¡lido." }, 400);
    }
    if (!esTelefonoValidoOpcional(telefono)) {
      return json({ ok: false, error: "El telÃ©fono general no es vÃ¡lido." }, 400);
    }
    if (!esTelefonoRpvValidoOpcional(telefonoRpv)) {
      return json({ ok: false, error: "El telÃ©fono RPV debe tener 7 dÃ­gitos." }, 400);
    }

    const existe = await env.DB.prepare(`
      SELECT id
      FROM usuarios
      WHERE lower(email) = lower(?)
      LIMIT 1
    `).bind(email).first();
    if (existe) {
      return json({ ok: false, error: "Ya existe una cuenta con ese email." }, 409);
    }

    const passwordTemporal = generarPasswordTemporal();
    const passwordHash = await hashPassword(passwordTemporal);
    const admin = await obtenerAdmin(env, Number(session.usuario_id || 0));

    const insert = await env.DB.prepare(`
      INSERT INTO usuarios (
        nombre,
        nombre_publico,
        email,
        telefono_contacto,
        telefono_rpv,
        localidad,
        password_hash,
        rol,
        activo,
        fecha_alta,
        forzar_cambio_password,
        secretaria_admin_creador_id,
        secretaria_onboarding_completo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SECRETARIA', 1, datetime('now'), 1, ?, 0)
    `).bind(
      nombre,
      nombrePublico,
      email,
      telefono || "",
      telefonoRpv || "",
      localidad || "",
      passwordHash,
      Number(session.usuario_id || 0)
    ).run();

    const secretariaId = Number(insert?.meta?.last_row_id || 0);
    if (!(secretariaId > 0)) {
      return json({ ok: false, error: "No se pudo crear la invitaciÃ³n de SecretarÃ­a." }, 500);
    }

    const nombreAdmin = limpiarTexto(admin?.nombre_publico || admin?.nombre || "el administrador");
    const origen = new URL(request.url).origin;
    const enlaceAcceso = `${origen}/portal.html?invite_email=${encodeURIComponent(email)}`;
    const texto = [
      `Hola ${nombrePublico || nombre},`,
      "",
      `Se ha creado tu cuenta de Secretaría vinculada a ${nombreAdmin}.`,
      "",
      `Acceso directo al portal: ${enlaceAcceso}`,
      "",
      `Usuario: ${email}`,
      `Contraseña temporal de un solo uso: ${passwordTemporal}`,
      "",
      "Al entrar por primera vez en la aplicación tendrás que cambiar la contraseña de forma obligatoria.",
      "Después deberás completar y guardar tu ficha de perfil para activar definitivamente tu cuenta."
    ].join("\n");

    const html = `
      <p>Hola ${nombrePublico || nombre},</p>
      <p>Se ha creado tu cuenta de Secretaría vinculada a <strong>${nombreAdmin}</strong>.</p>
      <p><a href="${enlaceAcceso}">Acceder al portal</a> (el email quedará precargado para tu primer acceso).</p>
      <p><strong>Usuario:</strong> ${email}<br><strong>Contraseña temporal de un solo uso:</strong> ${passwordTemporal}</p>
      <p>Al entrar por primera vez en la aplicación tendrás que cambiar la contraseña de forma obligatoria.</p>
      <p>Después deberás completar y guardar tu ficha de perfil para activar definitivamente tu cuenta.</p>
    `;

    const correo = await enviarEmail(env, {
      to: email,
      subject: "[Acceso] InvitaciÃ³n de cuenta de SecretarÃ­a",
      text: texto,
      html
    });

    if (!correo?.ok && !correo?.skipped) {
      await env.DB.prepare(`DELETE FROM usuarios WHERE id = ? AND rol = 'SECRETARIA'`).bind(secretariaId).run();
      return json({ ok: false, error: correo?.error || "No se pudo enviar el correo de invitaciÃ³n." }, 500);
    }

    await crearNotificacion(env, {
      usuarioId: Number(session.usuario_id || 0),
      rolDestino: "ADMIN",
      tipo: "SISTEMA",
      titulo: "InvitaciÃ³n de SecretarÃ­a enviada",
      mensaje: `Se ha enviado la invitaciÃ³n de SecretarÃ­a a ${email}.`,
      urlDestino: "/usuario-perfil.html?tab=documentacion"
    });

    return json({
      ok: true,
      mensaje: "InvitaciÃ³n enviada. La cuenta aparecerÃ¡ en el listado cuando complete su primer acceso y perfil."
    });
  } catch (error) {
    return json({ ok: false, error: "No se pudo crear la invitaciÃ³n de SecretarÃ­a.", detalle: error.message }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  try {
    await asegurarColumnaUsuario(env.DB, "secretaria_admin_creador_id", "INTEGER");
    await asegurarColumnaUsuario(env.DB, "secretaria_onboarding_completo", "INTEGER NOT NULL DEFAULT 0");
    const session = await getAdminSession(request, env);
    if (!session) return json({ ok: false, error: "No autorizado." }, 401);
    const rol = await getRolUsuario(env, session.usuario_id);
    if (String(rol || "").toUpperCase() !== "ADMIN") {
      return json({ ok: false, error: "Solo disponible para administradores." }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const secretariaId = parsearIdPositivo(body?.secretaria_usuario_id);
    if (!secretariaId) {
      return json({ ok: false, error: "Debes indicar una cuenta de secretarÃ­a vÃ¡lida." }, 400);
    }

    const secretaria = await env.DB.prepare(`
      SELECT id, nombre, nombre_publico, activo, secretaria_admin_creador_id
      FROM usuarios
      WHERE id = ?
        AND rol = 'SECRETARIA'
      LIMIT 1
    `).bind(secretariaId).first();

    if (!secretaria) {
      return json({ ok: false, error: "La cuenta de secretarÃ­a indicada no existe." }, 404);
    }

    if (Number(secretaria.secretaria_admin_creador_id || 0) !== Number(session.usuario_id || 0)) {
      return json({ ok: false, error: "Solo puedes eliminar cuentas de secretarÃ­a creadas desde tu sesiÃ³n." }, 403);
    }

    const adscritos = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM usuarios
      WHERE rol = 'ADMIN'
        AND secretaria_usuario_id = ?
        AND COALESCE(modulo_secretaria, 0) = 0
    `).bind(secretariaId).first();

    if (Number(adscritos?.total || 0) > 0) {
      return json({
        ok: false,
        error: "No se puede eliminar esta cuenta porque hay administradores adscritos. Activa primero la autogestiÃ³n documental."
      }, 409);
    }

    await env.DB.prepare(`
      UPDATE usuarios
      SET activo = 0
      WHERE id = ?
    `).bind(secretariaId).run();

    await crearNotificacion(env, {
      usuarioId: Number(session.usuario_id || 0),
      rolDestino: "ADMIN",
      tipo: "SISTEMA",
      titulo: "Cuenta de SecretarÃ­a desactivada",
      mensaje: `Se ha desactivado la cuenta de SecretarÃ­a ${secretaria.nombre_publico || secretaria.nombre || ""}.`,
      urlDestino: "/usuario-perfil.html?tab=documentacion"
    });

    const secretarias = await obtenerSecretariasDeAdmin(env, Number(session.usuario_id || 0));
    return json({ ok: true, mensaje: "Cuenta de secretarÃ­a eliminada.", secretarias });
  } catch (error) {
    return json({ ok: false, error: "No se pudo eliminar la cuenta de secretarÃ­a.", detalle: error.message }, 500);
  }
}

export async function onRequestPatch(context) {
  const { request, env } = context;
  try {
    await asegurarColumnaUsuario(env.DB, "secretaria_admin_creador_id", "INTEGER");
    await asegurarColumnaUsuario(env.DB, "secretaria_onboarding_completo", "INTEGER NOT NULL DEFAULT 0");
    const session = await getAdminSession(request, env);
    if (!session) return json({ ok: false, error: "No autorizado." }, 401);
    const rol = await getRolUsuario(env, session.usuario_id);
    if (String(rol || "").toUpperCase() !== "ADMIN") {
      return json({ ok: false, error: "Solo disponible para administradores." }, 403);
    }
    const body = await request.json().catch(() => ({}));
    const secretariaId = parsearIdPositivo(body?.secretaria_usuario_id);
    const activo = Number(body?.activo) === 1 ? 1 : 0;
    if (!secretariaId) return json({ ok: false, error: "Cuenta de SecretarÃ­a no vÃ¡lida." }, 400);

    const secretaria = await env.DB.prepare(`
      SELECT id, nombre, nombre_publico, email, secretaria_admin_creador_id, secretaria_onboarding_completo
      FROM usuarios
      WHERE id = ?
        AND rol = 'SECRETARIA'
      LIMIT 1
    `).bind(secretariaId).first();
    if (!secretaria) return json({ ok: false, error: "Cuenta de SecretarÃ­a no encontrada." }, 404);
    if (Number(secretaria.secretaria_admin_creador_id || 0) !== Number(session.usuario_id || 0)) {
      return json({ ok: false, error: "No puedes gestionar esta cuenta de SecretarÃ­a." }, 403);
    }
    if (Number(secretaria.secretaria_onboarding_completo || 0) !== 1) {
      return json({ ok: false, error: "La cuenta aÃºn no ha completado su activaciÃ³n inicial." }, 409);
    }

    await env.DB.prepare(`
      UPDATE usuarios
      SET activo = ?
      WHERE id = ?
        AND rol = 'SECRETARIA'
    `).bind(activo, secretariaId).run();

    const accion = activo === 1 ? "reactivada" : "suspendida";
    await crearNotificacion(env, {
      usuarioId: Number(session.usuario_id || 0),
      rolDestino: "ADMIN",
      tipo: "SISTEMA",
      titulo: `Cuenta de SecretarÃ­a ${accion}`,
      mensaje: `La cuenta ${secretaria.nombre_publico || secretaria.nombre || ""} ha sido ${accion}.`,
      urlDestino: "/usuario-perfil.html?tab=documentacion"
    });

    const destinatario = limpiarTexto(secretaria.email);
    if (destinatario) {
      await enviarEmail(env, {
        to: destinatario,
        subject: `[Acceso] Cuenta de SecretarÃ­a ${accion}`,
        text: `Tu cuenta de SecretarÃ­a vinculada al administrador ha sido ${accion}.`,
        html: `<p>Tu cuenta de SecretarÃ­a vinculada al administrador ha sido <strong>${accion}</strong>.</p>`
      });
    }

    const secretarias = await obtenerSecretariasDeAdmin(env, Number(session.usuario_id || 0));
    return json({ ok: true, mensaje: `Cuenta ${accion}.`, secretarias });
  } catch (error) {
    return json({ ok: false, error: "No se pudo actualizar el estado de la cuenta.", detalle: error.message }, 500);
  }
}

