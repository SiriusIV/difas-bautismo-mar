import { getAdminSession } from "./_auth.js";

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

async function obtenerRol(env, usuario_id) {
  const row = await env.DB.prepare(`
    SELECT rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(usuario_id).first();

  return row?.rol || null;
}

async function obtenerActividad(env, id) {
  return await env.DB.prepare(`
    SELECT *
    FROM actividades
    WHERE id = ?
    LIMIT 1
  `).bind(id).first();
}

async function obtenerSituacionReservasActividad(env, actividadId) {
  const result = await env.DB.prepare(`
    SELECT
      r.id,
      r.estado,
      f.fecha
    FROM reservas r
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.actividad_id = ?
      AND r.estado IN ('CONFIRMADA', 'PENDIENTE')
  `).bind(actividadId).all();

  const rows = result?.results || [];
  const hoy = new Date().toISOString().slice(0, 10);

  let confirmadasFuturas = 0;
  let pendientesFuturas = 0;
  let pendientesSinFecha = 0;

  for (const r of rows) {
    const fecha = String(r.fecha || "").slice(0, 10);

    if (r.estado === "CONFIRMADA") {
      if (!fecha || fecha >= hoy) {
        confirmadasFuturas++;
      }
    }

    if (r.estado === "PENDIENTE") {
      if (!fecha) {
        pendientesSinFecha++;
      } else if (fecha >= hoy) {
        pendientesFuturas++;
      }
    }
  }

  return {
    confirmadasFuturas,
    pendientesFuturas,
    pendientesSinFecha,
    totalPendientes: pendientesFuturas + pendientesSinFecha
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const id = parsearIdPositivo(body.id);
    const confirmado = body.confirmado === true || body.confirmado === 1 || body.confirmado === "1";

    if (!id) {
      return json({ ok: false, error: "ID de actividad no válido." }, 400);
    }

    const actividad = await obtenerActividad(env, id);
    if (!actividad) {
      return json({ ok: false, error: "La actividad no existe." }, 404);
    }

    const rol = await obtenerRol(env, session.usuario_id);
    if (rol !== "SUPERADMIN" && Number(actividad.admin_id || 0) !== Number(session.usuario_id)) {
      return json({ ok: false, error: "No autorizado para eliminar esta actividad." }, 403);
    }

    const situacion = await obtenerSituacionReservasActividad(env, id);

    if (situacion.confirmadasFuturas > 0) {
      return json({
        ok: false,
        bloqueado: true,
        error: "No se puede eliminar la actividad porque existen solicitudes confirmadas pendientes de realización."
      }, 400);
    }

    if (situacion.totalPendientes > 0 && !confirmado) {
      return json({
        ok: false,
        requiere_confirmacion: true,
        mensaje: "La actividad tiene solicitudes pendientes de autorización. Si continúas, serán rechazadas al eliminar la actividad."
      }, 200);
    }

    await env.DB.prepare(`
      DELETE FROM visitantes
      WHERE reserva_id IN (
        SELECT id
        FROM reservas
        WHERE actividad_id = ?
      )
    `).bind(id).run();

    await env.DB.prepare(`
      DELETE FROM reservas
      WHERE actividad_id = ?
    `).bind(id).run();

    await env.DB.prepare(`
      DELETE FROM franjas
      WHERE actividad_id = ?
    `).bind(id).run();

    const result = await env.DB.prepare(`
      DELETE FROM actividades
      WHERE id = ?
    `).bind(id).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo eliminar la actividad." }, 500);
    }

    return json({
      ok: true,
      mensaje: situacion.totalPendientes > 0
        ? "Actividad eliminada correctamente. Las solicitudes pendientes asociadas han sido eliminadas."
        : "Actividad eliminada correctamente."
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al eliminar la actividad.", detalle: error.message },
      500
    );
  }
}
