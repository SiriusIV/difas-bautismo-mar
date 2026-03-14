function generarTokenEdicion() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();

    const centro = (data.centro || "").trim();
    const contacto = (data.contacto || "").trim();
    const telefono = (data.telefono || "").trim();
    const email = (data.email || "").trim();
    const observaciones = (data.observaciones || "").trim();
    const franjaId = parseInt(data.franja, 10);
    const idempotencyKey = (data.idempotencyKey || "").trim();

    if (!centro || !contacto || !telefono || !email || !franjaId) {
      return Response.json(
        { ok: false, error: "Faltan campos obligatorios." },
        { status: 400 }
      );
    }

    if (!idempotencyKey) {
      return Response.json(
        { ok: false, error: "Falta la clave de idempotencia." },
        { status: 400 }
      );
    }

    const session = env.DB.withSession("first-primary");

    // 1) Si ya existe una solicitud con esta clave, devolverla
    const existente = await session
      .prepare(`
        SELECT
          r.id,
          r.franja_id,
          r.personas,
          r.codigo_reserva,
          r.token_edicion,
          r.estado,
          f.fecha,
          f.hora_inicio,
          f.hora_fin,
          f.capacidad,
          (
            f.capacidad - COALESCE((
              SELECT SUM(r2.personas)
              FROM reservas r2
              WHERE r2.franja_id = f.id
                AND r2.estado IN ('PENDIENTE', 'CONFIRMADA')
            ), 0)
          ) AS disponibles
        FROM reservas r
        JOIN franjas f
          ON f.id = r.franja_id
        WHERE r.idempotency_key = ?
        LIMIT 1
      `)
      .bind(idempotencyKey)
      .first();

    if (existente) {
      return Response.json({
        ok: true,
        duplicate: true,
        mensaje: "La solicitud ya había sido registrada anteriormente.",
        codigo_reserva: existente.codigo_reserva,
        token_edicion: existente.token_edicion,
        estado: existente.estado,
        franja: {
          id: existente.franja_id,
          fecha: existente.fecha,
          hora_inicio: existente.hora_inicio,
          hora_fin: existente.hora_fin
        },
        capacidad: existente.capacidad,
        personas_reservadas: existente.personas,
        disponibles_despues: existente.disponibles
      });
    }

    // 2) Verificar que la franja existe
    const franja = await session
      .prepare(`
        SELECT id, fecha, hora_inicio, hora_fin, capacidad
        FROM franjas
        WHERE id = ?
        LIMIT 1
      `)
      .bind(franjaId)
      .first();

    if (!franja) {
      return Response.json(
        { ok: false, error: "La franja seleccionada no existe." },
        { status: 404 }
      );
    }

    // 3) Generar token de edición
    const tokenEdicion = generarTokenEdicion();

    // 4) Insertar solicitud inicial con 0 asistentes y estado PENDIENTE
    const insertResult = await session
      .prepare(`
        INSERT INTO reservas (
          franja_id,
          centro,
          contacto,
          telefono,
          email,
          mayores10,
          menores10,
          personas,
          observaciones,
          fecha_solicitud,
          idempotency_key,
          token_edicion,
          estado,
          fecha_modificacion
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          0,
          0,
          0,
          ?,
          datetime('now'),
          ?,
          ?,
          'PENDIENTE',
          datetime('now')
        )
      `)
      .bind(
        franjaId,
        centro,
        contacto,
        telefono,
        email,
        observaciones,
        idempotencyKey,
        tokenEdicion
      )
      .run();

    const cambios = insertResult?.meta?.changes || 0;

    if (cambios === 0) {
      return Response.json(
        { ok: false, error: "No se pudo crear la solicitud." },
        { status: 500 }
      );
    }

    // 5) Obtener id insertado
    const reservaInsertada = await session
      .prepare(`
        SELECT id
        FROM reservas
        WHERE idempotency_key = ?
        LIMIT 1
      `)
      .bind(idempotencyKey)
      .first();

    if (!reservaInsertada) {
      return Response.json(
        { ok: false, error: "No se pudo recuperar la solicitud creada." },
        { status: 500 }
      );
    }

    const reservaId = reservaInsertada.id;
    const codigoReserva = `DIFAS-${String(reservaId).padStart(6, "0")}`;

    // 6) Guardar codigo_reserva
    await session
      .prepare(`
        UPDATE reservas
        SET codigo_reserva = ?
        WHERE id = ?
      `)
      .bind(codigoReserva, reservaId)
      .run();

    // 7) Leer estado final de la franja contando solo PENDIENTE y CONFIRMADA
    const estadoFranja = await session
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
      .bind(franjaId)
      .first();

    return Response.json({
      ok: true,
      mensaje: "Solicitud creada correctamente y pendiente de validación.",
      codigo_reserva: codigoReserva,
      token_edicion: tokenEdicion,
      estado: "PENDIENTE",
      franja: {
        id: estadoFranja.id,
        fecha: estadoFranja.fecha,
        hora_inicio: estadoFranja.hora_inicio,
        hora_fin: estadoFranja.hora_fin
      },
      capacidad: estadoFranja.capacidad,
      ocupadas: estadoFranja.ocupadas,
      personas_reservadas: 0,
      disponibles_despues: estadoFranja.disponibles
    });

  } catch (error) {
    if (String(error.message || "").includes("UNIQUE constraint failed")) {
      return Response.json(
        {
          ok: true,
          duplicate: true,
          mensaje: "La solicitud ya había sido procesada."
        }
      );
    }

    return Response.json(
      {
        ok: false,
        error: "Error interno del servidor.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
