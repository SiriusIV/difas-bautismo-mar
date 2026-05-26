import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";

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
      AND COALESCE(activo, 1) = 1
    ORDER BY
      CASE
        WHEN nombre_publico IS NOT NULL AND TRIM(nombre_publico) <> '' THEN TRIM(nombre_publico)
        ELSE TRIM(nombre)
      END COLLATE NOCASE ASC,
      id ASC
  `).bind(adminId).all();
  return rows?.results || [];
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    await asegurarColumnaUsuario(env.DB, "secretaria_admin_creador_id", "INTEGER");
    const session = await getAdminSession(request, env);
    if (!session) return json({ ok: false, error: "No autorizado." }, 401);
    const rol = await getRolUsuario(env, session.usuario_id);
    if (String(rol || "").toUpperCase() !== "ADMIN") {
      return json({ ok: false, error: "Solo disponible para administradores." }, 403);
    }
    const secretarias = await obtenerSecretariasDeAdmin(env, Number(session.usuario_id || 0));
    return json({ ok: true, secretarias });
  } catch (error) {
    return json({ ok: false, error: "No se pudieron cargar las cuentas de secretaría.", detalle: error.message }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  try {
    await asegurarColumnaUsuario(env.DB, "secretaria_admin_creador_id", "INTEGER");
    const session = await getAdminSession(request, env);
    if (!session) return json({ ok: false, error: "No autorizado." }, 401);
    const rol = await getRolUsuario(env, session.usuario_id);
    if (String(rol || "").toUpperCase() !== "ADMIN") {
      return json({ ok: false, error: "Solo disponible para administradores." }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const secretariaId = parsearIdPositivo(body?.secretaria_usuario_id);
    if (!secretariaId) {
      return json({ ok: false, error: "Debes indicar una cuenta de secretaría válida." }, 400);
    }

    const secretaria = await env.DB.prepare(`
      SELECT id, nombre, nombre_publico, activo, secretaria_admin_creador_id
      FROM usuarios
      WHERE id = ?
        AND rol = 'SECRETARIA'
      LIMIT 1
    `).bind(secretariaId).first();

    if (!secretaria) {
      return json({ ok: false, error: "La cuenta de secretaría indicada no existe." }, 404);
    }

    if (Number(secretaria.secretaria_admin_creador_id || 0) !== Number(session.usuario_id || 0)) {
      return json({ ok: false, error: "Solo puedes eliminar cuentas de secretaría creadas desde tu sesión." }, 403);
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
        error: "No se puede eliminar esta cuenta porque hay administradores adscritos. Activa primero la autogestión documental."
      }, 409);
    }

    await env.DB.prepare(`
      UPDATE usuarios
      SET activo = 0
      WHERE id = ?
    `).bind(secretariaId).run();

    const secretarias = await obtenerSecretariasDeAdmin(env, Number(session.usuario_id || 0));
    return json({ ok: true, mensaje: "Cuenta de secretaría eliminada.", secretarias });
  } catch (error) {
    return json({ ok: false, error: "No se pudo eliminar la cuenta de secretaría.", detalle: error.message }, 500);
  }
}
