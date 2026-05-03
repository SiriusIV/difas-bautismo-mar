import { getAdminSession } from "./_auth.js";
import { checkAdminActividad, getRolUsuario } from "./_permisos.js";
import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";
import { crearNotificacion } from "../_notificaciones.js";
import { enviarEmail } from "../_email.js";

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

  return `${yyyy.padStart(4, "0")}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function estadoBloqueaPlazas(estado) {
  return ["PENDIENTE", "CONFIRMADA", "SUSPENDIDA"].includes(String(estado || "").toUpperCase());
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

  if (!estadoBloqueaPlazas(row.estado)) return 0;
  if (!vigente) return 0;

  return Math.max(pre - asistentes, 0);
}

function calcularPlazasAsignadas(row) {
  if (!estadoBloqueaPlazas(row.estado)) return 0;
  return Number(row.asistentes_cargados || 0);
}

async function obtenerReservas(env, filtros) {
  const where = [];
  const binds = [];

  where.push("UPPER(TRIM(COALESCE(r.estado, ''))) <> 'CANCELADA'");

  if (filtros.fechaInicio) {
    where.push("f.fecha >= ?");
    binds.push(filtros.fechaInicio);
  }

  if (filtros.fechaFin) {
    where.push("f.fecha <= ?");
    binds.push(filtros.fechaFin);
  }

  if (filtros.actividadId) {
    where.push("r.actividad_id = ?");
    binds.push(filtros.actividadId);
  }

  if (!filtros.esSuperadmin) {
    where.push("a.admin_id = ?");
    binds.push(filtros.adminId);
  }

  if (filtros.estado) {
    where.push("r.estado = ?");
    binds.push(filtros.estado);
  }

  if (filtros.buscar) {
    where.push("r.centro = ?");
    binds.push(filtros.buscar);
  }

  const sql = `
    SELECT
      r.id,
      r.franja_id,
      r.actividad_id,
      r.codigo_reserva,
      r.token_edicion,
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

      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,

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
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY
      f.fecha ASC,
      f.hora_inicio ASC,
      r.fecha_solicitud ASC
  `;

  const result = await env.DB.prepare(sql).bind(...binds).all();
  return result.results || [];
}

async function obtenerSolicitantes(env, filtros) {
  const where = [];
  const binds = [];

  where.push("UPPER(TRIM(COALESCE(r.estado, ''))) <> 'CANCELADA'");
  where.push("TRIM(COALESCE(r.centro, '')) <> ''");

  if (!filtros.esSuperadmin) {
    where.push("a.admin_id = ?");
    binds.push(filtros.adminId);
  }

  const sql = `
    SELECT DISTINCT TRIM(r.centro) AS solicitante
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY solicitante COLLATE NOCASE ASC
  `;

  const result = await env.DB.prepare(sql).bind(...binds).all();
  return (result.results || [])
    .map((row) => limpiarTexto(row.solicitante))
    .filter(Boolean);
}

function resumirReservas(rows) {
  const resumen = {
    total_solicitudes: rows.length,
    pendientes: 0,
    confirmadas: 0,
    suspendidas: 0,
    rechazadas: 0
  };

  for (const row of rows) {
    const estado = String(row.estado || "").toUpperCase();

    if (estado === "PENDIENTE") resumen.pendientes += 1;
    if (estado === "CONFIRMADA") resumen.confirmadas += 1;
    if (estado === "SUSPENDIDA") resumen.suspendidas += 1;
    if (estado === "RECHAZADA") resumen.rechazadas += 1;
  }

  return resumen;
}

async function obtenerFranjas(env, filtros = {}) {
  let sql = `
    SELECT
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.actividad_id
    FROM franjas f
    INNER JOIN actividades a
      ON a.id = f.actividad_id
  `;
  const binds = [];
  const where = [];

  where.push(`
    EXISTS (
      SELECT 1
      FROM reservas r
      WHERE r.franja_id = f.id
        AND UPPER(TRIM(COALESCE(r.estado, ''))) <> 'CANCELADA'
    )
  `);

  if (filtros.actividadId) {
    where.push("f.actividad_id = ?");
    binds.push(filtros.actividadId);
  }

  if (!filtros.esSuperadmin) {
    where.push("a.admin_id = ?");
    binds.push(filtros.adminId);
  }

  if (where.length) {
    sql += ` WHERE ${where.join(" AND ")}`;
  }

  sql += ` ORDER BY fecha ASC, hora_inicio ASC`;

  const result = await env.DB.prepare(sql).bind(...binds).all();
  return result.results || [];
}

async function obtenerActividadIdDeReserva(env, reservaId) {
  const result = await env.DB.prepare(`
    SELECT actividad_id
    FROM reservas
    WHERE id = ?
    LIMIT 1
  `).bind(reservaId).all();

  return result?.results?.[0]?.actividad_id || null;
}

async function obtenerContextoNotificacionReserva(env, reservaId) {
  return await env.DB.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.codigo_reserva,
      r.centro,
      r.contacto,
      r.email,
      r.observaciones,
      COALESCE(a.organizador_publico, 'Organizador') AS organizador_nombre,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    WHERE r.id = ?
    LIMIT 1
  `).bind(reservaId).first();
}

function escaparHtmlCorreo(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function construirCorreoEstadoReserva(contexto = {}, nuevoEstado = "") {
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const organizador = limpiarTexto(contexto?.organizador_nombre || "el organizador");
  const saludo = limpiarTexto(contexto?.contacto)
    ? `Hola ${limpiarTexto(contexto.contacto)},`
    : "Hola,";

  let asunto = "[Reservas] Actualización de tu solicitud";
  let mensaje = `Tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada.`;

  if (nuevoEstado === "CONFIRMADA") {
    asunto = "[Reservas] Solicitud aceptada";
    mensaje = `Tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido aceptada por ${organizador}.`;
  } else if (nuevoEstado === "RECHAZADA") {
    asunto = "[Reservas] Solicitud rechazada";
    mensaje = `Tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido rechazada por ${organizador}. Revisa su estado para corregirla o decidir qué hacer a continuación.`;
  } else if (nuevoEstado === "PENDIENTE") {
    asunto = "[Reservas] Solicitud reabierta";
    mensaje = `Tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} vuelve a estar en proceso tras la revisión del organizador.`;
  }

  const observaciones = limpiarTexto(contexto?.observaciones || "");
  const texto = [
    saludo,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Organiza: ${organizador}`,
    observaciones && nuevoEstado === "RECHAZADA" ? `Observaciones: ${observaciones}` : "",
    "",
    "Puedes consultar el detalle actualizado desde tu panel de usuario."
  ].filter(Boolean).join("\n");

  const html = `
    <p>${escaparHtmlCorreo(saludo)}</p>
    <p>${escaparHtmlCorreo(mensaje)}</p>
    <p><strong>Actividad:</strong> ${escaparHtmlCorreo(actividad)}</p>
    ${codigo ? `<p><strong>Código de solicitud:</strong> ${escaparHtmlCorreo(codigo)}</p>` : ""}
    <p><strong>Organiza:</strong> ${escaparHtmlCorreo(organizador)}</p>
    ${observaciones && nuevoEstado === "RECHAZADA" ? `<p><strong>Observaciones:</strong> ${escaparHtmlCorreo(observaciones)}</p>` : ""}
    <p>Puedes consultar el detalle actualizado desde tu panel de usuario.</p>
  `;

  return { asunto, texto, html };
}

async function enviarCorreoSolicitanteCambioEstado(env, contexto = {}, nuevoEstado = "") {
  const destinatario = limpiarTexto(contexto?.email || "");
  if (!destinatario) {
    return { ok: false, skipped: true, error: "La solicitud no tiene correo de contacto." };
  }

  const correo = construirCorreoEstadoReserva(contexto, nuevoEstado);
  return await enviarEmail(env, {
    to: destinatario,
    subject: correo.asunto,
    text: correo.texto,
    html: correo.html
  });
}

async function crearNotificacionSolicitanteReservaAceptada(env, contexto = {}) {
  const usuarioId = Number(contexto?.usuario_id || 0);
  if (!(usuarioId > 0)) return { ok: false, skipped: true, error: "Solicitud sin usuario asociado." };

  return await crearNotificacion(env, {
    usuarioId,
    rolDestino: "SOLICITANTE",
    tipo: "RESERVA",
    titulo: "Solicitud aceptada",
    mensaje: `Tu solicitud para ${contexto?.actividad_nombre || "la actividad"}${contexto?.codigo_reserva ? ` (${contexto.codigo_reserva})` : ""} ha sido aceptada.`,
    urlDestino: "/usuario-panel.html"
  });
}

async function crearNotificacionSolicitanteReservaRechazada(env, contexto = {}) {
  const usuarioId = Number(contexto?.usuario_id || 0);
  if (!(usuarioId > 0)) return { ok: false, skipped: true, error: "Solicitud sin usuario asociado." };

  return await crearNotificacion(env, {
    usuarioId,
    rolDestino: "SOLICITANTE",
    tipo: "RESERVA",
    titulo: "Solicitud rechazada",
    mensaje: `Tu solicitud para ${contexto?.actividad_nombre || "la actividad"}${contexto?.codigo_reserva ? ` (${contexto.codigo_reserva})` : ""} ha sido rechazada. Revisa su estado para corregirla o decidir quÃ© hacer a continuaciÃ³n.`,
    urlDestino: "/usuario-panel.html"
  });
}

async function crearNotificacionSolicitanteReservaReabierta(env, contexto = {}) {
  const usuarioId = Number(contexto?.usuario_id || 0);
  if (!(usuarioId > 0)) return { ok: false, skipped: true, error: "Solicitud sin usuario asociado." };

  return await crearNotificacion(env, {
    usuarioId,
    rolDestino: "SOLICITANTE",
    tipo: "RESERVA",
    titulo: "Solicitud reabierta",
    mensaje: `Tu solicitud para ${contexto?.actividad_nombre || "la actividad"}${contexto?.codigo_reserva ? ` (${contexto.codigo_reserva})` : ""} vuelve a estar en proceso.`,
    urlDestino: "/usuario-panel.html"
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    await ejecutarMantenimientoReservas(env);
    const session = await getAdminSession(request, env);
    if (!session) {
      return json(
        { ok: false, error: "No autorizado." },
        { status: 401 }
      );
    }

    const url = new URL(request.url);

    const filtros = {
      fechaInicio: fechaComparableISO(url.searchParams.get("fecha_inicio") || ""),
      fechaFin: fechaComparableISO(url.searchParams.get("fecha_fin") || ""),
      actividadId: (() => {
        const v = parseInt(url.searchParams.get("actividad_id") || "", 10);
        return Number.isInteger(v) && v > 0 ? v : null;
      })(),
      estado: (() => {
        const v = limpiarTexto(url.searchParams.get("estado") || "").toUpperCase();
        return v && v !== "TODOS" ? v : null;
      })(),
      buscar: limpiarTexto(url.searchParams.get("buscar") || "")
    };

    const rol = await getRolUsuario(env, session.usuario_id);

    filtros.esSuperadmin = rol === "SUPERADMIN";
    filtros.adminId = Number(session.usuario_id || 0);

    if (filtros.actividadId) {
      await checkAdminActividad(env, session.usuario_id, filtros.actividadId);
    }

    const [rows, franjas, solicitantes] = await Promise.all([
      obtenerReservas(env, filtros),
      obtenerFranjas(env, filtros),
      obtenerSolicitantes(env, filtros)
    ]);

    const reservas = rows.map(row => ({
      id: row.id,
      franja_id: row.franja_id,
      actividad_id: row.actividad_id,
      actividad_nombre: row.actividad_nombre,
      codigo_reserva: row.codigo_reserva,
      token_edicion: row.token_edicion || "",
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
      plazas_reservadas: calcularPlazasReservadasPendientes(row),
      plazas_asignadas: calcularPlazasAsignadas(row),
      alumnos: Number(row.alumnos || 0),
      profesores: Number(row.profesores || 0)
    }));

    const resumen = resumirReservas(rows);

    return json({
      ok: true,
      filtros_aplicados: {
        fecha_inicio: filtros.fechaInicio,
        fecha_fin: filtros.fechaFin,
        actividad_id: filtros.actividadId,
        estado: filtros.estado,
        buscar: filtros.buscar
      },
      resumen,
      franjas: franjas.map(f => ({
        id: f.id,
        fecha: f.fecha,
        hora_inicio: f.hora_inicio,
        hora_fin: f.hora_fin,
        actividad_id: f.actividad_id
      })),
      solicitantes,
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

export async function onRequestPatch(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json(
        { ok: false, error: "No autorizado." },
        { status: 401 }
      );
    }

    const body = await request.json();
    const id = Number(body.id || 0);
    const accion = limpiarTexto(body.accion || "").toLowerCase();

    if (!id || !accion) {
      return json(
        { ok: false, error: "Faltan datos para ejecutar la acción." },
        { status: 400 }
      );
    }

    const actividadId = await obtenerActividadIdDeReserva(env, id);
    const contextoReserva = await obtenerContextoNotificacionReserva(env, id);

    if (!actividadId) {
      return json(
        { ok: false, error: "Reserva no encontrada o sin actividad asociada." },
        { status: 404 }
      );
    }

    await checkAdminActividad(env, session.usuario_id, actividadId);

    let nuevoEstado = null;
    if (accion === "confirmar") nuevoEstado = "CONFIRMADA";
    if (accion === "rechazar") nuevoEstado = "RECHAZADA";
    if (accion === "reabrir") nuevoEstado = "PENDIENTE";

    if (!nuevoEstado) {
      return json(
        { ok: false, error: "Acción no válida." },
        { status: 400 }
      );
    }

    const result = await env.DB.prepare(`
      UPDATE reservas
      SET estado = ?, fecha_modificacion = datetime('now')
      WHERE id = ?
    `).bind(nuevoEstado, id).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo actualizar el estado de la reserva." },
        { status: 404 }
      );
    }

    let notificacionSolicitante = { ok: false, skipped: true, error: "" };
    let correoSolicitante = { ok: false, skipped: true, error: "" };
    try {
      if (nuevoEstado === "CONFIRMADA") {
        notificacionSolicitante = await crearNotificacionSolicitanteReservaAceptada(env, contextoReserva);
      } else if (nuevoEstado === "RECHAZADA") {
        notificacionSolicitante = await crearNotificacionSolicitanteReservaRechazada(env, contextoReserva);
      } else if (nuevoEstado === "PENDIENTE") {
        notificacionSolicitante = await crearNotificacionSolicitanteReservaReabierta(env, contextoReserva);
      }
      correoSolicitante = await enviarCorreoSolicitanteCambioEstado(env, contextoReserva, nuevoEstado);
    } catch (errorNotificacion) {
      notificacionSolicitante = {
        ok: false,
        skipped: true,
        error: errorNotificacion?.message || String(errorNotificacion || "")
      };
      correoSolicitante = {
        ok: false,
        skipped: true,
        error: errorNotificacion?.message || String(errorNotificacion || "")
      };
    }

    return json({
      ok: true,
      mensaje: `Estado actualizado a ${nuevoEstado}.`,
      notificacion_solicitante: {
        creada: !!notificacionSolicitante.ok,
        error: notificacionSolicitante.ok ? "" : (notificacionSolicitante.error || "")
      },
      correo_solicitante: {
        enviado: !!correoSolicitante.ok,
        error: correoSolicitante.ok ? "" : (correoSolicitante.error || "")
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo ejecutar la acción sobre la reserva.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
