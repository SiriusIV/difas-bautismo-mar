import { getAdminSession } from "./_auth.js";
import { recalcularImpactoDocumentalReservas } from "../_impacto_documental_reservas.js";

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

async function obtenerDocumentoObjetivo(env, session, documentoId) {
  if (session.rol === "SUPERADMIN") {
    return await env.DB.prepare(`
      SELECT id, admin_id, nombre, activo, orden
      FROM admin_documentos_comunes
      WHERE id = ?
      LIMIT 1
    `).bind(documentoId).first();
  }

  return await env.DB.prepare(`
    SELECT id, admin_id, nombre, activo, orden
    FROM admin_documentos_comunes
    WHERE id = ?
      AND admin_id = ?
    LIMIT 1
  `).bind(documentoId, session.usuario_id).first();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json().catch(() => null);
    const baseUrl = new URL(request.url).origin;
    const documentoId = parsearIdPositivo(body?.documento_id);
    const activar = body?.activar === true;

    if (!documentoId) {
      return json({ ok: false, error: "Debes indicar un documento válido." }, 400);
    }

    const documento = await obtenerDocumentoObjetivo(env, session, documentoId);
    if (!documento) {
      return json({ ok: false, error: "No se encontró el documento solicitado." }, 404);
    }

    const estadoActual = Number(documento.activo || 0) === 1;
    if (estadoActual === activar) {
      return json({
        ok: true,
        mensaje: activar ? "El documento ya estaba activo." : "El documento ya estaba desactivado.",
        documento_id: documentoId,
        activo: activar
      });
    }

    if (activar) {
      const duplicadoActivo = await env.DB.prepare(`
        SELECT id
        FROM admin_documentos_comunes
        WHERE admin_id = ?
          AND activo = 1
          AND UPPER(TRIM(nombre)) = UPPER(TRIM(?))
          AND id <> ?
        LIMIT 1
      `).bind(documento.admin_id, documento.nombre, documentoId).first();

      if (duplicadoActivo) {
        return json(
          {
            ok: false,
            error: "Ya existe otro documento activo con ese mismo nombre. Elimínalo o renómbralo antes de reactivar este."
          },
          400
        );
      }
    }

    await env.DB.prepare(`
      UPDATE admin_documentos_comunes
      SET
        activo = ?,
        fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(activar ? 1 : 0, documentoId).run();

    const impactoReservas = await recalcularImpactoDocumentalReservas(env, {
      adminId: Number(documento.admin_id || 0),
      baseUrl,
      motivo: activar ? "documento_activado" : "documentos_actualizados"
    });

    return json({
      ok: true,
      mensaje: activar ? "Documento activado correctamente." : "Documento desactivado correctamente.",
      documento_id: documentoId,
      activo: activar,
      impacto_reservas: impactoReservas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo actualizar el estado del documento.",
        detalle: error?.message || String(error)
      },
      500
    );
  }
}
