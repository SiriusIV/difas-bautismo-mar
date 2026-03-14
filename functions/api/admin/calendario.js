import { requireAdminSession } from "./_auth.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function normalizarTexto(valor) {
  return String(valor || "").trim();
}

function colorPorEstado(estado) {
  switch (estado) {
    case "PENDIENTE":
      return "#d39e00";
    case "CONFIRMADA":
      return "#198754";
    case "RECHAZADA":
      return "#dc3545";
    case "CANCELADA":
      return "#6c757d";
    default:
      return "#0b5ed7";
  }
}

export async function onRequestGet(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const start = normalizarTexto(url.searchParams.get("start"));
    const end = normalizarTexto(url.searchParams.get("end"));
    const estado = normalizarTexto(url.searchParams.get("estado"));
    const incluirCanceladas = url.searchParams.get("incluir_canceladas") === "1";
    const incluirRechazadas = url.searchParams.get("incluir_rechazadas") === "1";

    let sql = `
      SELECT
        r.id,
        r.codigo_reserva,
        r.token_edicion,
        r.estado,
        r.centro,
        r.contacto,
        r.telefono,
        r.email,
        r.personas,
        r.observaciones,
        r.fecha_solicitud,
        f.id AS franja_id,
        f.fecha,
        f.hora_inicio,
        f.hora_fin,
        f.capacidad
      FROM reservas r
      INNER JOIN franjas f
        ON r.franja_id = f.id
    `;

    const condiciones = [];
    const valores = [];

    if (start) {
      condiciones.push("f.fecha >= ?");
      valores.push(start.slice(0, 10));
    }

    if (end) {
      condiciones.push("f.fecha <= ?");
      valores.push(end.slice(0, 10));
    }

    if (estado) {
      condiciones.push("r.estado = ?");
      valores.push(estado);
    } else {
      const estados = ["PENDIENTE", "CONFIRMADA"];
      if (incluirRechazadas) estados.push("RECHAZADA");
      if (incluirCanceladas) estados.push("CANCELADA");

      condiciones.push(`r.estado IN (${estados.map(() => "?").join(",")})`);
      valores.push(...estados);
    }

    if (condiciones.length > 0) {
      sql += " WHERE " + condiciones.join(" AND ");
    }

    sql += `
      ORDER BY f.fecha, f.hora_inicio, r.codigo_reserva
    `;

    let stmt = env.DB.prepare(sql);
    if (valores.length > 0) {
      stmt = stmt.bind(...valores);
    }

    const result = await stmt.all();
    const rows = result.results || [];

    const eventos = rows.map(r => {
      const startISO = `${r.fecha}T${r.hora_inicio}:00`;
      const endISO = `${r.fecha}T${r.hora_fin}:00`;
      const color = colorPorEstado(r.estado);

      return {
        id: String(r.id),
        title: `${r.codigo_reserva || "SIN-COD"} · ${r.centro || "Sin centro"} · ${r.personas || 0} pers.`,
        start: startISO,
        end: endISO,
        backgroundColor: color,
        borderColor: color,
        textColor: "#ffffff",
        extendedProps: {
          codigo_reserva: r.codigo_reserva,
          token_edicion: r.token_edicion,
          estado: r.estado,
          centro: r.centro,
          contacto: r.contacto,
          telefono: r.telefono,
          email: r.email,
          personas: r.personas,
          observaciones: r.observaciones,
          fecha: r.fecha,
          hora_inicio: r.hora_inicio,
          hora_fin: r.hora_fin,
          franja_id: r.franja_id,
          capacidad: r.capacidad
        }
      };
    });

    return json({
      ok: true,
      total: eventos.length,
      eventos
    });

  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al obtener los eventos del calendario.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
