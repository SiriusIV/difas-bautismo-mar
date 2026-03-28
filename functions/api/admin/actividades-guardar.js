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

function normalizarNullable(valor) {
  const v = String(valor || "").trim();
  return v === "" ? null : v;
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

function validarActividad(data) {
  const nombre = limpiarTexto(data.nombre);
  const tipo = limpiarTexto(data.tipo).toUpperCase();

  if (!nombre) return "El nombre de la actividad es obligatorio.";
  if (!["TEMPORAL", "PERMANENTE"].includes(tipo)) {
    return "El tipo debe ser TEMPORAL o PERMANENTE.";
  }

  if (tipo === "TEMPORAL") {
    const fecha_inicio = limpiarTexto(data.fecha_inicio);
    const fecha_fin = limpiarTexto(data.fecha_fin);

    if (!fecha_inicio || !fecha_fin) {
      return "Las actividades temporales deben tener fecha de inicio y fecha de fin.";
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_fin)) {
      return "Las fechas deben tener formato YYYY-MM-DD.";
    }

    if (fecha_inicio > fecha_fin) {
      return "La fecha de inicio no puede ser posterior a la fecha de fin.";
    }
  }

  return null;
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

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json();
    const errorValidacion = validarActividad(body);

    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, 400);
    }

    const rol = await obtenerRol(env, session.usuario_id);
    const tipo = limpiarTexto(body.tipo).toUpperCase();

    let admin_id = parsearIdPositivo(body.admin_id);

    if (rol === "SUPERADMIN") {
      if (!admin_id) {
        return json({ ok: false, error: "Debe indicar el administrador responsable." }, 400);
      }
    } else {
      admin_id = session.usuario_id;
    }

    const result = await env.DB.prepare(`
      INSERT INTO actividades (
        nombre,
        tipo,
        fecha_inicio,
        fecha_fin,
        activa,
        descripcion,
        titulo_publico,
        subtitulo_publico,
        descripcion_corta,
        descripcion_larga,
        lugar,
        imagen_url,
        visible_portal,
        orden_portal,
        organizador_publico,
        usa_franjas,
        admin_id,
        requiere_reserva,
        aforo_limitado,
        provincia,
        es_recurrente,
        patron_recurrencia,
        usa_enlace_externo,
        enlace_externo_url,
        enlace_externo_texto,
        direccion_postal,
        latitud,
        longitud,
        zoom_mapa
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      limpiarTexto(body.nombre),
      tipo,
      tipo === "TEMPORAL" ? limpiarTexto(body.fecha_inicio) : null,
      tipo === "TEMPORAL" ? limpiarTexto(body.fecha_fin) : null,
      parsearFlag(body.activa, 1),
      normalizarNullable(body.descripcion),
      normalizarNullable(body.titulo_publico),
      normalizarNullable(body.subtitulo_publico),
      normalizarNullable(body.descripcion_corta),
      normalizarNullable(body.descripcion_larga),
      normalizarNullable(body.lugar),
      normalizarNullable(body.imagen_url),
      parsearFlag(body.visible_portal, 1),
      parseInt(body.orden_portal || 0, 10) || 0,
      normalizarNullable(body.organizador_publico),
      parsearFlag(body.usa_franjas, 1),
      admin_id,
      parsearFlag(body.requiere_reserva, 1),
      parsearFlag(body.aforo_limitado, 1),
      normalizarNullable(body.provincia),
      parsearFlag(body.es_recurrente, 0),
      normalizarNullable(body.patron_recurrencia),
      parsearFlag(body.usa_enlace_externo, 0),
      normalizarNullable(body.enlace_externo_url),
      normalizarNullable(body.enlace_externo_texto)
    ).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo crear la actividad." }, 500);
    }

    return json({
      ok: true,
      mensaje: "Actividad creada correctamente.",
      id: result.meta.last_row_id
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al crear la actividad.", detalle: error.message },
      500
    );
  }
}

export async function onRequestPut(context) {
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
      return json({ ok: false, error: "No autorizado para editar esta actividad." }, 403);
    }

    const errorValidacion = validarActividad(body);
    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, 400);
    }

    const tipo = limpiarTexto(body.tipo).toUpperCase();

    let admin_id = parsearIdPositivo(body.admin_id);
    if (rol !== "SUPERADMIN") {
      admin_id = actual.admin_id;
    }
    if (rol === "SUPERADMIN" && !admin_id) {
      return json({ ok: false, error: "Debe indicar el administrador responsable." }, 400);
    }

    const result = await env.DB.prepare(`
      UPDATE actividades
      SET
        nombre = ?,
        tipo = ?,
        fecha_inicio = ?,
        fecha_fin = ?,
        activa = ?,
        descripcion = ?,
        titulo_publico = ?,
        subtitulo_publico = ?,
        descripcion_corta = ?,
        descripcion_larga = ?,
        lugar = ?,
        imagen_url = ?,
        visible_portal = ?,
        orden_portal = ?,
        organizador_publico = ?,
        admin_id = ?,
        usa_franjas = ?,
        requiere_reserva = ?,
        aforo_limitado = ?,
        provincia = ?,
        es_recurrente = ?,
        patron_recurrencia = ?,
        usa_enlace_externo = ?,
        enlace_externo_url = ?,
        enlace_externo_texto = ?
        direccion_postal = ?,
        latitud = ?,
        longitud = ?,
        zoom_mapa = ?,
      WHERE id = ?
    `).bind(
      limpiarTexto(body.nombre),
      tipo,
      tipo === "TEMPORAL" ? limpiarTexto(body.fecha_inicio) : null,
      tipo === "TEMPORAL" ? limpiarTexto(body.fecha_fin) : null,
      parsearFlag(body.activa, 1),
      normalizarNullable(body.descripcion),
      normalizarNullable(body.titulo_publico),
      normalizarNullable(body.subtitulo_publico),
      normalizarNullable(body.descripcion_corta),
      normalizarNullable(body.descripcion_larga),
      normalizarNullable(body.lugar),
      normalizarNullable(body.direccion_postal),
      normalizarNullable(body.latitud),
      normalizarNullable(body.longitud),
      normalizarNullable(body.zoom_mapa),
      normalizarNullable(body.imagen_url),
      parsearFlag(body.visible_portal, 1),
      parseInt(body.orden_portal || 0, 10) || 0,
      normalizarNullable(body.organizador_publico),
      admin_id,
      parsearFlag(body.usa_franjas, 1),
      parsearFlag(body.requiere_reserva, 1),
      parsearFlag(body.aforo_limitado, 1),
      normalizarNullable(body.provincia),
      parsearFlag(body.es_recurrente, 0),
      normalizarNullable(body.patron_recurrencia),
      parsearFlag(body.usa_enlace_externo, 0),
      normalizarNullable(body.enlace_externo_url),
      normalizarNullable(body.enlace_externo_texto),
      id
    ).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo actualizar la actividad." }, 500);
    }

    return json({
      ok: true,
      mensaje: "Actividad actualizada correctamente."
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al actualizar la actividad.", detalle: error.message },
      500
    );
  }
}
