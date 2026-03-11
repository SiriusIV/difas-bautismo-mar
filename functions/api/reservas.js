export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const fecha = url.searchParams.get("fecha");
    const franjaId = url.searchParams.get("franja_id");

    let sql = `
      SELECT
        r.id,
        r.franja_id,
        f.fecha,
        f.hora_inicio,
        f.hora_fin,
        r.centro,
        r.contacto,
        r.telefono,
        r.email,
        r.mayores10,
        r.menores10,
        r.personas,
        r.fecha_solicitud,
        r.idempotency_key
      FROM reservas r
      INNER JOIN franjas f
        ON r.franja_id = f.id
    `;

    const condiciones = [];
    const valores = [];

    if (fecha) {
      condiciones.push("f.fecha = ?");
      valores.push(fecha);
    }

    if (franjaId) {
      condiciones.push("r.franja_id = ?");
      valores.push(parseInt(franjaId, 10));
    }

    if (condiciones.length > 0) {
      sql += " WHERE " + condiciones.join(" AND ");
    }

    sql += " ORDER BY f.fecha, f.hora_inicio, r.fecha_solicitud";

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
        franja_id: franjaId || null
      },
      reservas: result.results
    });

  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Error al obtener el listado de reservas.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
