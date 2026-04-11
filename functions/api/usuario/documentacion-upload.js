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

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sanitizarSegmento(valor = "") {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function obtenerUsuarioSolicitante(env, userId) {
  return await env.DB.prepare(`
    SELECT
      id,
      centro,
      rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first();
}

async function obtenerAdmin(env, adminId) {
  return await env.DB.prepare(`
    SELECT
      id,
      nombre,
      rol
    FROM usuarios
    WHERE id = ?
      AND rol IN ('ADMIN', 'SUPERADMIN')
    LIMIT 1
  `).bind(adminId).first();
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

    if (!env.DOCS_BUCKET) {
      return json(
        {
          ok: false,
          error: "Falta configurar el binding DOCS_BUCKET en Cloudflare Pages."
        },
        500
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const adminId = parsearIdPositivo(formData.get("admin_id"));
    const nombreDocumento = limpiarTexto(formData.get("nombre_documento"));

    if (!adminId) {
      return json({ ok: false, error: "Debes indicar un organizador válido." }, 400);
    }

    const admin = await obtenerAdmin(env, adminId);
    if (!admin) {
      return json({ ok: false, error: "Organizador no encontrado." }, 404);
    }

    if (!(file instanceof File)) {
      return json({ ok: false, error: "Debes adjuntar un archivo PDF válido." }, 400);
    }

    if (!nombreDocumento) {
      return json({ ok: false, error: "Falta el nombre del documento." }, 400);
    }

    const contentType = String(file.type || "").toLowerCase();
    const nombreArchivo = String(file.name || "").toLowerCase();
    if (contentType !== "application/pdf" && !nombreArchivo.endsWith(".pdf")) {
      return json({ ok: false, error: "Solo se admiten documentos PDF." }, 400);
    }

    const centroSeguro = sanitizarSegmento(usuario.centro || `usuario-${usuario.id}`) || `usuario-${usuario.id}`;
    const adminSeguro = sanitizarSegmento(admin.nombre || `admin-${adminId}`) || `admin-${adminId}`;
    const nombreSeguro = sanitizarSegmento(nombreDocumento) || "documento";
    const key = `documentos/centros/${centroSeguro}/admin-${adminId}-${adminSeguro}/${nombreSeguro}.pdf`;
    const buffer = await file.arrayBuffer();

    await env.DOCS_BUCKET.put(key, buffer, {
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: `inline; filename="${nombreSeguro}.pdf"`
      },
      customMetadata: {
        centro_usuario_id: String(usuario.id),
        admin_id: String(adminId),
        nombre_documento: nombreDocumento,
        original_filename: String(file.name || "")
      }
    });

    return json({
      ok: true,
      mensaje: "Documento PDF remitido correctamente.",
      key,
      archivo_url: `/api/documentos?key=${encodeURIComponent(key)}`,
      admin_id: adminId,
      nombre_documento: nombreDocumento
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al subir el documento PDF.",
        detalle: error?.message || String(error)
      },
      500
    );
  }
}
