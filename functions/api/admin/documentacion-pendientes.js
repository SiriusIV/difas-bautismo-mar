import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import { puedeGestionarDocumentacionAdmin } from "../_documentacion_responsable.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function resolverAdminObjetivo(env, session, adminIdParam) {
  const rol = await getRolUsuario(env, session.usuario_id);
  if (rol === "SUPERADMIN") {
    return parsearIdPositivo(adminIdParam) || session.usuario_id;
  }
  return session.usuario_id;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const url = new URL(request.url);
    const rolSesion = await getRolUsuario(env, session.usuario_id);
    const adminId = await resolverAdminObjetivo(env, session, url.searchParams.get("admin_id"));
    const permiso = await puedeGestionarDocumentacionAdmin(env, session.usuario_id, adminId, rolSesion);
    const filtro = limpiarTexto(url.searchParams.get("filtro") || "pendientes").toLowerCase();
    const soloPendientes = filtro !== "todos";

    if (!permiso.permitido) {
      const mensaje = permiso.motivo === "RESPONSABLE_DISTINTO"
        ? "La documentación de este administrador está gestionada por una secretaría externa."
        : "Este administrador no tiene la gestión documental operativa habilitada.";
      return json(
        {
          ok: false,
          error: mensaje,
          modo_documental: permiso.resolucion?.modo || "",
          responsable_documental_id: Number(permiso.resolucion?.responsable?.id || 0)
        },
        { status: 403 }
      );
    }

    const whereExtra = soloPendientes ? `AND cad.estado = 'EN_REVISION'` : "";
    const rows = await env.DB.prepare(`
      SELECT
        cad.id,
        cad.centro_usuario_id,
        cad.admin_id,
        cad.version_requerida,
        cad.version_aportada,
        cad.estado,
        cad.fecha_ultima_entrega,
        cad.fecha_validacion,
        cad.observaciones_admin,
        u.centro,
        u.email,
        u.telefono_contacto
      FROM centro_admin_documentacion cad
      INNER JOIN usuarios u
        ON u.id = cad.centro_usuario_id
      WHERE cad.admin_id = ?
        ${whereExtra}
      ORDER BY
        CASE cad.estado
          WHEN 'EN_REVISION' THEN 0
          WHEN 'RECHAZADA' THEN 1
          WHEN 'DESACTUALIZADA' THEN 2
          WHEN 'VALIDADA' THEN 3
          ELSE 4
        END,
        datetime(cad.fecha_ultima_entrega) DESC,
        u.centro ASC
    `).bind(adminId).all();

    const pendientes = (rows?.results || []).map((row) => ({
      id: row.id,
      centro_usuario_id: row.centro_usuario_id,
      admin_id: row.admin_id,
      centro: row.centro || "",
      email: row.email || "",
      telefono_contacto: row.telefono_contacto || "",
      version_requerida: Number(row.version_requerida || 0),
      version_aportada: Number(row.version_aportada || 0),
      estado: row.estado || "",
      fecha_ultima_entrega: row.fecha_ultima_entrega || "",
      fecha_validacion: row.fecha_validacion || "",
      observaciones_admin: row.observaciones_admin || ""
    }));

    return json({
      ok: true,
      admin_id: adminId,
      filtro: soloPendientes ? "pendientes" : "todos",
      total: pendientes.length,
      expedientes: pendientes
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo cargar la documentación pendiente del administrador.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
