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
      r.franja_id,
      r.plazas_prereservadas,
      r.prereserva_expira_en
    FROM reservas r
    WHERE r.token_edicion = ?
    LIMIT 1
  `;

  return await env.DB.prepare(sql).bind(tokenEdicion).first();
}

async function obtenerCapacidadFranja(env, franjaId) {
  const row = await env.DB.prepare(`
    SELECT id, capacidad
    FROM franjas
    WHERE id = ?
    LIMIT 1
  `).bind(franjaId).first();

  return row || null;
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

async function actualizarReservaTrasGuardar(env, reservaId, visitantesNormalizados, plazasPrereservadasPrevias) {
  const mayores10 = visitantesNormalizados.filter(v => v.categoria_edad === "MAYOR_10").length;
  const menores10 = visitantesNormalizados.filter(v => v.categoria_edad === "MENOR_10").length;
  const personas = visitantesNormalizados.length;

  const nuevasPlazasPrereservadas = Math.max(
    Number(plazasPrereservadasPrevias || 0),
    personas
  );

  const sql = `
    UPDATE reservas
    SET
      mayores10 = ?,
      menores10 = ?,
      personas = ?,
      plazas_prereservadas = ?,
      fecha_modificacion = datetime('now')
    WHERE id = ?
  `;

  return await env.DB.prepare(sql)
    .bind(
      mayores10,
      menores10,
      personas,
      nuevasPlazasPrereservadas,
      reservaId
    )
    .run();
}

async function obtenerBloqueoDeOtrasReservas(env, franjaId, reservaIdActual) {
  const sql = `
    SELECT
      COALESCE(SUM(
        CASE
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN
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
      ), 0) AS ocupadas_otros
    FROM reservas r
    WHERE r.franja_id = ?
      AND r.id <> ?
  `;

  const row = await env.DB.prepare(sql).bind(franjaId, reservaIdActual).first();
  return Number(row?.ocupadas_otros || 0);
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

    const franja = await obtenerCapacidadFranja(env, reserva.franja_id);

    if (!franja) {
      return json(
        { ok: false, error: "La franja asociada a la solicitud no existe." },
        { status: 404 }
      );
    }

    const capacidadFranja = Number(franja.capacidad || 0);
    const ocupadasPorOtros = await obtenerBloqueoDeOtrasReservas(env, reserva.franja_id, reserva.id);

    const maximoPermitidoParaEstaReserva = Math.max(capacidadFranja - ocupadasPorOtros, 0);
    const totalDeseado = visitantesNormalizados.length;

    if (totalDeseado > maximoPermitidoParaEstaReserva) {
      return json(
        {
          ok: false,
          error: `No hay plazas suficientes en la franja. Máximo asignable ahora para esta solicitud: ${maximoPermitidoParaEstaReserva}. Se intentan guardar ${totalDeseado}.`
        },
        { status: 400 }
      );
    }

    const columnasVisitantes = await listarColumnasVisitantes(env);

    await borrarVisitantesDeReserva(env, reserva.id);

    for (const visitante of visitantesNormalizados) {
      await insertarVisitante(env, reserva.id, visitante, columnasVisitantes);
    }

    await actualizarReservaTrasGuardar(
      env,
      reserva.id,
      visitantesNormalizados,
      reserva.plazas_prereservadas
    );

    const alumnos = visitantesNormalizados.filter(v => v.tipo_asistente === "ALUMNO").length;
    const profesores = visitantesNormalizados.filter(v => v.tipo_asistente === "PROFESOR").length;
    const mayores10 = visitantesNormalizados.filter(v => v.categoria_edad === "MAYOR_10").length;
    const menores10 = visitantesNormalizados.filter(v => v.categoria_edad === "MENOR_10").length;

    const plazasPrereservadasFinales = Math.max(
      Number(reserva.plazas_prereservadas || 0),
      totalDeseado
    );

    return json({
      ok: true,
      mensaje: totalDeseado === 0
        ? "Asistentes eliminados correctamente."
        : "Asistentes guardados correctamente.",
      codigo_reserva: reserva.codigo_reserva,
      capacidad_franja: capacidadFranja,
      ocupadas_por_otros: ocupadasPorOtros,
      maximo_permitido_para_esta_reserva: maximoPermitidoParaEstaReserva,
      plazas_prereservadas_historicas: plazasPrereservadasFinales,
      plazas_asignadas: totalDeseado,
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
