import { getUserSession } from "./_auth.js";
import { obtenerCatalogoDocumentosActivosAdmin } from "../_actividad_documentacion.js";
import { obtenerCatalogoDocumentalVinculadoAdmin } from "../_documentacion_propietarios.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function obtenerUsuario(env, userId) {
  return await env.DB.prepare(`
    SELECT
      id,
      rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first();
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    if (!session?.id) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const usuario = await obtenerUsuario(env, session.id);
    if (!usuario || usuario.rol !== "SOLICITANTE") {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    const result = await env.DB.prepare(`
      SELECT
        u.id,
        u.nombre,
        u.nombre_publico,
        u.localidad,
        u.email
      FROM usuarios u
      WHERE COALESCE(u.activo, 1) = 1
        AND u.rol IN ('ADMIN', 'SUPERADMIN')
      ORDER BY COALESCE(u.nombre_publico, u.nombre, u.email) ASC
    `).all();

    const administradores = [];
    for (const row of result?.results || []) {
      const adminId = Number(row.id || 0);
      if (!(adminId > 0)) continue;
      const catalogo = await obtenerCatalogoDocumentalVinculadoAdmin(
        env,
        adminId,
        await obtenerCatalogoDocumentosActivosAdmin(env, adminId)
      );
      if (!catalogo.length) continue;

      administradores.push({
        id: adminId,
        nombre: row.nombre || "",
        nombre_publico: row.nombre_publico || "",
        localidad: row.localidad || "",
        email: row.email || "",
        version_requerida: catalogo.reduce((max, doc) =>
          Math.max(max, Number(doc?.version_documental || 0)), 0),
        total_documentos: catalogo.length,
        total_propietarios_documentales: new Set(
          catalogo.map((doc) => Number(doc?.propietario_id || doc?.admin_id || 0)).filter((id) => id > 0)
        ).size
      });
    }

    return json({
      ok: true,
      administradores
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al obtener los administradores con documentación activa.",
        detalle: error.message
      },
      500
    );
  }
}
