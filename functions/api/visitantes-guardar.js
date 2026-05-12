import { registrarEventoReserva } from "./_reservas_historial.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim().replace(/\s+/g, " ");
}

function normalizarPerfilAsistente(valor) {
  const v = String(valor || "").trim().toUpperCase();
  if (!v) return "";
  if (v === "ALUMNO") return "ALUMNO";
  if (v === "RESPONSABLE_GRUPO") return "RESPONSABLE_GRUPO";
  if (v === "GENERAL") return "GENERAL";
  if (v === "PROFESOR") return "RESPONSABLE_GRUPO";
  return "";
}

function normalizarCategoriaEdad(valor) {
  const v = String(valor || "").trim().toUpperCase();
  if (!v) return "";
  if (v === "DE_3_A_5") return "DE_3_A_5";
  if (v === "DE_6_A_10" || v === "MENOR_10") return "DE_6_A_10";
  if (v === "DE_10_A_15") return "DE_10_A_15";
  if (v === "MAYOR_DE_15") return "MAYOR_DE_15";
  return "";
}

function normalizarNivelEnsenanza(valor) {
  const v = String(valor || "").trim().toUpperCase();
  if (!v) return "";
  if (v === "NO_CORRESPONDE") return "NO_CORRESPONDE";
  if (v === "INFANTIL") return "INFANTIL";
  if (v === "PRIMARIA") return "PRIMARIA";
  if (v === "SECUNDARIA") return "SECUNDARIA";
  if (v === "BACHILLER_FP") return "BACHILLER_FP";
  if (v === "ESTUDIOS_SUPERIORES") return "ESTUDIOS_SUPERIORES";
  return "";
}

async function asegurarEsquemaVisitantes(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS visitantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reserva_id INTEGER NOT NULL,
      nombre_completo TEXT NOT NULL,
      tipo_asistente TEXT,
      perfil_asistente TEXT,
      nivel_ensenanza TEXT,
      categoria_edad TEXT
    )
  `).run();

  const columnas = await listarColumnasVisitantes(env);
  const alterPendientes = [];
  if (!columnas.includes("perfil_asistente")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN perfil_asistente TEXT`);
  }
  if (!columnas.includes("nivel_ensenanza")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN nivel_ensenanza TEXT`);
  }
  for (const sentencia of alterPendientes) {
    await env.DB.prepare(sentencia).run();
  }
}

async function obtenerReservaPorToken(env, tokenEdicion) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado,
      r.franja_id,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      r.usuario_id,
      r.centro,
      r.contacto
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
  const tienePerfilAsistente = columnasVisitantes.includes("perfil_asistente");
  const tieneNivelEnsenanza = columnasVisitantes.includes("nivel_ensenanza");

  if (tieneTipoAsistente || tienePerfilAsistente || tieneNivelEnsenanza) {
    const sql = `
      INSERT INTO visitantes (
        reserva_id,
        nombre_completo,
        ${tieneTipoAsistente ? "tipo_asistente," : ""}
        ${tienePerfilAsistente ? "perfil_asistente," : ""}
        ${tieneNivelEnsenanza ? "nivel_ensenanza," : ""}
        categoria_edad
      ) VALUES (?, ?, ${tieneTipoAsistente ? "?," : ""} ${tienePerfilAsistente ? "?," : ""} ${tieneNivelEnsenanza ? "?," : ""} ?)
    `;

    const bind = [reservaId, visitante.nombre_completo];
    if (tieneTipoAsistente) {
      bind.push(visitante.perfil_asistente === "ALUMNO" ? "ALUMNO" : "PROFESOR");
    }
    if (tienePerfilAsistente) {
      bind.push(visitante.perfil_asistente);
    }
    if (tieneNivelEnsenanza) {
      bind.push(visitante.nivel_ensenanza);
    }
    bind.push(visitante.categoria_edad);

    return await env.DB.prepare(sql)
      .bind(...bind)
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

async function actualizarReservaTrasGuardar(env, reservaId) {
  const sql = `
    UPDATE reservas
    SET fecha_modificacion = datetime('now')
    WHERE id = ?
  `;

  return await env.DB.prepare(sql)
    .bind(reservaId)
    .run();
}

function calcularBloqueoReserva(row) {
  const asistentes = Number(row.asistentes_cargados || 0);
  const prereservadas = Number(row.plazas_prereservadas || 0);
  const estado = String(row.estado || "").toUpperCase();

  if (!["PENDIENTE", "CONFIRMADA"].includes(estado)) {
    return 0;
  }

  if (row.prereserva_expira_en) {
    const exp = new Date(String(row.prereserva_expira_en).replace(" ", "T"));
    if (!Number.isNaN(exp.getTime()) && exp >= new Date()) {
      return Math.max(prereservadas, asistentes);
    }
  }

  return asistentes;
}

async function obtenerBloqueoDeOtrasReservas(env, franjaId, reservaIdActual) {
  const sql = `
    SELECT
      r.id,
      r.estado,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_cargados
    FROM reservas r
    WHERE r.franja_id = ?
      AND r.id <> ?
  `;

  const result = await env.DB.prepare(sql).bind(franjaId, reservaIdActual).all();
  const rows = result.results || [];

  return rows.reduce((acc, row) => acc + calcularBloqueoReserva(row), 0);
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

    if (!["BORRADOR", "PENDIENTE", "CONFIRMADA"].includes(String(reserva.estado || "").toUpperCase())) {
      return json(
        { ok: false, error: "La solicitud no permite gestionar asistentes en su estado actual." },
        { status: 400 }
      );
    }

    const visitantesNormalizados = visitantesEntrada
      .map((v, index) => ({
        fila: index + 1,
        nombre_completo: limpiarTexto(v.nombre_completo),
        perfil_asistente: normalizarPerfilAsistente(v.perfil_asistente ?? v.tipo_asistente),
        nivel_ensenanza: normalizarNivelEnsenanza(v.nivel_ensenanza),
        categoria_edad: normalizarCategoriaEdad(v.categoria_edad)
      }))
      .filter(v => v.nombre_completo !== "");

    for (const visitante of visitantesNormalizados) {
      if (!visitante.nombre_completo || !visitante.perfil_asistente || !visitante.nivel_ensenanza || !visitante.categoria_edad) {
        return json(
          { ok: false, error: `La fila ${visitante.fila} de asistentes no está completa.` },
          { status: 400 }
        );
      }
    }

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

    await asegurarEsquemaVisitantes(env);
    const columnasVisitantes = await listarColumnasVisitantes(env);

    await borrarVisitantesDeReserva(env, reserva.id);

    for (const visitante of visitantesNormalizados) {
      await insertarVisitante(env, reserva.id, visitante, columnasVisitantes);
    }

    await actualizarReservaTrasGuardar(env, reserva.id);
    await registrarEventoReserva(env, {
      reservaId: reserva.id,
      accion: "ASISTENTES_ACTUALIZADOS",
      estadoOrigen: reserva.estado,
      estadoDestino: reserva.estado,
      observaciones: `Total asistentes: ${totalDeseado}`,
      actorUsuarioId: reserva.usuario_id,
      actorRol: "SOLICITANTE",
      actorNombre: reserva.contacto || reserva.centro || "Solicitante"
    });

    const alumnos = visitantesNormalizados.filter(v => v.perfil_asistente === "ALUMNO").length;
    const responsablesGrupo = visitantesNormalizados.filter(v => v.perfil_asistente === "RESPONSABLE_GRUPO").length;
    const generales = visitantesNormalizados.filter(v => v.perfil_asistente === "GENERAL").length;
    const de3a5 = visitantesNormalizados.filter(v => v.categoria_edad === "DE_3_A_5").length;
    const de6a10 = visitantesNormalizados.filter(v => v.categoria_edad === "DE_6_A_10").length;
    const de10a15 = visitantesNormalizados.filter(v => v.categoria_edad === "DE_10_A_15").length;
    const mayores15 = visitantesNormalizados.filter(v => v.categoria_edad === "MAYOR_DE_15").length;

    return json({
      ok: true,
      mensaje: totalDeseado === 0
        ? "Asistentes eliminados correctamente."
        : "Asistentes guardados correctamente.",
      codigo_reserva: reserva.codigo_reserva,
      capacidad_franja: capacidadFranja,
      ocupadas_por_otros: ocupadasPorOtros,
      maximo_permitido_para_esta_reserva: maximoPermitidoParaEstaReserva,
      plazas_prereservadas_historicas: Number(reserva.plazas_prereservadas || 0),
      plazas_asignadas: totalDeseado,
      alumnos,
      responsables_grupo: responsablesGrupo,
      generales,
      profesores: responsablesGrupo,
      de_3_a_5: de3a5,
      de_6_a_10: de6a10,
      de_10_a_15: de10a15,
      mayor_de_15: mayores15
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
