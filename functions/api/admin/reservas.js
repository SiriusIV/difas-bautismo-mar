function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function likeValue(valor) {
  return `%${valor}%`;
}

function fechaComparableISO(fechaDdMmAaaa) {
  const texto = limpiarTexto(fechaDdMmAaaa);
  if (!texto) return null;

  const partes = texto.split("/");
  if (partes.length !== 3) return null;

  const [dd, mm, yyyy] = partes.map(p => p.trim());
  if (!dd || !mm || !yyyy) return null;

  if (dd.length < 1 || mm.length < 1 || yyyy.length !== 4) return null;

  return `${yyyy.padStart(4, "0")}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function placeholders(n) {
  return Array.from({ length: n }, () => "?").join(", ");
}

function estadoBloqueaPlazas(estado) {
  return ["PENDIENTE", "CONFIRMADA"].includes(String(estado || "").toUpperCase());
}

function calcularPlazasReservadasPendientes(row) {
  const asistentes = Number(row.asistentes_cargados || 0);
  const pre = Number(row.plazas_prereservadas || 0);
  const expira = row.prereserva_expira_en;

  let vigente = false;
  if (expira) {
    const fechaExp = new Date(String(expira).replace(" ", "T"));
    if (!Number.isNaN(fechaExp.getTime())) {
      vigente = fechaExp >= new Date();
    }
  }

  if (!estadoBloqueaPlazas(row.estado)) {
    return 0;
  }

  if (!vigente) {
    return 0;
  }

  return Math.max(pre - asistentes, 0);
}

function calcularPlazasAsignadas(row) {
  if (!estadoBloqueaPlazas(row.estado)) {
    return 0;
  }
  return Number(row.asistentes_cargados || 0);
}

async function obtenerReservas(env, filtros) {
  const where = [];
  const binds = [];

  if (filtros.fecha) {
    where.push("f.fecha = ?");
    binds.push(filtros.fecha);
  }

  if (filtros.franjaId) {
    where.push("f.id = ?");
    binds.push(filtros.franjaId);
  }

  if (filtros.estado) {
    where.push("r.estado = ?");
    binds.push(filtros.estado);
  }

  if (filtros.buscar) {
    where.push(`
      (
        r.codigo_reserva LIKE ?
        OR r.centro LIKE ?
        OR r.contacto LIKE ?
        OR r.email LIKE ?
        OR r.telefono LIKE ?
      )
    `);
    const q = likeValue(filtros.buscar);
    binds.push(q, q, q, q, q);
  }

  const sql = `
    SELECT
      r.id,
      r.franja_id,
      r.codigo_reserva,
      r.estado,
      r.centro,
      r.contacto,
      r.telefono,
      r.email,
      r.observaciones,
      r.fecha_solicitud,
      r.fecha_modificacion,
      r.plazas_prereservadas,
      r.prereserva_expira_en,

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
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
          AND COALESCE(v.tipo_asistente, 'ALUMNO') = 'ALUMNO'
      ), 0) AS alumnos,

      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
          AND COALESCE(v.tipo_asistente, 'ALUMNO') = 'PROFESOR'
      ), 0) AS profesores

    FROM reservas r
    INNER JOIN franjas f
      ON f.id = r.franja_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY
      f.fecha ASC,
      f.hora_inicio ASC,
      r.fecha_solicitud ASC
  `;

  const result = await env.DB.prepare(sql).bind(...binds).all();
  return result.results || [];
}

function resumirReservas(rows) {
  const resumen = {
    total_solicitudes: rows.length,
    pendientes: 0,
    confirmadas: 0,
    rechazadas: 0,
    canceladas: 0,
    plazas_asignadas: 0
  };

  for (const row of rows) {
    const estado = String(row.estado || "").toUpperCase();

    if (estado === "PENDIENTE") resumen.pendientes += 1;
    if (estado === "CONFIRMADA") resumen.confirmadas += 1;
    if (estado === "RECHAZADA") resumen.rechazadas += 1;
    if (estado === "CANCELADA") resumen.canceladas += 1;

    resumen.plazas_asignadas += calcularPlazasAsignadas(row);
  }

  return resumen;
}

async function obtenerFranjas(env) {
  const result = await env.DB.prepare(`
    SELECT
      id,
      fecha,
      hora_inicio,
      hora_fin
    FROM franjas
    ORDER BY fecha ASC, hora_inicio ASC
  `).all();

  return result.results || [];
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);

    const filtros = {
      fecha: fechaComparableISO(url.searchParams.get("fecha") || ""),
      franjaId: (() => {
        const v = parseInt(url.searchParams.get("franja") || "", 10);
        return Number.isInteger(v) && v > 0 ? v : null;
      })(),
      estado: (() => {
        const v = limpiarTexto(url.searchParams.get("estado") || "").toUpperCase();
        return v && v !== "TODOS" ? v : null;
      })(),
      buscar: limpiarTexto(url.searchParams.get("buscar") || "")
    };

    const [rows, franjas] = await Promise.all([
      obtenerReservas(env, filtros),
      obtenerFranjas(env)
    ]);

    const reservas = rows.map(row => {
      const plazasAsignadas = calcularPlazasAsignadas(row);
      const plazasReservadas = calcularPlazasReservadasPendientes(row);

      return {
        id: row.id,
        franja_id: row.franja_id,
        codigo_reserva: row.codigo_reserva,
        estado: row.estado,
        centro: row.centro || "",
        contacto: row.contacto || "",
        telefono: row.telefono || "",
        email: row.email || "",
        observaciones: row.observaciones || "",
        fecha_solicitud: row.fecha_solicitud,
        fecha_modificacion: row.fecha_modificacion,
        fecha: row.fecha,
        hora_inicio: row.hora_inicio,
        hora_fin: row.hora_fin,
        capacidad: Number(row.capacidad || 0),
        plazas_prereservadas_historicas: Number(row.plazas_prereservadas || 0),
        prereserva_expira_en: row.prereserva_expira_en,
        plazas_reservadas: plazasReservadas,
        plazas_asignadas: plazasAsignadas,
        alumnos: Number(row.alumnos || 0),
        profesores: Number(row.profesores || 0)
      };
    });

    const resumen = resumirReservas(rows);

    return json({
      ok: true,
      filtros_aplicados: {
        fecha: filtros.fecha,
        franja: filtros.franjaId,
        estado: filtros.estado,
        buscar: filtros.buscar
      },
      resumen,
      franjas: franjas.map(f => ({
        id: f.id,
        fecha: f.fecha,
        hora_inicio: f.hora_inicio,
        hora_fin: f.hora_fin
      })),
      reservas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo cargar el panel de reservas.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
