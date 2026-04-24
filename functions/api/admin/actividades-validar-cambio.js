import { getAdminSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsearFlag(valor, defecto = 0) {
  if (valor === true || valor === 1 || valor === "1") return 1;
  if (valor === false || valor === 0 || valor === "0") return 0;
  return defecto;
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

async function obtenerPlazasComprometidasActividad(env, actividad_id) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(SUM(
      CASE
              WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'CONDICIONADA_DOCUMENTACION') THEN
          CASE
            WHEN r.prereserva_expira_en IS NOT NULL
                 AND datetime('now') <= datetime(r.prereserva_expira_en)
              THEN MAX(
                COALESCE(r.plazas_prereservadas, 0),
                COALESCE((
                  SELECT COUNT(*)
                  FROM visitantes v
                  WHERE v.reserva_id = r.id
                ), 0)
              )
            ELSE COALESCE((
              SELECT COUNT(*)
              FROM visitantes v
              WHERE v.reserva_id = r.id
            ), 0)
          END
        ELSE 0
      END
    ), 0) AS comprometidas
    FROM reservas r
    WHERE r.actividad_id = ?
  `).bind(actividad_id).first();

  return Number(row?.comprometidas || 0);
}

async function obtenerSolicitudesVivasActividad(env, actividad_id) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM reservas
    WHERE actividad_id = ?
      AND UPPER(TRIM(COALESCE(estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'CONDICIONADA_DOCUMENTACION')
  `).bind(actividad_id).first();

  return Number(row?.total || 0);
}

function construirEstadoPropuesto(body, actual) {
  const tipo = limpiarTexto(body.tipo || actual.tipo).toUpperCase();
  const esTemporal = tipo === "TEMPORAL";

  return {
    tipo,
    fecha_inicio: esTemporal ? limpiarTexto(body.fecha_inicio ?? actual.fecha_inicio) : null,
    fecha_fin: esTemporal ? limpiarTexto(body.fecha_fin ?? actual.fecha_fin) : null,
    usa_franjas: parsearFlag(body.usa_franjas, Number(actual.usa_franjas || 0)),
    requiere_reserva: parsearFlag(body.requiere_reserva, Number(actual.requiere_reserva || 0)),
    aforo_limitado: parsearFlag(body.aforo_limitado, Number(actual.aforo_limitado || 0))
  };
}

function validarDatosBasicosPropuestos(p) {
  if (!["TEMPORAL", "PERMANENTE"].includes(p.tipo)) {
    return "El tipo debe ser TEMPORAL o PERMANENTE.";
  }

  if (p.tipo === "TEMPORAL") {
    if (!p.fecha_inicio || !p.fecha_fin) {
      return "Las actividades temporales deben tener fecha de inicio y fecha de fin.";
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.fecha_inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(p.fecha_fin)) {
      return "Las fechas deben tener formato YYYY-MM-DD.";
    }

    if (p.fecha_inicio > p.fecha_fin) {
      return "La fecha de inicio no puede ser posterior a la fecha de fin.";
    }
  }

  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json();
    const id = parsearIdPositivo(body.id);

    if (!id) {
      return json({ ok: false, error: "ID de actividad no válido." }, 400);
    }

    const actual = await obtenerActividad(env, id);
    if (!actual) {
      return json({ ok: false, error: "La actividad no existe." }, 404);
    }

    const rol = await obtenerRol(env, session.usuario_id);
    if (rol !== "SUPERADMIN" && Number(actual.admin_id || 0) !== Number(session.usuario_id)) {
      return json({ ok: false, error: "No autorizado para validar esta actividad." }, 403);
    }

    const p = construirEstadoPropuesto(body, actual);

    const errorBasico = validarDatosBasicosPropuestos(p);
    if (errorBasico) {
      return json({ ok: false, error: errorBasico }, 200);
    }

    const franjas = await env.DB.prepare(`
      SELECT fecha, hora_inicio
      FROM franjas
      WHERE actividad_id = ?
    `).bind(id).all();

    const listaFranjas = franjas.results || [];

    if (p.tipo === "TEMPORAL" && listaFranjas.length > 0) {
      const fueraRango = listaFranjas.some(f =>
        f.fecha && (f.fecha < p.fecha_inicio || f.fecha > p.fecha_fin)
      );

      if (fueraRango) {
        return json({
          ok: false,
          error: "No puedes cambiar las fechas porque existen franjas fuera del nuevo rango."
        }, 200);
      }
    }

    const confirmadasFuturas = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM reservas r
      JOIN franjas f ON f.id = r.franja_id
      WHERE f.actividad_id = ?
        AND r.estado = 'CONFIRMADA'
        AND (
          f.fecha IS NULL OR
          datetime(f.fecha || ' ' || f.hora_inicio) >= datetime('now')
        )
    `).bind(id).first();

    const hayConfirmadas = Number(confirmadasFuturas?.total || 0) > 0;
    const solicitudesVivas = await obtenerSolicitudesVivasActividad(env, id);

    if (hayConfirmadas && p.tipo === "PERMANENTE" && String(actual.tipo || "").toUpperCase() === "TEMPORAL") {
      return json({
        ok: false,
        error: "No puedes cambiar a actividad permanente porque existen reservas confirmadas futuras."
      }, 200);
    }

    const plazasComprometidas = await obtenerPlazasComprometidasActividad(env, id);

    if (
      plazasComprometidas > 0 &&
      Number(actual.aforo_limitado || 0) === 1 &&
      Number(p.aforo_limitado || 0) === 0
    ) {
      return json({
        ok: false,
        error: "No puedes desactivar el aforo limitado porque existen plazas comprometidas en reservas activas."
      }, 200);
    }

    if (
      plazasComprometidas > 0 &&
      Number(actual.requiere_reserva || 0) === 1 &&
      Number(p.requiere_reserva || 0) === 0
    ) {
      return json({
        ok: false,
        error: "No puedes desactivar la reserva porque existen plazas comprometidas en reservas activas."
      }, 200);
    }

    if (
      solicitudesVivas > 0 &&
      Number(actual.usa_franjas || 0) === 1 &&
      Number(p.usa_franjas || 0) === 0
    ) {
      return json({
        ok: false,
        error: "No puedes desactivar las franjas porque existen solicitudes activas asociadas a esta actividad."
      }, 200);
    }

    return json({ ok: true }, 200);
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al validar el cambio de actividad.",
        detalle: error.message
      },
      500
    );
  }
}
