import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import {
  guardarPropietariosDocumentalesVinculados,
  listarPropietariosDocumentalesDisponibles,
  listarPropietariosDocumentalesVinculados
} from "../_documentacion_propietarios.js";

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

async function resolverAdminObjetivo(env, session, adminIdParam) {
  const rol = String(await getRolUsuario(env, session.usuario_id) || "").toUpperCase();
  if (rol === "SUPERADMIN") {
    return parsearIdPositivo(adminIdParam) || Number(session.usuario_id || 0);
  }
  return Number(session.usuario_id || 0);
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const url = new URL(request.url);
    const adminId = await resolverAdminObjetivo(env, session, url.searchParams.get("admin_id"));
    const disponibles = await listarPropietariosDocumentalesDisponibles(env);
    let vinculados = await listarPropietariosDocumentalesVinculados(env, adminId);
    if (!vinculados.length) {
      vinculados = disponibles.filter((item) => Number(item.id || 0) === Number(adminId || 0));
    }

    return json({
      ok: true,
      admin_id: adminId,
      disponibles,
      vinculados,
      vinculados_ids: vinculados.map((item) => Number(item.id || 0)).filter((id) => id > 0)
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudieron cargar los propietarios documentales vinculados.",
      detalle: error.message
    }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const adminId = await resolverAdminObjetivo(env, session, body?.admin_id);
    const vinculados = await guardarPropietariosDocumentalesVinculados(
      env,
      adminId,
      body?.propietarios_ids || []
    );

    return json({
      ok: true,
      mensaje: "Vinculaciones documentales actualizadas.",
      admin_id: adminId,
      vinculados,
      vinculados_ids: vinculados.map((item) => Number(item.id || 0)).filter((id) => id > 0)
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudieron guardar las vinculaciones documentales.",
      detalle: error.message
    }, 500);
  }
}
