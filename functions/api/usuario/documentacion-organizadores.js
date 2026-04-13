import { getUserSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function extraerKeyDesdeArchivoUrl(archivoUrl) {
  const texto = limpiarTexto(archivoUrl);
  if (!texto) return null;

  try {
    const base = texto.startsWith("http://") || texto.startsWith("https://")
      ? texto
      : `https://local${texto.startsWith("/") ? "" : "/"}${texto}`;
    const url = new URL(base);
    const key = limpiarTexto(url.searchParams.get("key"));
    return key || null;
  } catch {
    return null;
  }
}

async function asegurarTablaSeleccion(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS usuario_documentacion_organizadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      centro_usuario_id INTEGER NOT NULL,
      admin_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(centro_usuario_id, admin_id)
    )
  `).run();
}

async function obtenerUsuarioSolicitante(env, userId) {
  return await env.DB.prepare(`
    SELECT id, rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first();
}

async function obtenerAdminConDocumentacionActiva(env, adminId) {
  return await env.DB.prepare(`
    SELECT
      u.id,
      COUNT(adc.id) AS total_documentos
    FROM usuarios u
    LEFT JOIN admin_documentos_comunes adc
      ON adc.admin_id = u.id
     AND adc.activo = 1
    WHERE u.id = ?
      AND u.rol IN ('ADMIN', 'SUPERADMIN')
    GROUP BY u.id
    LIMIT 1
  `).bind(adminId).first();
}

async function borrarDocumentosUsuarioPorAdmin(env, centroUsuarioId, adminId) {
  const expediente = await env.DB.prepare(`
    SELECT id
    FROM centro_admin_documentacion
    WHERE centro_usuario_id = ?
      AND admin_id = ?
    LIMIT 1
  `).bind(centroUsuarioId, adminId).first();

  if (!expediente?.id) return;

  const archivos = await env.DB.prepare(`
    SELECT id, archivo_url
    FROM centro_admin_documentacion_archivos
    WHERE documentacion_id = ?
  `).bind(expediente.id).all();

  for (const archivo of archivos?.results || []) {
    const key = extraerKeyDesdeArchivoUrl(archivo.archivo_url);
    if (key && env.DOCS_BUCKET) {
      await env.DOCS_BUCKET.delete(key);
    }
  }

  await env.DB.prepare(`
    DELETE FROM centro_admin_documentacion_archivos
    WHERE documentacion_id = ?
  `).bind(expediente.id).run();

  await env.DB.prepare(`
    DELETE FROM centro_admin_documentacion
    WHERE id = ?
  `).bind(expediente.id).run();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);
    if (!session?.id) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const usuario = await obtenerUsuarioSolicitante(env, session.id);
    if (!usuario || usuario.rol !== "SOLICITANTE") {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    await asegurarTablaSeleccion(env);

    const body = await request.json().catch(() => null);
    const accion = limpiarTexto(body?.accion).toLowerCase();
    const adminId = parsearIdPositivo(body?.admin_id);

    if (!adminId) {
      return json({ ok: false, error: "Debes indicar un organizador válido." }, 400);
    }

    if (accion === "agregar") {
      const admin = await obtenerAdminConDocumentacionActiva(env, adminId);
      if (!admin || Number(admin.total_documentos || 0) <= 0) {
        return json({ ok: false, error: "El organizador no tiene documentación activa para añadir." }, 400);
      }

      await env.DB.prepare(`
        INSERT OR IGNORE INTO usuario_documentacion_organizadores (
          centro_usuario_id,
          admin_id
        )
        VALUES (?, ?)
      `).bind(usuario.id, adminId).run();

      return json({
        ok: true,
        mensaje: "Organizador añadido correctamente.",
        admin_id: adminId
      });
    }

    if (accion === "eliminar") {
      await borrarDocumentosUsuarioPorAdmin(env, usuario.id, adminId);

      await env.DB.prepare(`
        DELETE FROM usuario_documentacion_organizadores
        WHERE centro_usuario_id = ?
          AND admin_id = ?
      `).bind(usuario.id, adminId).run();

      return json({
        ok: true,
        mensaje: "Organizador eliminado correctamente junto con su documentación asociada.",
        admin_id: adminId
      });
    }

    return json({ ok: false, error: "Acción no válida." }, 400);
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo gestionar el organizador documental.",
        detalle: error?.message || String(error)
      },
      500
    );
  }
}
