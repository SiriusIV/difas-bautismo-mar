export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const fecha = url.searchParams.get("fecha");
    const soloDisponibles = url.searchParams.get("solo_disponibles");

    let sql = `
      SELECT
        f.id,
        f.fecha,
        f.hora_inicio,
        f.hora_fin,
        f.capacidad,
        COUNT(r.id) AS numero_reservas,
        COALESCE(SUM(r.personas), 0) AS ocupadas,
        (f.capacidad - COALESCE(SUM(r.personas), 0)) AS disponibles
      FROM franjas f
      LEFT JOIN reservas r
        ON f.id = r.franja_id
    `;

    const condiciones = [];
    const valores = [];

    if (fecha) {
      condiciones.push("f.fecha = ?");
      valores.push(fecha);
    }

    if (condiciones.length > 0) {
      sql += " WHERE " + condiciones.join(" AND ");
    }

    sql += `
      GROUP BY f.id, f.fecha, f.hora_inicio, f.hora_fin, f.capacidad
    `;

    if (soloDisponibles === "1") {
      sql += `
        HAVING (f.capacidad - COALESCE(SUM(r.personas), 0)) > 0
      `;
    }

    sql += `
      ORDER BY f.fecha, f.hora_inicio
    `;

    let stmt = env.DB.prepare(sql);
    if (valores.length > 0) {
      stmt = stmt.bind(...valores);
    }

    const result = await stmt.all();

    return Response.json({
      ok: true,
      total: result.results.length,
      filtros: {
        fecha: fecha || null,
        solo_disponibles: soloDisponibles === "1"
      },
      franjas: result.results
    });

  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Error al obtener el resumen de franjas.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
