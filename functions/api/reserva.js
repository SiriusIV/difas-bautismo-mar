function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

async function obtenerReservaPorToken(env, tokenEdicion) {
  const sql = `
    SELECT
      r.id,
      r.franja_id,
      r.centro,
      r.contacto,
      r.telefono,
      r.email,
      r.mayores10,
      r.menores10,
      r.personas,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      r.observaciones,
      r.fecha_solicitud,
      r.fecha_modificacion,
      r.codigo_reserva,
      r.token_edicion,
      r.estado,

      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,

      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_cargados,

      COALESCE((
        SELECT SUM(
          CASE
            WHEN r2.estado IN ('PENDIENTE', 'CONFIRMADA') THEN
              CASE
                WHEN r2.prereserva_expira_en IS NOT NULL
                     AND datetime('now') <= datetime(r2.prereserva_expira_en)
                  THEN COALESCE(r2.plazas_prereservadas, 0)
                ELSE (
                  SELECT COUNT(*)
                  FROM visitantes v2
                  WHERE v2.reserva_id = r2.id
                )
              END
            ELSE 0
          END
        )
        FROM reservas r2
        WHERE r2.franja_id = r.franja_id
      ), 0) AS ocupadas

    FROM reservas r
    INNER JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.token_edicion = ?
    LIMIT 1
  `;

  return await env.DB.prepare(sql).bind(tokenEdicion).first();
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const tokenEdicion = String(url.searchParams.get("token") || "").trim();

    if (!tokenEdicion) {
      return json(
        { ok: false, error: "Falta el token de edición." },
        { status: 400 }
      );
    }

    const row = await obtenerReservaPorToken(env, tokenEdicion);

    if (!row) {
      return json(
        { ok: false, error: "No existe ninguna reserva con ese token." },
        { status: 404 }
      );
    }

    const capacidad = Number(row.capacidad || 0);
    const ocupadas = Number(row.ocupadas || 0);
    const disponibles = capacidad - ocupadas;

    return json({
      ok: true,
      reserva: {
        id: row.id,
        franja_id: row.franja_id,
        centro: row.centro,
        contacto: row.contacto,
        telefono: row.telefono,
        email: row.email,
        mayores10: Number(row.mayores10 || 0),
        menores10: Number(row.menores10 || 0),
        personas: Number(row.personas || 0),
        plazas_prereservadas: Number(row.plazas_prereservadas || 0),
        prereserva_expira_en: row.prereserva_expira_en,
        asistentes_cargados: Number(row.asistentes_cargados || 0),
        observaciones: row.observaciones || "",
        fecha_solicitud: row.fecha_solicitud,
        fecha_modificacion: row.fecha_modificacion,
        codigo_reserva: row.codigo_reserva,
        token_edicion: row.token_edicion,
        estado: row.estado,
        fecha: row.fecha,
        hora_inicio: row.hora_inicio,
        hora_fin: row.hora_fin,
        capacidad,
        ocupadas,
        disponibles
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error interno al recuperar la reserva.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
