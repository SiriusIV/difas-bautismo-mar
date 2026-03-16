function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
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

  const sql = tieneTipoAsistente
    ? `
      SELECT
        id,
        reserva_id,
        nombre_completo,
        COALESCE(tipo_asistente, 'ALUMNO') AS tipo_asistente,
        COALESCE(categoria_edad, 'MAYOR_10') AS categoria_edad
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
        COALESCE(categoria_edad, 'MAYOR_10') AS categoria_edad
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

    const alumnos = visitantes.filter(v => v.tipo_asistente === "ALUMNO").length;
    const profesores = visitantes.filter(v => v.tipo_asistente === "PROFESOR").length;
    const mayores10 = visitantes.filter(v => v.categoria_edad === "MAYOR_10").length;
    const menores10 = visitantes.filter(v => v.categoria_edad === "MENOR_10").length;

    return json({
      ok: true,
      codigo_reserva: reserva.codigo_reserva,
      estado: reserva.estado,
      plazas_reservadas: Number(reserva.plazas_prereservadas || 0),
      prereserva_expira_en: reserva.prereserva_expira_en,
      plazas_asignadas: visitantes.length,
      resumen: {
        total: visitantes.length,
        alumnos,
        profesores,
        mayores10,
        menores10
      },
      visitantes: visitantes.map(v => ({
        id: v.id,
        reserva_id: v.reserva_id,
        nombre_completo: v.nombre_completo || "",
        tipo_asistente: v.tipo_asistente || "ALUMNO",
        categoria_edad: v.categoria_edad || "MAYOR_10"
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
