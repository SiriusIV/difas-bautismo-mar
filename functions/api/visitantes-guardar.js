function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim().replace(/\s+/g, " ");
}

function normalizarTipoAsistente(valor) {
  const v = String(valor || "").trim().toUpperCase();
  return v === "PROFESOR" ? "PROFESOR" : "ALUMNO";
}

function normalizarCategoriaEdad(valor) {
  const v = String(valor || "").trim().toUpperCase();
  return v === "MENOR_10" ? "MENOR_10" : "MAYOR_10";
}

async function obtenerReservaPorToken(env, tokenEdicion) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      r.franja_id
    FROM reservas r
    WHERE r.token_edicion = ?
    LIMIT 1
  `;

  return await env.DB.prepare(sql).bind(tokenEdicion).first();
}

async function listarColumnasVisitantes(env) {
  const result = await env.DB.prepare(`PRAGMA table_info(visitantes)`).all();
  return (result.results || []).map(c => String(c.name || ""));
}

async function borrarVisitantesDeReserva(env, reservaId) {
  return await env.DB.prepare(`
    DELETE FROM visitantes
    WHERE reserva_id = ?
  `).bind(reservaId).run();
}

async function insertarVisitante(env, reservaId, visitante, columnasVisitantes) {
  const tieneTipoAsistente = columnasVisitantes.includes("tipo_asistente");

  if (tieneTipoAsistente) {
    const sql = `
      INSERT INTO visitantes (
        reserva_id,
        nombre_completo,
        tipo_asistente,
        categoria_edad
      )
      VALUES (?, ?, ?, ?)
    `;

    return await env.DB.prepare(sql)
      .bind(
        reservaId,
        visitante.nombre_completo,
        visitante.tipo_asistente,
        visitante.categoria_edad
      )
      .run();
  }

  const sql = `
    INSERT INTO visitantes (
      reserva_id,
      nombre_completo,
      categoria_edad
    )
    VALUES (?, ?, ?)
  `;

  return await env.DB.prepare(sql)
    .bind(
      reservaId,
      visitante.nombre_completo,
      visitante.categoria_edad
    )
    .run();
}

async function actualizarContadoresReserva(env, reservaId, visitantesNormalizados) {
  const mayores10 = visitantesNormalizados.filter(v => v.categoria_edad === "MAYOR_10").length;
  const menores10 = visitantesNormalizados.filter(v => v.categoria_edad === "MENOR_10").length;
  const personas = visitantesNormalizados.length;

  const sql = `
    UPDATE reservas
    SET
      mayores10 = ?,
      menores10 = ?,
      personas = ?,
      fecha_modificacion = datetime('now')
    WHERE id = ?
  `;

  return await env.DB.prepare(sql)
    .bind(mayores10, menores10, personas, reservaId)
    .run();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();

    const tokenEdicion = limpiarTexto(data.token_edicion);
    const visitantesEntrada = Array.isArray(data.visitantes) ? data.visitantes : [];

    if (!tokenEdicion) {
      return json(
        { ok: false, error: "Falta el token de edición." },
        { status: 400 }
      );
    }

    const reserva = await obtenerReservaPorToken(env, tokenEdicion);

    if (!reserva) {
      return json(
        { ok: false, error: "No existe ninguna solicitud con ese token." },
        { status: 404 }
      );
    }

    if (!["PENDIENTE", "CONFIRMADA"].includes(reserva.estado)) {
      return json(
        { ok: false, error: "La solicitud no permite gestionar asistentes en su estado actual." },
        { status: 400 }
      );
    }

    const visitantesNormalizados = visitantesEntrada
      .map(v => ({
        nombre_completo: limpiarTexto(v.nombre_completo),
        tipo_asistente: normalizarTipoAsistente(v.tipo_asistente),
        categoria_edad: normalizarCategoriaEdad(v.categoria_edad)
      }))
      .filter(v => v.nombre_completo !== "");

    if (visitantesNormalizados.length === 0) {
      return json(
        { ok: false, error: "Debe indicar al menos 1 visitante." },
        { status: 400 }
      );
    }

    const plazasReservadas = Number(reserva.plazas_prereservadas || 0);

    if (visitantesNormalizados.length > plazasReservadas) {
      return json(
        {
          ok: false,
          error: `No puede asignar más asistentes (${visitantesNormalizados.length}) que plazas reservadas (${plazasReservadas}).`
        },
        { status: 400 }
      );
    }

    const columnasVisitantes = await listarColumnasVisitantes(env);

    await borrarVisitantesDeReserva(env, reserva.id);

    for (const visitante of visitantesNormalizados) {
      await insertarVisitante(env, reserva.id, visitante, columnasVisitantes);
    }

    await actualizarContadoresReserva(env, reserva.id, visitantesNormalizados);

    const alumnos = visitantesNormalizados.filter(v => v.tipo_asistente === "ALUMNO").length;
    const profesores = visitantesNormalizados.filter(v => v.tipo_asistente === "PROFESOR").length;
    const mayores10 = visitantesNormalizados.filter(v => v.categoria_edad === "MAYOR_10").length;
    const menores10 = visitantesNormalizados.filter(v => v.categoria_edad === "MENOR_10").length;

    return json({
      ok: true,
      mensaje: "Asistentes guardados correctamente.",
      codigo_reserva: reserva.codigo_reserva,
      plazas_reservadas: plazasReservadas,
      plazas_asignadas: visitantesNormalizados.length,
      alumnos,
      profesores,
      mayores10,
      menores10
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error interno al guardar los asistentes.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
