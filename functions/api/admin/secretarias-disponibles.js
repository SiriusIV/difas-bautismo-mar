import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
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

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    await asegurarColumnaUsuario(env.DB, "secretaria_admin_creador_id", "INTEGER");
    await asegurarColumnaUsuario(env.DB, "secretaria_onboarding_completo", "INTEGER NOT NULL DEFAULT 0");
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const rol = await getRolUsuario(env, session.usuario_id);
    if (!["ADMIN", "SUPERADMIN"].includes(String(rol || "").toUpperCase())) {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    let sql = `
      SELECT
        id,
        nombre,
        nombre_publico,
        email,
        localidad
      FROM usuarios
      WHERE rol = 'SECRETARIA'
        AND activo = 1
        AND COALESCE(secretaria_onboarding_completo, 0) = 1
    `;
    const binds = [];
    if (String(rol || "").toUpperCase() === "ADMIN") {
      sql += " AND secretaria_admin_creador_id = ? ";
      binds.push(Number(session.usuario_id || 0));
    }
    sql += ` ORDER BY
        CASE
          WHEN nombre_publico IS NOT NULL AND TRIM(nombre_publico) <> '' THEN TRIM(nombre_publico)
          ELSE TRIM(nombre)
        END COLLATE NOCASE ASC,
        id ASC
    `;
    const stmt = env.DB.prepare(sql);
    const rows = binds.length ? await stmt.bind(...binds).all() : await stmt.all();

    return json({
      ok: true,
      secretarias: rows?.results || []
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudieron cargar las secretarías disponibles.",
        detalle: error.message
      },
      500
    );
  }
}
