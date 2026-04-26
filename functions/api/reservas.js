export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const fecha = url.searchParams.get("fecha");
    const franjaId = url.searchParams.get("franja_id");
    const resumen = url.searchParams.get("resumen");
    const soloDisponibles = url.searchParams.get("solo_disponibles");
    const estado = (url.searchParams.get("estado") || "").trim();

    // MODO RESUMEN POR FRANJAS
    if (resumen === "1") {
      let sql = `
        SELECT
          f.id,
          f.fecha,
          f.hora_inicio,
          f.hora_fin,
          f.capacidad,
          COUNT(
            CASE
              WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN r.id
            END
          ) AS numero_reservas,
          COALESCE(SUM(
            CASE
              WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN r.personas
              ELSE 0
            END
          ), 0) AS ocupadas,
          (
            f.capacidad - COALESCE(SUM(
              CASE
                WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN r.personas
                ELSE 0
              END
            ), 0)
          ) AS disponibles
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
          HAVING (
            f.capacidad - COALESCE(SUM(
              CASE
                WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN r.personas
                ELSE 0
              END
            ), 0)
          ) > 0
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
        modo: "resumen",
        total: result.results.length,
        filtros: {
          fecha: fecha || null,
          solo_disponibles: soloDisponibles === "1"
        },
        franjas: result.results
      });
    }

    // MODO DETALLE DE SOLICITUDES / RESERVAS
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
        r.fecha_modificacion,
        r.codigo_reserva,
        r.token_edicion,
        r.estado,
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

    if (estado) {
      condiciones.push("r.estado = ?");
      valores.push(estado);
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
      modo: "detalle",
      total: result.results.length,
      filtros: {
        fecha: fecha || null,
        franja_id: franjaId || null,
        estado: estado || null
      },
      reservas: result.results
    });

  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Error al obtener datos de reservas.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
