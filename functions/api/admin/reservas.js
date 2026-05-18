import { getAdminSession } from "./_auth.js";
import { checkAdminActividad, getRolUsuario } from "./_permisos.js";
import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";
import { crearNotificacion } from "../_notificaciones.js";
import { enviarEmail } from "../_email.js";
import { asegurarTablaHistorialReservas, obtenerHistorialReservas, registrarEventoReserva } from "../_reservas_historial.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function esErrorColumnaDuplicada(error) {
  const texto = limpiarTexto(error?.message || error || "").toLowerCase();
  return texto.includes("duplicate column name") || texto.includes("duplicate column");
}

async function asegurarColumnaObservacionesAdmin(env) {
  try {
    await env.DB.prepare(`
      ALTER TABLE reservas
      ADD COLUMN observaciones_admin TEXT
    `).run();
  } catch (error) {
    if (!esErrorColumnaDuplicada(error)) {
      throw error;
    }
  }
}

async function asegurarTablaRequisitos(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS actividad_requisitos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actividad_id INTEGER NOT NULL,
      texto TEXT NOT NULL,
      orden INTEGER NOT NULL DEFAULT 0
    )
  `).run();
}

async function obtenerRequisitosActividad(env, actividadId) {
  const id = Number(actividadId || 0);
  if (!(id > 0)) return [];
  await asegurarTablaRequisitos(env);
  const result = await env.DB.prepare(`
    SELECT texto
    FROM actividad_requisitos
    WHERE actividad_id = ?
    ORDER BY orden ASC, id ASC
  `).bind(id).all();

  return (result.results || [])
    .map((row) => limpiarTexto(row?.texto || ""))
    .filter(Boolean);
}

function likeValue(valor) {
  return `%${valor}%`;
}

function obtenerDbLectura(env) {
  return typeof env?.DB?.withSession === "function"
    ? env.DB.withSession("first-primary")
    : env.DB;
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
  const db = obtenerDbLectura(env);
  const where = [];
  const binds = [];

  if (String(filtros.estado || "").toUpperCase() !== "CANCELADA") {
    where.push("UPPER(TRIM(COALESCE(r.estado, ''))) <> 'CANCELADA'");
    where.push("UPPER(TRIM(COALESCE(r.estado, ''))) <> 'BORRADOR'");
  }

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
      COALESCE(r.observaciones_admin, '') AS observaciones_admin,
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
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY
      f.fecha ASC,
      f.hora_inicio ASC,
      r.fecha_solicitud ASC
  `;

  const result = await db.prepare(sql).bind(...binds).all();
  return result.results || [];
}

async function obtenerSolicitantes(env, filtros) {
  const db = obtenerDbLectura(env);
  const where = [];
  const binds = [];

  where.push("UPPER(TRIM(COALESCE(r.estado, ''))) <> 'CANCELADA'");
  where.push("UPPER(TRIM(COALESCE(r.estado, ''))) <> 'BORRADOR'");
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

  const result = await db.prepare(sql).bind(...binds).all();
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
  const db = obtenerDbLectura(env);
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
        AND UPPER(TRIM(COALESCE(r.estado, ''))) <> 'BORRADOR'
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

  const result = await db.prepare(sql).bind(...binds).all();
  return result.results || [];
}

async function obtenerActividadIdDeReserva(env, reservaId) {
  const db = obtenerDbLectura(env);
  const result = await db.prepare(`
    SELECT actividad_id
    FROM reservas
    WHERE id = ?
    LIMIT 1
  `).bind(reservaId).all();

  return result?.results?.[0]?.actividad_id || null;
}

async function obtenerContextoNotificacionReserva(env, reservaId) {
  const db = obtenerDbLectura(env);
  const contexto = await db.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.actividad_id,
      r.franja_id,
      r.codigo_reserva,
      r.centro,
      r.contacto,
      COALESCE(r.telefono, '') AS telefono,
      COALESCE(NULLIF(TRIM(r.email), ''), NULLIF(TRIM(us.email), '')) AS email,
      r.observaciones,
      COALESCE(r.observaciones_admin, '') AS observaciones_admin,
      COALESCE(r.plazas_prereservadas, 0) AS plazas_prereservadas,
      r.estado,
      COALESCE(f.fecha, '') AS fecha,
      COALESCE(f.hora_inicio, '') AS hora_inicio,
      COALESCE(f.hora_fin, '') AS hora_fin,
      COALESCE(a.lugar, '') AS lugar,
      COALESCE(a.direccion_postal, '') AS direccion_postal,
      COALESCE(a.latitud, '') AS latitud,
      COALESCE(a.longitud, '') AS longitud,
      COALESCE(a.usa_franjas, 0) AS usa_franjas,
      COALESCE(a.aforo_limitado, 0) AS aforo_limitado,
      COALESCE(a.aforo_maximo, 0) AS aforo_maximo,
      COALESCE(a.organizador_publico, 'Organizador') AS organizador_nombre,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre
    FROM reservas r
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios us
      ON us.id = r.usuario_id
    WHERE r.id = ?
    LIMIT 1
  `).bind(reservaId).first();

  if (!contexto) return null;

  return {
    ...contexto,
    requisitos_particulares: await obtenerRequisitosActividad(env, contexto.actividad_id)
  };
}

function escaparHtmlCorreo(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function construirDescripcionProgramacionCorreoSolicitante(contexto = {}) {
  const fecha = limpiarTexto(contexto?.fecha || "");
  const horaInicio = limpiarTexto(contexto?.hora_inicio || "");
  const horaFin = limpiarTexto(contexto?.hora_fin || "");
  if (fecha && horaInicio && horaFin) return `${fecha} � ${horaInicio} - ${horaFin}`;
  if (fecha) return fecha;
  return "";
}


function construirUrlGoogleMapsCorreoSolicitante(contexto = {}) {
  const latitud = limpiarTexto(contexto?.latitud || "");
  const longitud = limpiarTexto(contexto?.longitud || "");
  if (latitud && longitud) {
    return `https://www.google.com/maps?q=${encodeURIComponent(`${latitud},${longitud}`)}`;
  }

  const direccion = limpiarTexto(contexto?.direccion_postal || "");
  const lugar = limpiarTexto(contexto?.lugar || "");
  const destino = direccion || lugar;
  if (!destino) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destino)}`;
}

function construirUrlPanelSolicitanteCorreo(contexto = {}) {
  const baseUrl = limpiarTexto(contexto?.base_url || "");
  if (!baseUrl) return "";
  return `${baseUrl.replace(/\/+$/, "")}/usuario-panel.html`;
}

function obtenerConfiguracionCorreoEstadoReservaSolicitante(contexto = {}, nuevoEstado = "") {
  const actividad = limpiarTexto(contexto?.actividad_nombre || "Actividad");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const organizador = limpiarTexto(contexto?.organizador_nombre || "la organización");
  const estado = limpiarTexto(nuevoEstado || contexto?.estado || "").toUpperCase();

  if (estado === "CONFIRMADA") {
    return {
      asunto: `${actividad} · Solicitud aceptada`,
      etiqueta: "Solicitud aceptada",
      mensaje: "La solicitud ha sido validada correctamente.",
      colorFondo: "#eef8f1",
      colorBorde: "#c8ead3",
      colorEtiqueta: "#1f6f43",
      colorTitulo: "#184f34",
      colorTexto: "#2e5f45",
      cierre: `La solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido aceptada por ${organizador}.`,
      siguientesPasos: [
        "La actividad queda reservada y lista para su seguimiento desde tu panel.",
        "Si la actividad tiene aforo limitado, podrás gestionar la relación definitiva de asistentes desde esta misma solicitud.",
        "Revisa con antelación la programación y la ubicación antes del día de la actividad."
      ]
    };
  }

  if (estado === "RECHAZADA") {
    return {
      asunto: `${actividad} · Solicitud rechazada`,
      etiqueta: "Solicitud rechazada",
      mensaje: "La solicitud no puede continuar en su estado actual.",
      colorFondo: "#fff4f1",
      colorBorde: "#f3c9bf",
      colorEtiqueta: "#a24a2a",
      colorTitulo: "#7c2f16",
      colorTexto: "#7a4737",
      cierre: `La solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido rechazada por ${organizador}.`,
      siguientesPasos: [
        "Revisa las observaciones administrativas incluidas en este correo.",
        "Accede a tu panel para decidir si conviene corregir la solicitud, rehacerla o dejarla sin continuidad.",
        "Si necesitas más contexto, consulta el detalle completo desde tu área de usuario."
      ]
    };
  }

  if (estado === "SUSPENDIDA") {
    return {
      asunto: `${actividad} · Solicitud suspendida`,
      etiqueta: "Solicitud suspendida",
      mensaje: "La solicitud queda temporalmente detenida hasta resolver su situación.",
      colorFondo: "#fff8e8",
      colorBorde: "#f1d58b",
      colorEtiqueta: "#8a5b00",
      colorTitulo: "#724200",
      colorTexto: "#6b5630",
      cierre: `La solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha quedado suspendida por ${organizador}.`,
      siguientesPasos: [
        "Consulta los requisitos u observaciones pendientes asociados a la actividad.",
        "La solicitud no seguirá avanzando hasta que se resuelva la causa de la suspensión.",
        "Cuando la situación quede regularizada, la actividad podrá reactivarse desde el panel."
      ]
    };
  }

  if (estado === "PENDIENTE") {
    return {
      asunto: `${actividad} · Solicitud reabierta`,
      etiqueta: "Solicitud reabierta",
      mensaje: "La solicitud vuelve a estar en revisión.",
      colorFondo: "#eef4ff",
      colorBorde: "#c9dcff",
      colorEtiqueta: "#1d4f91",
      colorTitulo: "#123a63",
      colorTexto: "#355679",
      cierre: `La solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} vuelve a estar en proceso tras la revisión del organizador.`,
      siguientesPasos: [
        "Revisa las observaciones administrativas para saber qué debe ajustarse.",
        "La solicitud permanecerá en trámite hasta que el organizador complete una nueva revisión.",
        "Puedes seguir su evolución desde tu panel de usuario."
      ]
    };
  }

  return {
    asunto: `${actividad} · Actualización de la solicitud`,
    etiqueta: "Solicitud actualizada",
    mensaje: "Se ha producido una actualización en la solicitud.",
    colorFondo: "#eef4ff",
    colorBorde: "#c9dcff",
    colorEtiqueta: "#1d4f91",
    colorTitulo: "#123a63",
    colorTexto: "#355679",
    cierre: `La solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada.`,
    siguientesPasos: [
      "Consulta el detalle actualizado desde tu panel de usuario."
    ]
  };
}

function construirCorreoEstadoReserva(contexto = {}, nuevoEstado = "") {
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const organizador = limpiarTexto(contexto?.organizador_nombre || "el organizador");
  const centro = limpiarTexto(contexto?.centro || "");
  const telefono = limpiarTexto(contexto?.telefono || "");
  const correoContacto = limpiarTexto(contexto?.email || "");
  const plazas = Number(contexto?.plazas_prereservadas || 0);
  const observacionesAdmin = limpiarTexto(contexto?.observaciones_admin || "");
  const observacionesSolicitud = limpiarTexto(contexto?.observaciones || "");
  const programacion = construirDescripcionProgramacionCorreoSolicitante(contexto);
  const direccion = limpiarTexto(contexto?.direccion_postal || "");
  const lugar = limpiarTexto(contexto?.lugar || "");
  const ubicacion = direccion || lugar;
  const urlMaps = construirUrlGoogleMapsCorreoSolicitante(contexto);
  const urlPanel = construirUrlPanelSolicitanteCorreo(contexto);
  const configuracion = obtenerConfiguracionCorreoEstadoReservaSolicitante(contexto, nuevoEstado);

  const resumenTexto = [
    codigo ? `Código de solicitud: ${codigo}` : "",
    centro ? `Centro: ${centro}` : "",
    `Organiza: ${organizador}`,
    programacion ? `Fecha y hora: ${programacion}` : "",
    plazas > 0 ? `Plazas solicitadas: ${plazas}` : "",
    ubicacion ? `Ubicación: ${ubicacion}` : "",
    urlMaps ? `Google Maps: ${urlMaps}` : "",
    telefono ? `Teléfono de contacto: ${telefono}` : "",
    correoContacto ? `Correo de contacto: ${correoContacto}` : ""
  ].filter(Boolean);

  const texto = [
    configuracion.cierre,
    "",
    `ACTIVIDAD: ${actividad}`,
    "",
    "RESUMEN DE LA SOLICITUD",
    ...resumenTexto.map((linea) => `- ${linea}`),
    "",
    observacionesAdmin ? "OBSERVACIONES DEL ADMINISTRADOR DE ACTIVIDAD" : "",
    observacionesAdmin ? observacionesAdmin : "",
    observacionesAdmin ? "" : "",
    observacionesSolicitud ? "OBSERVACIONES REGISTRADAS EN LA SOLICITUD" : "",
    observacionesSolicitud ? observacionesSolicitud : "",
    observacionesSolicitud ? "" : "",
    "SIGUIENTES PASOS",
    ...configuracion.siguientesPasos.map((linea) => `- ${linea}`),
    "",
    urlPanel ? `Panel de usuario: ${urlPanel}` : "Puedes consultar el detalle actualizado desde tu panel de usuario."
  ].filter(Boolean).join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;color:#22313f;line-height:1.45;">
      <div style="background:${configuracion.colorFondo};border:1px solid ${configuracion.colorBorde};border-radius:12px;padding:14px 16px;margin-bottom:14px;">
        <div style="min-width:0;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:${configuracion.colorEtiqueta};margin-bottom:6px;">${escaparHtmlCorreo(configuracion.etiqueta)}</div>
          <div style="font-size:22px;font-weight:700;color:${configuracion.colorTitulo};line-height:1.2;margin-bottom:6px;">${escaparHtmlCorreo(actividad)}</div>
          <div style="font-size:15px;font-weight:600;color:${configuracion.colorTexto};">${escaparHtmlCorreo(configuracion.mensaje)}</div>
          ${urlPanel ? `<div style="margin-top:10px;"><a href="${escaparHtmlCorreo(urlPanel)}" style="display:inline-block;padding:9px 14px;border-radius:999px;background:#0b5ed7;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;white-space:nowrap;">Abrir panel de usuario</a></div>` : ""}
        </div>
      </div>
      <div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#ffffff;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#516274;margin-bottom:10px;">Resumen de la solicitud</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:auto;">
          <tbody>
            ${codigo ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Código</td><td style="padding:4px 0;color:#22313f;">${escaparHtmlCorreo(codigo)}</td></tr>` : ""}
            ${centro ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Centro</td><td style="padding:4px 0;color:#22313f;">${escaparHtmlCorreo(centro)}</td></tr>` : ""}
            <tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Organiza</td><td style="padding:4px 0;color:#22313f;">${escaparHtmlCorreo(organizador)}</td></tr>
            ${programacion ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Fecha y hora</td><td style="padding:4px 0;color:#22313f;">${escaparHtmlCorreo(programacion)}</td></tr>` : ""}
            ${plazas > 0 ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Plazas</td><td style="padding:4px 0;color:#22313f;">${escaparHtmlCorreo(plazas)}</td></tr>` : ""}
            ${ubicacion ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Ubicación</td><td style="padding:4px 0;color:#22313f;">${escaparHtmlCorreo(ubicacion)}</td></tr>` : ""}
            ${urlMaps ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Mapa</td><td style="padding:4px 0;color:#22313f;"><a href="${escaparHtmlCorreo(urlMaps)}" style="color:#0b5ed7;text-decoration:none;font-weight:700;">Abrir ubicación</a></td></tr>` : ""}
            ${telefono ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Teléfono</td><td style="padding:4px 0;color:#22313f;">${escaparHtmlCorreo(telefono)}</td></tr>` : ""}
            ${correoContacto ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Correo</td><td style="padding:4px 0;color:#22313f;">${escaparHtmlCorreo(correoContacto)}</td></tr>` : ""}
          </tbody>
        </table>
      </div>
      ${urlMaps ? `
        <div style="margin-bottom:14px;border:1px solid #d8e6fb;border-radius:14px;overflow:hidden;background:linear-gradient(135deg,#f7fbff 0%,#eef4ff 100%);">
          <div style="padding:12px 16px 8px 16px;font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#1d4f91;">Ubicación de la actividad</div>
          <div style="padding:0 16px 12px 16px;font-size:14px;color:#22313f;">
            <div style="font-weight:700;color:#123a63;margin-bottom:4px;">${escaparHtmlCorreo(actividad)}</div>
            <div style="color:#4a5b6d;margin-bottom:12px;">${escaparHtmlCorreo(ubicacion || "Consulta la localización en Google Maps.")}</div>
            <a href="${escaparHtmlCorreo(urlMaps)}" style="display:inline-block;padding:9px 14px;border-radius:999px;background:#0b5ed7;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">Abrir en Google Maps</a>
          </div>
        </div>
      ` : ""}
      ${observacionesAdmin ? `
        <div style="border:1px solid #f1d58b;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#fff8e6;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#8a5b00;margin-bottom:8px;">Observaciones del administrador de actividad</div>
          <div style="font-size:14px;color:#5a4630;white-space:pre-wrap;">${escaparHtmlCorreo(observacionesAdmin)}</div>
        </div>
      ` : ""}
      ${observacionesSolicitud ? `
        <div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#ffffff;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#516274;margin-bottom:8px;">Observaciones registradas en la solicitud</div>
          <div style="font-size:14px;color:#22313f;white-space:pre-wrap;">${escaparHtmlCorreo(observacionesSolicitud)}</div>
        </div>
      ` : ""}
      <div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;background:#f8fafc;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#516274;margin-bottom:8px;">Siguientes pasos</div>
        <ul style="margin:0;padding-left:18px;color:#22313f;">
          ${configuracion.siguientesPasos.map((linea) => `<li style="margin:0 0 6px 0;">${escaparHtmlCorreo(linea)}</li>`).join("")}
        </ul>
      </div>
    </div>
  `;

  return { asunto: configuracion.asunto, texto, html };
}

async function enviarCorreoSolicitanteCambioEstado(env, contexto = {}, nuevoEstado = "") {
  const destinatario = limpiarTexto(contexto?.email || "");
  if (!destinatario) {
    return { ok: false, skipped: true, error: "La solicitud no tiene correo de contacto." };
  }

  const correoBase = construirCorreoEstadoReserva(contexto, nuevoEstado);
  const requisitos = Array.isArray(contexto?.requisitos_particulares)
    ? contexto.requisitos_particulares.map((item) => limpiarTexto(item)).filter(Boolean)
    : [];
  const incluirRequisitos = requisitos.length > 0 && nuevoEstado !== "RECHAZADA";

  const correo = !incluirRequisitos
    ? correoBase
    : (() => {
        const avisoRequisitos = "Si en el momento de comenzar la actividad no se cumplen algunos de los requisitos necesarios, la actividad no podrá desarrollarse en las condiciones previstas.";
        const bloqueTexto = [
          "",
          "REQUISITOS ASOCIADOS",
          ...requisitos.map((item, index) => `${index + 1}. ${item}`),
          "",
          avisoRequisitos
        ].join("\n");
        const bloqueHtml = `
          <div style="border:1px solid #f1d58b;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#fff8e6;">
            <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#8a5b00;margin-bottom:8px;">Requisitos asociados</div>
            <ol style="margin:0 0 10px 18px;padding:0;color:#5a4630;">${requisitos.map((item) => `<li style="margin:0 0 6px 0;">${escaparHtmlCorreo(item)}</li>`).join("")}</ol>
            <div style="font-size:14px;color:#5a4630;">${escaparHtmlCorreo(avisoRequisitos)}</div>
          </div>
        `;

        return {
          asunto: correoBase.asunto,
          texto: `${correoBase.texto}${bloqueTexto ? `\n${bloqueTexto}` : ""}`,
          html: correoBase.html.replace(
            '<div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;background:#f8fafc;">',
            `${bloqueHtml}<div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;background:#f8fafc;">`
          )
        };
      })();

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
    await asegurarColumnaObservacionesAdmin(env);
    await asegurarTablaHistorialReservas(env);
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
    const historialMap = await obtenerHistorialReservas(env, rows.map((row) => row.id));

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
      observaciones_admin: row.observaciones_admin || "",
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
      profesores: Number(row.profesores || 0),
      historial_estados: historialMap.get(Number(row.id)) || []
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
    await asegurarColumnaObservacionesAdmin(env);
    await asegurarTablaHistorialReservas(env);
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
    const observacionesAdmin = limpiarTexto(body.observaciones_admin || "");

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
    const estadoActual = limpiarTexto(contextoReserva?.estado || "").toUpperCase();

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

    const requiereObservaciones =
      nuevoEstado === "RECHAZADA" ||
      (estadoActual === "RECHAZADA" && nuevoEstado === "CONFIRMADA");

    if (requiereObservaciones && !observacionesAdmin) {
      return json(
        { ok: false, error: "Debe indicar observaciones administrativas para este cambio de estado." },
        { status: 400 }
      );
    }

    const result = await env.DB.prepare(`
      UPDATE reservas
      SET estado = ?,
          observaciones_admin = CASE
            WHEN ? <> '' THEN ?
            ELSE observaciones_admin
          END,
          fecha_modificacion = datetime('now')
      WHERE id = ?
    `).bind(nuevoEstado, observacionesAdmin, observacionesAdmin, id).run();

    if ((result?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo actualizar el estado de la reserva." },
        { status: 404 }
      );
    }

    await registrarEventoReserva(env, {
      reservaId: id,
      accion: "CAMBIO_ESTADO_ADMIN",
      estadoOrigen: estadoActual,
      estadoDestino: nuevoEstado,
      observaciones: observacionesAdmin || contextoReserva?.observaciones_admin || "",
      actorUsuarioId: session.usuario_id,
      actorRol: await getRolUsuario(env, session.usuario_id)
    });

    let notificacionSolicitante = { ok: false, skipped: true, error: "" };
    let correoSolicitante = { ok: false, skipped: true, error: "" };
      const requestUrl = new URL(request.url);
      const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
      const contextoNotificacion = {
        ...contextoReserva,
        observaciones_admin: observacionesAdmin || contextoReserva?.observaciones_admin || "",
        base_url: baseUrl
      };
    try {
      if (nuevoEstado === "CONFIRMADA") {
        notificacionSolicitante = await crearNotificacionSolicitanteReservaAceptada(env, contextoNotificacion);
      } else if (nuevoEstado === "RECHAZADA") {
        notificacionSolicitante = await crearNotificacionSolicitanteReservaRechazada(env, contextoNotificacion);
      } else if (nuevoEstado === "PENDIENTE") {
        notificacionSolicitante = await crearNotificacionSolicitanteReservaReabierta(env, contextoNotificacion);
      }
      correoSolicitante = await enviarCorreoSolicitanteCambioEstado(env, contextoNotificacion, nuevoEstado);
      if (!correoSolicitante.ok && !correoSolicitante.skipped) {
        console.error("No se pudo enviar el correo al solicitante tras cambio de estado de reserva.", {
          reserva_id: Number(id || 0),
          usuario_id: Number(contextoNotificacion?.usuario_id || 0),
          estado_destino: nuevoEstado,
          email: contextoNotificacion?.email || "",
          error: correoSolicitante.error || ""
        });
      }
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
