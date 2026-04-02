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

function parsearEntero(valor, defecto = 0) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) ? n : defecto;
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

function construirPayload(body, admin_id) {
  const tipo = limpiarTexto(body.tipo).toUpperCase();
  const esTemporal = tipo === "TEMPORAL";

  return {
    nombre: limpiarTexto(body.nombre),
    tipo,
    fecha_inicio: esTemporal ? limpiarTexto(body.fecha_inicio) : null,
    fecha_fin: esTemporal ? limpiarTexto(body.fecha_fin) : null,
    activa: parsearFlag(body.activa, 1),

    titulo_publico: normalizarNullable(body.titulo_publico),
    subtitulo_publico: normalizarNullable(body.subtitulo_publico),

    // ÚNICA DESCRIPCIÓN
    descripcion_corta: normalizarNullable(body.descripcion_corta),

    lugar: normalizarNullable(body.lugar),
    direccion_postal: normalizarNullable(body.direccion_postal),
    latitud: normalizarNullable(body.latitud),
    longitud: normalizarNullable(body.longitud),
    zoom_mapa: normalizarNullable(body.zoom_mapa),
    imagen_url: normalizarNullable(body.imagen_url),
    visible_portal: parsearFlag(body.visible_portal, 1),
    orden_portal: parsearEntero(body.orden_portal, 0),
    organizador_publico: normalizarNullable(body.organizador_publico),
    usa_franjas: parsearFlag(body.usa_franjas, 1),
    admin_id,
    requiere_reserva: parsearFlag(body.requiere_reserva, 1),
    aforo_limitado: parsearFlag(body.aforo_limitado, 1),
    provincia: normalizarNullable(body.provincia),
    es_recurrente: parsearFlag(body.es_recurrente, 0),
    patron_recurrencia: normalizarNullable(body.patron_recurrencia),
    usa_enlace_externo: parsearFlag(body.usa_enlace_externo, 0),
    enlace_externo_url: normalizarNullable(body.enlace_externo_url),
    enlace_externo_texto: normalizarNullable(body.enlace_externo_texto),
    borrador_tecnico: parsearFlag(body.borrador_tecnico, 0)
  };
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

    let admin_id = parsearIdPositivo(body.admin_id);
    if (rol === "SUPERADMIN") {
      if (!admin_id) {
        return json({ ok: false, error: "Debe indicar el administrador responsable." }, 400);
      }
    } else {
      admin_id = session.usuario_id;
    }

    const p = construirPayload(body, admin_id);

    const result = await env.DB.prepare(`
      INSERT INTO actividades (
        nombre,
        tipo,
        fecha_inicio,
        fecha_fin,
        activa,
        titulo_publico,
        subtitulo_publico,
        descripcion_corta,
        lugar,
        direccion_postal,
        latitud,
        longitud,
        zoom_mapa,
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
        borrador_tecnico
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      p.nombre,
      p.tipo,
      p.fecha_inicio,
      p.fecha_fin,
      p.activa,
      p.titulo_publico,
      p.subtitulo_publico,
      p.descripcion_corta,
      p.lugar,
      p.direccion_postal,
      p.latitud,
      p.longitud,
      p.zoom_mapa,
      p.imagen_url,
      p.visible_portal,
      p.orden_portal,
      p.organizador_publico,
      p.usa_franjas,
      p.admin_id,
      p.requiere_reserva,
      p.aforo_limitado,
      p.provincia,
      p.es_recurrente,
      p.patron_recurrencia,
      p.usa_enlace_externo,
      p.enlace_externo_url,
      p.enlace_externo_texto,
      p.borrador_tecnico
    ).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo crear la actividad." }, 500);
    }

    return json({
      ok: true,
      mensaje: p.borrador_tecnico ? "Borrador técnico creado correctamente." : "Actividad creada correctamente.",
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

    let admin_id = parsearIdPositivo(body.admin_id);
    if (rol !== "SUPERADMIN") {
      admin_id = actual.admin_id;
    }
    if (rol === "SUPERADMIN" && !admin_id) {
      return json({ ok: false, error: "Debe indicar el administrador responsable." }, 400);
    }

    const p = construirPayload(body, admin_id);

    const result = await env.DB.prepare(`
      UPDATE actividades
      SET
        nombre = ?,
        tipo = ?,
        fecha_inicio = ?,
        fecha_fin = ?,
        activa = ?,
        titulo_publico = ?,
        subtitulo_publico = ?,
        descripcion_corta = ?,
        lugar = ?,
        direccion_postal = ?,
        latitud = ?,
        longitud = ?,
        zoom_mapa = ?,
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
        enlace_externo_texto = ?,
        borrador_tecnico = ?
      WHERE id = ?
    `).bind(
      p.nombre,
      p.tipo,
      p.fecha_inicio,
      p.fecha_fin,
      p.activa,
      p.titulo_publico,
      p.subtitulo_publico,
      p.descripcion_corta,
      p.lugar,
      p.direccion_postal,
      p.latitud,
      p.longitud,
      p.zoom_mapa,
      p.imagen_url,
      p.visible_portal,
      p.orden_portal,
      p.organizador_publico,
      p.admin_id,
      p.usa_franjas,
      p.requiere_reserva,
      p.aforo_limitado,
      p.provincia,
      p.es_recurrente,
      p.patron_recurrencia,
      p.usa_enlace_externo,
      p.enlace_externo_url,
      p.enlace_externo_texto,
      p.borrador_tecnico,
      id
    ).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo actualizar la actividad." }, 500);
    }

    return json({
      ok: true,
      mensaje: p.borrador_tecnico ? "Borrador técnico actualizado correctamente." : "Actividad actualizada correctamente."
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al actualizar la actividad.", detalle: error.message },
      500
    );
  }
}

export async function onRequestDelete(context) {
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
      return json({ ok: false, error: "No autorizado para eliminar esta actividad." }, 403);
    }

    if (Number(actual.borrador_tecnico || 0) !== 1) {
      return json(
        { ok: false, error: "Solo se pueden eliminar desde aquí actividades en borrador técnico." },
        400
      );
    }

    await env.DB.prepare(`
      DELETE FROM franjas
      WHERE actividad_id = ?
    `).bind(id).run();

    const result = await env.DB.prepare(`
      DELETE FROM actividades
      WHERE id = ?
        AND borrador_tecnico = 1
    `).bind(id).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo eliminar el borrador técnico." }, 500);
    }

    return json({
      ok: true,
      mensaje: "Borrador técnico eliminado correctamente."
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error al eliminar el borrador técnico.", detalle: error.message },
      500
    );
  }
}
