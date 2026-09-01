import { asegurarColumnaRechazoBloqueado, asegurarColumnaRechazoEliminaEn } from "./_reservas_rechazo_plazo.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarPerfilDesdeFila(row = {}) {
  const perfil = String(row.perfil_asistente || "").trim().toUpperCase();
  if (perfil === "RESPONSABLE_GRUPO") return "RESPONSABLE_GRUPO";
  if (perfil === "GENERAL") return "GENERAL";

  const legacy = String(row.tipo_asistente || "").trim().toUpperCase();
  if (legacy === "PROFESOR") return "RESPONSABLE_GRUPO";
  return "ALUMNO";
}

function normalizarEdadDesdeFila(row = {}) {
  const edad = String(row.categoria_edad || "").trim().toUpperCase();
  if (["DE_3_A_5", "DE_6_A_9", "DE_10_A_14", "DE_15_A_18", "MAYOR_DE_18"].includes(edad)) {
    return edad;
  }
  if (edad === "DE_6_A_10") return "DE_6_A_9";
  if (edad === "DE_10_A_15") return "DE_10_A_14";
  if (edad === "MAYOR_DE_15") return "DE_15_A_18";
  if (edad === "MENOR_10") return "DE_6_A_9";
  return "DE_15_A_18";
}

function normalizarEnsenanzaDesdeFila(row = {}) {
  const ens = String(row.nivel_ensenanza || "").trim().toUpperCase();
  if (["NO_CORRESPONDE", "PREESCOLAR", "INFANTIL", "PRIMARIA", "SECUNDARIA", "BACHILLER_FP", "ESTUDIOS_SUPERIORES"].includes(ens)) {
    return ens;
  }
  return "NO_CORRESPONDE";
}

async function obtenerReservaPorToken(env, tokenEdicion) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado,
      COALESCE(r.rechazo_bloqueado, 0) AS rechazo_bloqueado,
      r.plazas_prereservadas,
      r.prereserva_expira_en
    FROM reservas r
    WHERE r.token_edicion = ?
    LIMIT 1
  `;

  const db = env.DB.withSession("first-primary");
  return await db.prepare(sql).bind(tokenEdicion).first();
}

async function listarColumnasVisitantes(env) {
  const result = await env.DB.prepare(`PRAGMA table_info(visitantes)`).all();
  return (result.results || []).map(c => String(c.name || ""));
}

async function asegurarColumnasDatosAmpliatorios(env) {
  const columnas = await listarColumnasVisitantes(env);
  const alterPendientes = [];
  if (!columnas.includes("nacionalidad")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN nacionalidad TEXT`);
  }
  if (!columnas.includes("dni")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN dni TEXT`);
  }
  if (!columnas.includes("email")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN email TEXT`);
  }
  if (!columnas.includes("doble_nacionalidad")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN doble_nacionalidad INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columnas.includes("segunda_nacionalidad")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN segunda_nacionalidad TEXT`);
  }
  if (!columnas.includes("nacionalidad_no_consta")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN nacionalidad_no_consta INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columnas.includes("observaciones")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN observaciones TEXT`);
  }
  if (!columnas.includes("observaciones_revision_estado")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN observaciones_revision_estado TEXT`);
  }
  for (const sentencia of alterPendientes) {
    await env.DB.prepare(sentencia).run();
  }
}

async function obtenerVisitantes(env, reservaId, columnasVisitantes) {
  const tieneTipoAsistente = columnasVisitantes.includes("tipo_asistente");
  const tienePerfilAsistente = columnasVisitantes.includes("perfil_asistente");
  const tieneNivelEnsenanza = columnasVisitantes.includes("nivel_ensenanza");
  const tieneNacionalidad = columnasVisitantes.includes("nacionalidad");
  const tieneDni = columnasVisitantes.includes("dni");
  const tieneEmail = columnasVisitantes.includes("email");
  const tieneDobleNacionalidad = columnasVisitantes.includes("doble_nacionalidad");
  const tieneSegundaNacionalidad = columnasVisitantes.includes("segunda_nacionalidad");
  const tieneNacionalidadNoConsta = columnasVisitantes.includes("nacionalidad_no_consta");
  const tieneObservaciones = columnasVisitantes.includes("observaciones");
  const tieneObservacionesRevisionEstado = columnasVisitantes.includes("observaciones_revision_estado");

  const sql = tieneTipoAsistente || tienePerfilAsistente || tieneNivelEnsenanza || tieneNacionalidad || tieneDni || tieneEmail || tieneDobleNacionalidad || tieneSegundaNacionalidad || tieneNacionalidadNoConsta || tieneObservaciones || tieneObservacionesRevisionEstado
    ? `
      SELECT
        id,
        reserva_id,
        nombre_completo,
        ${tieneTipoAsistente ? "COALESCE(tipo_asistente, 'ALUMNO')" : "'ALUMNO'"} AS tipo_asistente,
        ${tienePerfilAsistente ? "COALESCE(perfil_asistente, 'ALUMNO')" : "'ALUMNO'"} AS perfil_asistente,
        ${tieneNivelEnsenanza ? "COALESCE(nivel_ensenanza, 'NO_CORRESPONDE')" : "'NO_CORRESPONDE'"} AS nivel_ensenanza,
        ${tieneNacionalidad ? "COALESCE(nacionalidad, '')" : "''"} AS nacionalidad,
        ${tieneDni ? "COALESCE(dni, '')" : "''"} AS dni,
        ${tieneEmail ? "COALESCE(email, '')" : "''"} AS email,
        ${tieneDobleNacionalidad ? "COALESCE(doble_nacionalidad, 0)" : "0"} AS doble_nacionalidad,
        ${tieneSegundaNacionalidad ? "COALESCE(segunda_nacionalidad, '')" : "''"} AS segunda_nacionalidad,
        ${tieneNacionalidadNoConsta ? "COALESCE(nacionalidad_no_consta, 0)" : "0"} AS nacionalidad_no_consta,
        ${tieneObservaciones ? "COALESCE(observaciones, '')" : "''"} AS observaciones,
        ${tieneObservacionesRevisionEstado ? "COALESCE(observaciones_revision_estado, '')" : "''"} AS observaciones_revision_estado,
        COALESCE(categoria_edad, 'DE_15_A_18') AS categoria_edad
      FROM visitantes
      WHERE reserva_id = ?
      ORDER BY id ASC
    `
    : `
      SELECT
        id,
        reserva_id,
        nombre_completo,
        'ALUMNO' AS tipo_asistente,
        'ALUMNO' AS perfil_asistente,
        'NO_CORRESPONDE' AS nivel_ensenanza,
        '' AS nacionalidad,
        '' AS dni,
        '' AS email,
        0 AS doble_nacionalidad,
        '' AS segunda_nacionalidad,
        0 AS nacionalidad_no_consta,
        '' AS observaciones,
        '' AS observaciones_revision_estado,
        COALESCE(categoria_edad, 'DE_15_A_18') AS categoria_edad
      FROM visitantes
      WHERE reserva_id = ?
      ORDER BY id ASC
    `;

  const result = await env.DB.prepare(sql).bind(reservaId).all();
  return result.results || [];
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const tokenEdicion = limpiarTexto(url.searchParams.get("token"));
    await asegurarColumnaRechazoEliminaEn(env);
    await asegurarColumnaRechazoBloqueado(env);
    await asegurarColumnasDatosAmpliatorios(env);

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

    const estadoReserva = String(reserva.estado || "").toUpperCase();
    const rechazoSubsanable = estadoReserva === "RECHAZADA" && Number(reserva.rechazo_bloqueado || 0) !== 1;
    if (!rechazoSubsanable && !["BORRADOR", "PENDIENTE", "EN_REVISION", "PROVISIONAL", "SUSPENDIDA", "CONFIRMADA"].includes(estadoReserva)) {
      return json(
        { ok: false, error: "La solicitud no permite gestionar asistentes en su estado actual." },
        { status: 400 }
      );
    }

    const columnasVisitantes = await listarColumnasVisitantes(env);
    const visitantes = await obtenerVisitantes(env, reserva.id, columnasVisitantes);

    const visitantesNormalizados = visitantes.map((v) => ({
      ...v,
      perfil_asistente: normalizarPerfilDesdeFila(v),
      nivel_ensenanza: normalizarEnsenanzaDesdeFila(v),
      categoria_edad: normalizarEdadDesdeFila(v)
    }));

    const alumnos = visitantesNormalizados.filter(v => v.perfil_asistente === "ALUMNO").length;
    const responsablesGrupo = visitantesNormalizados.filter(v => v.perfil_asistente === "RESPONSABLE_GRUPO").length;
    const generales = visitantesNormalizados.filter(v => v.perfil_asistente === "GENERAL").length;
    const de3a5 = visitantesNormalizados.filter(v => v.categoria_edad === "DE_3_A_5").length;
    const de6a9 = visitantesNormalizados.filter(v => v.categoria_edad === "DE_6_A_9").length;
    const de10a14 = visitantesNormalizados.filter(v => v.categoria_edad === "DE_10_A_14").length;
    const de15a18 = visitantesNormalizados.filter(v => v.categoria_edad === "DE_15_A_18").length;
    const mayores18 = visitantesNormalizados.filter(v => v.categoria_edad === "MAYOR_DE_18").length;

    return json({
      ok: true,
      codigo_reserva: reserva.codigo_reserva,
      estado: reserva.estado,
      rechazo_bloqueado: Number(reserva.rechazo_bloqueado || 0),
      plazas_reservadas: Number(reserva.plazas_prereservadas || 0),
      prereserva_expira_en: reserva.prereserva_expira_en,
      plazas_asignadas: visitantesNormalizados.length,
      resumen: {
        total: visitantesNormalizados.length,
        alumnos,
        responsables_grupo: responsablesGrupo,
        generales,
        profesores: responsablesGrupo,
        de_3_a_5: de3a5,
        de_6_a_9: de6a9,
        de_10_a_14: de10a14,
        de_15_a_18: de15a18,
        mayor_de_18: mayores18
      },
      visitantes: visitantesNormalizados.map(v => ({
        id: v.id,
        reserva_id: v.reserva_id,
        nombre_completo: v.nombre_completo || "",
        perfil_asistente: v.perfil_asistente || "ALUMNO",
        nivel_ensenanza: v.nivel_ensenanza || "NO_CORRESPONDE",
        categoria_edad: v.categoria_edad || "DE_15_A_18",
        nacionalidad: v.nacionalidad || "",
        dni: v.dni || "",
        email: v.email || "",
        doble_nacionalidad: Number(v.doble_nacionalidad || 0),
        segunda_nacionalidad: v.segunda_nacionalidad || "",
        nacionalidad_no_consta: 0,
        observaciones: v.observaciones || "",
        observaciones_revision_estado: v.observaciones_revision_estado || ""
      }))
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error interno al recuperar los asistentes.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
