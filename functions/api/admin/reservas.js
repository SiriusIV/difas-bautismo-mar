function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function normalizarTexto(valor) {
  return String(valor || "").trim();
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const fecha = normalizarTexto(url.searchParams.get("fecha"));
    const franjaId = normalizarTexto(url.searchParams.get("franja_id"));
    const q = normalizarTexto(url.searchParams.get("q"));
    const estado = normalizarTexto(url.searchParams.get("estado"));

    let sql = `
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
        (
          SELECT COUNT(*)
          FROM visitantes v
          WHERE v.reserva_id = r.id
        ) AS numero_visitantes
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

    if (q) {
      condiciones.push(`
        (
          r.codigo_reserva LIKE ?
          OR r.centro LIKE ?
          OR r.contacto LIKE ?
          OR r.email LIKE ?
          OR r.telefono LIKE ?
        )
      `);
      const like = `%${q}%`;
      valores.push(like, like, like, like, like);
    }

    if (condiciones.length > 0) {
      sql += " WHERE " + condiciones.join(" AND ");
    }

    sql += `
      ORDER BY
        f.fecha ASC,
        f.hora_inicio ASC,
        r.fecha_solicitud ASC
    `;

    let stmt = env.DB.prepare(sql);
    if (valores.length > 0) {
      stmt = stmt.bind(...valores);
    }

    const result = await stmt.all();

    return json({
      ok: true,
      total: result.results.length,
      filtros: {
        fecha: fecha || null,
        franja_id: franjaId || null,
        estado: estado || null,
        q: q || null
      },
      reservas: result.results
    });

  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al obtener las reservas.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestPatch(context) {
  const { request, env } = context;

  try {
    const data = await request.json();

    const id = parseInt(data.id, 10);
    const accion = normalizarTexto(data.accion);

    if (!Number.isInteger(id) || id <= 0) {
      return json(
        { ok: false, error: "ID de reserva no válido." },
        { status: 400 }
      );
    }

    if (!accion) {
      return json(
        { ok: false, error: "Falta la acción administrativa." },
        { status: 400 }
      );
    }

    const reserva = await env.DB.prepare(`
      SELECT id, estado, codigo_reserva
      FROM reservas
      WHERE id = ?
      LIMIT 1
    `)
      .bind(id)
      .first();

    if (!reserva) {
      return json(
        { ok: false, error: "La reserva indicada no existe." },
        { status: 404 }
      );
    }

    if (accion === "cancelar") {
      if (reserva.estado === "CANCELADA") {
        return json({
          ok: true,
          mensaje: "La reserva ya estaba cancelada."
        });
      }

      const updateResult = await env.DB.prepare(`
        UPDATE reservas
        SET
          estado = 'CANCELADA',
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `)
        .bind(id)
        .run();

      if ((updateResult?.meta?.changes || 0) === 0) {
        return json(
          { ok: false, error: "No se pudo cancelar la reserva." },
          { status: 500 }
        );
      }

      return json({
        ok: true,
        mensaje: `Reserva ${reserva.codigo_reserva || id} cancelada correctamente.`
      });
    }

    if (accion === "reactivar") {
      if (reserva.estado === "ACTIVA") {
        return json({
          ok: true,
          mensaje: "La reserva ya estaba activa."
        });
      }

      const updateResult = await env.DB.prepare(`
        UPDATE reservas
        SET
          estado = 'ACTIVA',
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `)
        .bind(id)
        .run();

      if ((updateResult?.meta?.changes || 0) === 0) {
        return json(
          { ok: false, error: "No se pudo reactivar la reserva." },
          { status: 500 }
        );
      }

      return json({
        ok: true,
        mensaje: `Reserva ${reserva.codigo_reserva || id} reactivada correctamente.`
      });
    }

    return json(
      { ok: false, error: "Acción no soportada." },
      { status: 400 }
    );

  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al ejecutar la acción sobre la reserva.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
