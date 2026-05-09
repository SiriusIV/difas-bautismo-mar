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
  if (["DE_3_A_5", "DE_6_A_10", "DE_10_A_15", "MAYOR_DE_15"].includes(edad)) {
    return edad;
  }
  if (edad === "MENOR_10") return "DE_6_A_10";
  return "MAYOR_DE_15";
}

function normalizarEnsenanzaDesdeFila(row = {}) {
  const ens = String(row.nivel_ensenanza || "").trim().toUpperCase();
  if (["NO_CORRESPONDE", "INFANTIL", "PRIMARIA", "SECUNDARIA", "BACHILLER_FP", "ESTUDIOS_SUPERIORES"].includes(ens)) {
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
      r.plazas_prereservadas,
      r.prereserva_expira_en
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

async function obtenerVisitantes(env, reservaId, columnasVisitantes) {
  const tieneTipoAsistente = columnasVisitantes.includes("tipo_asistente");
  const tienePerfilAsistente = columnasVisitantes.includes("perfil_asistente");
  const tieneNivelEnsenanza = columnasVisitantes.includes("nivel_ensenanza");

  const sql = tieneTipoAsistente || tienePerfilAsistente || tieneNivelEnsenanza
    ? `
      SELECT
        id,
        reserva_id,
        nombre_completo,
        ${tieneTipoAsistente ? "COALESCE(tipo_asistente, 'ALUMNO')" : "'ALUMNO'"} AS tipo_asistente,
        ${tienePerfilAsistente ? "COALESCE(perfil_asistente, 'ALUMNO')" : "'ALUMNO'"} AS perfil_asistente,
        ${tieneNivelEnsenanza ? "COALESCE(nivel_ensenanza, 'NO_CORRESPONDE')" : "'NO_CORRESPONDE'"} AS nivel_ensenanza,
        COALESCE(categoria_edad, 'MAYOR_DE_15') AS categoria_edad
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
        COALESCE(categoria_edad, 'MAYOR_DE_15') AS categoria_edad
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
    const de6a10 = visitantesNormalizados.filter(v => v.categoria_edad === "DE_6_A_10").length;
    const de10a15 = visitantesNormalizados.filter(v => v.categoria_edad === "DE_10_A_15").length;
    const mayores15 = visitantesNormalizados.filter(v => v.categoria_edad === "MAYOR_DE_15").length;

    return json({
      ok: true,
      codigo_reserva: reserva.codigo_reserva,
      estado: reserva.estado,
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
        de_6_a_10: de6a10,
        de_10_a_15: de10a15,
        mayor_de_15: mayores15
      },
      visitantes: visitantesNormalizados.map(v => ({
        id: v.id,
        reserva_id: v.reserva_id,
        nombre_completo: v.nombre_completo || "",
        perfil_asistente: v.perfil_asistente || "ALUMNO",
        nivel_ensenanza: v.nivel_ensenanza || "NO_CORRESPONDE",
        categoria_edad: v.categoria_edad || "MAYOR_DE_15"
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
