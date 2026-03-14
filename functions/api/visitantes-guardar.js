export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();

    const tokenEdicion = (data.token_edicion || "").trim();
    const visitantes = Array.isArray(data.visitantes) ? data.visitantes : [];

    if (!tokenEdicion) {
      return Response.json(
        { ok: false, error: "Falta el token de edición." },
        { status: 400 }
      );
    }

    // Limpieza y validación básica
    const visitantesLimpios = visitantes
      .map(v => ({
        nombre_completo: (v.nombre_completo || "").trim(),
        categoria_edad: (v.categoria_edad || "").trim()
      }))
      .filter(v => v.nombre_completo !== "");

    for (const v of visitantesLimpios) {
      if (!["MAYOR_10", "MENOR_10"].includes(v.categoria_edad)) {
        return Response.json(
          { ok: false, error: "Categoría de edad no válida en uno de los asistentes." },
          { status: 400 }
        );
      }
    }

    const mayores10 = visitantesLimpios.filter(v => v.categoria_edad === "MAYOR_10").length;
    const menores10 = visitantesLimpios.filter(v => v.categoria_edad === "MENOR_10").length;
    const personasNuevas = visitantesLimpios.length;

    const session = env.DB.withSession("first-primary");

    // 1) Leer solicitud actual
    const reservaActual = await session
      .prepare(`
        SELECT
          r.id,
          r.franja_id,
          r.codigo_reserva,
          r.token_edicion,
          r.estado,
          f.fecha,
          f.hora_inicio,
          f.hora_fin,
          f.capacidad
        FROM reservas r
        INNER JOIN franjas f
          ON r.franja_id = f.id
        WHERE r.token_edicion = ?
        LIMIT 1
      `)
      .bind(tokenEdicion)
      .first();

    if (!reservaActual) {
      return Response.json(
        { ok: false, error: "No existe ninguna solicitud con ese token." },
        { status: 404 }
      );
    }

    if (!["PENDIENTE", "CONFIRMADA"].includes(reservaActual.estado)) {
      return Response.json(
        { ok: false, error: "La solicitud no está en un estado editable." },
        { status: 400 }
      );
    }

    // 2) Calcular ocupación de la franja actual excluyendo esta propia solicitud
    const ocupacion = await session
      .prepare(`
        SELECT COALESCE(SUM(personas), 0) AS ocupadas
        FROM reservas
        WHERE franja_id = ?
          AND id <> ?
          AND estado IN ('PENDIENTE', 'CONFIRMADA')
      `)
      .bind(reservaActual.franja_id, reservaActual.id)
      .first();

    const ocupadasSinEstaSolicitud = Number(ocupacion?.ocupadas || 0);
    const disponiblesEditables = Number(reservaActual.capacidad) - ocupadasSinEstaSolicitud;

    // Si la lista no está vacía, comprobar capacidad.
    // Si queda vacía, sí se permite guardar a 0.
    if (personasNuevas > 0 && personasNuevas > disponiblesEditables) {
      return Response.json(
        {
          ok: false,
          error: `No hay plazas suficientes en la franja actual. Disponibles para esta modificación: ${disponiblesEditables}. Solicitadas: ${personasNuevas}.`
        },
        { status: 400 }
      );
    }

    // 3) Borrar visitantes actuales de la solicitud
    await session
      .prepare(`
        DELETE FROM visitantes
        WHERE reserva_id = ?
      `)
      .bind(reservaActual.id)
      .run();

    // 4) Insertar nueva lista de visitantes, si hay
    for (const v of visitantesLimpios) {
      await session
        .prepare(`
          INSERT INTO visitantes (
            reserva_id,
            nombre_completo,
            categoria_edad,
            fecha_creacion,
            fecha_modificacion
          )
          VALUES (?, ?, ?, datetime('now'), datetime('now'))
        `)
        .bind(
          reservaActual.id,
          v.nombre_completo,
          v.categoria_edad
        )
        .run();
    }

    // 5) Actualizar totales en la solicitud
    await session
      .prepare(`
        UPDATE reservas
        SET
          mayores10 = ?,
          menores10 = ?,
          personas = ?,
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `)
      .bind(
        mayores10,
        menores10,
        personasNuevas,
        reservaActual.id
      )
      .run();

    // 6) Leer estado final de ocupación
    const estadoFinal = await session
      .prepare(`
        SELECT
          f.id,
          f.fecha,
          f.hora_inicio,
          f.hora_fin,
          f.capacidad,
          COALESCE(SUM(
            CASE
              WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN r.personas
              ELSE 0
            END
          ), 0) AS ocupadas,
          (
            f.capacidad - COALESCE(SUM(
              CASE
                WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA') THEN r.personas
                ELSE 0
              END
            ), 0)
          ) AS disponibles
        FROM franjas f
        LEFT JOIN reservas r
          ON f.id = r.franja_id
        WHERE f.id = ?
        GROUP BY f.id, f.fecha, f.hora_inicio, f.hora_fin, f.capacidad
      `)
      .bind(reservaActual.franja_id)
      .first();

    return Response.json({
      ok: true,
      mensaje: personasNuevas === 0
        ? "La lista de asistentes ha quedado vacía y se ha guardado correctamente."
        : "Lista de asistentes actualizada correctamente.",
      codigo_reserva: reservaActual.codigo_reserva,
      token_edicion: reservaActual.token_edicion,
      estado: reservaActual.estado,
      franja: {
        id: estadoFinal.id,
        fecha: estadoFinal.fecha,
        hora_inicio: estadoFinal.hora_inicio,
        hora_fin: estadoFinal.hora_fin
      },
      totales: {
        personas: personasNuevas,
        mayores10,
        menores10
      },
      capacidad: estadoFinal.capacidad,
      ocupadas: estadoFinal.ocupadas,
      disponibles_despues: estadoFinal.disponibles
    });

  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Error interno al guardar la lista de asistentes.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
