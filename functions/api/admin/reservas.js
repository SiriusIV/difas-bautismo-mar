import { getAdminSession } from "./_auth.js";
import { getUserSession } from "../usuario/_auth.js";
import { checkAdminActividad, getRolUsuario } from "./_permisos.js";
import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";
import { crearNotificacion } from "../_notificaciones.js";
import { enviarEmail } from "../_email.js";
import { asegurarTablaHistorialReservas, obtenerHistorialReservas, registrarEventoReserva } from "../_reservas_historial.js";
import { asegurarColumnaRechazoEliminaEn, calcularFechaEliminacionRechazo, formatearFechaAvisoRechazo, formatearFechaDb } from "../_reservas_rechazo_plazo.js";
import { validarDocumentacionReserva } from "../_reservas_documentacion.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarEstadoReserva(estado) {
  const valor = limpiarTexto(estado).toUpperCase();
  if (valor === "EN REVISION") return "EN_REVISION";
  return valor;
}

function normalizarEstadoDocumental(estado) {
  const valor = limpiarTexto(estado)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_");
  if (["NO_PRESENTADA", "NO_APORTADO", "NO_APORTADA", "NO_REMITIDO", "NO_REMITIDA"].includes(valor)) return "NO_PRESENTADO";
  if (valor === "NO_ENVIADA") return "NO_ENVIADO";
  if (valor === "DESACTUALIZADO" || valor === "DESACTUALIZADA") return "NO_ACTUALIZADO";
  if (valor === "EN_REVISION_DOCUMENTAL") return "EN_REVISION";
  if (valor === "VALIDADA" || valor === "APROBADO" || valor === "APROBADA") return "VALIDADO";
  return valor;
}

function estadoDocumentalSuspende(estadoDocumental) {
  return [
    "NO_INICIADO",
    "NO_COMPLETADO",
    "NO_ENVIADO",
    "NO_PRESENTADO",
    "NO_ACTUALIZADO",
    "RECHAZADA",
    "RECHAZADO"
  ].includes(normalizarEstadoDocumental(estadoDocumental));
}

function estadoDocumentalEfectivo(validacionDocumental = {}) {
  const estadosDocumentos = Array.isArray(validacionDocumental?.documentos_estado)
    ? validacionDocumental.documentos_estado
      .map((doc) => normalizarEstadoDocumental(doc?.estado))
      .filter(Boolean)
    : [];

  if (estadosDocumentos.some((estado) => estadoDocumentalSuspende(estado))) {
    return "SUSPENDIDA";
  }

  const estadoGlobal = normalizarEstadoDocumental(validacionDocumental?.estado_documental);
  if (estadoDocumentalSuspende(estadoGlobal)) return "SUSPENDIDA";
  return "EN_REVISION";
}

function estadoReservaSegunDocumentacion(estadoActual, validacionDocumental) {
  const estado = normalizarEstadoReserva(estadoActual);
  if (["BORRADOR", "CANCELADA"].includes(estado)) return estado;
  if (!validacionDocumental?.requiere_documentacion) return estado;
  if (validacionDocumental.ok) {
    return estado === "EN_REVISION" || estado === "SUSPENDIDA" ? "PENDIENTE" : estado;
  }
  return estadoDocumentalEfectivo(validacionDocumental);
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
      activo INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  try {
    await env.DB.prepare(`
      ALTER TABLE actividad_requisitos
      ADD COLUMN activo INTEGER NOT NULL DEFAULT 1
    `).run();
  } catch (error) {
    if (!String(error?.message || error || "").toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }
}

async function obtenerRequisitosActividad(env, actividadId) {
  const id = Number(actividadId || 0);
  if (!(id > 0)) return [];
  await asegurarTablaRequisitos(env);
  const result = await env.DB.prepare(`
    SELECT texto
    FROM actividad_requisitos
    WHERE actividad_id = ?
      AND COALESCE(activo, 1) = 1
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

function aplicarFiltroAdmins(where, binds, filtros = {}) {
  if (filtros.esSuperadmin) return;

  const ids = Array.isArray(filtros.adminIds)
    ? filtros.adminIds.map((id) => Number(id || 0)).filter((id) => id > 0)
    : [];

  if (String(filtros.rol || "").toUpperCase() === "SECRETARIA" && ids.length === 0) {
    where.push("1 = 0");
    return;
  }

  if (ids.length > 0) {
    where.push(`a.admin_id IN (${ids.map(() => "?").join(", ")})`);
    binds.push(...ids);
    return;
  }

  where.push("a.admin_id = ?");
  binds.push(Number(filtros.adminId || 0));
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
  return ["PENDIENTE", "EN_REVISION", "CONFIRMADA", "SUSPENDIDA"].includes(String(estado || "").toUpperCase());
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

  aplicarFiltroAdmins(where, binds, filtros);

  if (filtros.buscar) {
    where.push("r.centro = ?");
    binds.push(filtros.buscar);
  }

  const sql = `
    SELECT
      r.id,
      r.usuario_id,
      r.franja_id,
      r.actividad_id,
      COALESCE(a.admin_id, 0) AS actividad_admin_id,
      r.codigo_reserva,
      r.token_edicion,
      r.estado,
      r.centro,
      r.contacto,
      r.telefono,
      r.email,
      r.observaciones,
      COALESCE(r.observaciones_admin, '') AS observaciones_admin,
      COALESCE(us.activo, 1) AS solicitante_activo,
      r.fecha_solicitud,
      r.fecha_modificacion,
      r.plazas_prereservadas,
      r.prereserva_expira_en,

      COALESCE(f.fecha, a.fecha_inicio, '') AS fecha,
      COALESCE(f.hora_inicio, '') AS hora_inicio,
      COALESCE(f.hora_fin, '') AS hora_fin,
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
    LEFT JOIN usuarios us
      ON us.id = r.usuario_id
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

  aplicarFiltroAdmins(where, binds, filtros);

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
    const estado = normalizarEstadoReserva(row.estado);

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

  aplicarFiltroAdmins(where, binds, filtros);

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

async function obtenerSolicitanteReserva(env, reservaId) {
  const db = obtenerDbLectura(env);
  return await db.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      COALESCE(us.activo, 1) AS solicitante_activo,
      COALESCE(us.rol, '') AS solicitante_rol
    FROM reservas r
    LEFT JOIN usuarios us
      ON us.id = r.usuario_id
    WHERE r.id = ?
    LIMIT 1
  `).bind(reservaId).first();
}

async function obtenerSesionLecturaReservas(request, env) {
  const session = await getUserSession(request, env.SECRET_KEY);
  if (!session?.id) return null;

  const usuario = await env.DB.prepare(`
    SELECT id, rol, activo
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(Number(session.id || 0)).first();

  if (!usuario || Number(usuario.activo || 0) !== 1) return null;
  const rol = limpiarTexto(usuario.rol).toUpperCase();
  if (!["ADMIN", "SUPERADMIN", "SECRETARIA"].includes(rol)) return null;

  const adminIds = [];
  if (rol === "SECRETARIA") {
    const rows = await env.DB.prepare(`
      SELECT id
      FROM usuarios
      WHERE secretaria_usuario_id = ?
        AND COALESCE(modulo_secretaria, 0) = 0
        AND rol = 'ADMIN'
        AND COALESCE(activo, 1) = 1
    `).bind(Number(usuario.id || 0)).all();
    adminIds.push(...(rows?.results || []).map((row) => Number(row.id || 0)).filter((id) => id > 0));
  }

  return {
    username: session.email,
    usuario_id: Number(usuario.id || 0),
    rol,
    adminIds
  };
}

async function checkAccesoActividadReservas(env, session, actividadId) {
  const id = Number(actividadId || 0);
  if (!(id > 0)) return;

  if (session.rol === "SECRETARIA") {
    const row = await env.DB.prepare(`
      SELECT 1
      FROM actividades a
      INNER JOIN usuarios admin ON admin.id = a.admin_id
      WHERE a.id = ?
        AND admin.secretaria_usuario_id = ?
        AND COALESCE(admin.modulo_secretaria, 0) = 0
        AND admin.rol = 'ADMIN'
      LIMIT 1
    `).bind(id, Number(session.usuario_id || 0)).first();
    if (!row) throw new Error("No autorizado para esta actividad");
    return;
  }

  await checkAdminActividad(env, session.usuario_id, id);
}

async function obtenerContextoNotificacionReserva(env, reservaId) {
  const db = obtenerDbLectura(env);
  const contexto = await db.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.actividad_id,
      r.franja_id,
      COALESCE(a.admin_id, 0) AS actividad_admin_id,
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
      COALESCE(a.fecha_inicio, '') AS fecha_inicio,
      COALESCE(r.rechazo_elimina_en, '') AS rechazo_elimina_en,
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
  const fecha = formatearFechaCortaCorreo(contexto?.fecha || "");
  const horaInicio = limpiarTexto(contexto?.hora_inicio || "");
  const horaFin = limpiarTexto(contexto?.hora_fin || "");
  if (fecha && horaInicio && horaFin) return `${fecha} · ${horaInicio} - ${horaFin}`;
  if (fecha) return fecha;
  return "";
}

function formatearFechaCortaCorreo(valor) {
  const texto = limpiarTexto(valor || "");
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto);
  if (!match) return texto;
  return `${match[3]}/${match[2]}/${match[1]}`;
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
      mensaje: "Su solicitud ha sido aceptada.",
      colorFondo: "#eef8f1",
      colorBorde: "#c8ead3",
      colorEtiqueta: "#1f6f43",
      colorTitulo: "#184f34",
      colorTexto: "#2e5f45",
      colorEstadoFondo: "#198754",
      colorEstadoTexto: "#ffffff",
      cierre: `La solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido aceptada por ${organizador}.`,
      siguientesPasos: [
        "La actividad queda reservada y lista para su seguimiento desde tu panel.",
        "Si la actividad tiene aforo limitado, podrás gestionar la relación definitiva de asistentes desde esta misma solicitud.",
        "Revisa con antelación la programación y la ubicación antes del día de la actividad.",
        "Una vez finalizado el plazo de tiempo de consolidación para la asignación de las plazas reservadas:",
        "1. Si no se ha asignado ninguna plaza, la solicitud quedará CANCELADA automáticamente;",
        "2. Si se ha realizado una asignación parcial de las plazas reservadas, se podrá seguir añadiendo asistentes a mayores de los reservadoss en función de las plazas que queden disponibles en tiempo real (ya sin la reserva garantizada en su solicitud)."
      ]
    };
  }

  if (estado === "RECHAZADA") {
    const fechaEliminacionTexto = formatearFechaAvisoRechazo(contexto?.rechazo_elimina_en || "");
    return {
      asunto: `${actividad} · Solicitud rechazada`,
      etiqueta: "Solicitud rechazada",
      mensaje: "",
      colorFondo: "#fff4f1",
      colorBorde: "#f3c9bf",
      colorEtiqueta: "#ffffff",
      colorTitulo: "#7c2f16",
      colorTexto: "#7a4737",
      colorEstadoFondo: "#dc3545",
      colorEstadoTexto: "#ffffff",
      cierre: `La solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido rechazada por ${organizador}.`,
      siguientesPasos: [
        "Revisa las observaciones administrativas incluidas en este correo.",
        "Subsana lo solicitado en las observaciones y reenvía la solicitud desde tu panel de usuario.",
        fechaEliminacionTexto
          ? `Si no se subsana y reenvía antes del plazo indicado, la solicitud quedará definitivamente eliminada del sistema el ${fechaEliminacionTexto}.`
          : "Si no se subsana y reenvía dentro del plazo disponible, la solicitud quedará definitivamente eliminada del sistema.",
        "La actividad no se anula; únicamente se liberan las plazas de esta solicitud para otros solicitantes."
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
      colorEstadoFondo: "#f0b429",
      colorEstadoTexto: "#2b2b2b",
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
      colorEstadoFondo: "#0b5ed7",
      colorEstadoTexto: "#ffffff",
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
    colorEstadoFondo: "#0b5ed7",
    colorEstadoTexto: "#ffffff",
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
  const etiquetaEstadoActual = limpiarTexto(configuracion.etiqueta || "Solicitud actualizada").toUpperCase();
  const estadoBadgeHtml = `<span style="display:inline-block;padding:8px 14px;border-radius:999px;background:${configuracion.colorEstadoFondo};color:${configuracion.colorEstadoTexto};font-size:14px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;line-height:1;">${escaparHtmlCorreo(etiquetaEstadoActual)}</span>`;

  const resumenTexto = [
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Estado actual: ${etiquetaEstadoActual}`,
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
          <div style="font-size:22px;font-weight:700;color:${configuracion.colorTitulo};line-height:1.2;margin-bottom:10px;">${escaparHtmlCorreo(actividad)}</div>
          <div style="margin-bottom:${configuracion.mensaje ? "8px" : "0"};">${estadoBadgeHtml}</div>
          ${configuracion.mensaje ? `<div style="font-size:15px;font-weight:600;color:${configuracion.colorTexto};">${escaparHtmlCorreo(configuracion.mensaje)}</div>` : ""}
          ${urlPanel ? `<div style="margin-top:10px;"><a href="${escaparHtmlCorreo(urlPanel)}" style="display:inline-block;padding:9px 14px;border-radius:999px;background:#0b5ed7;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;white-space:nowrap;">Abrir panel de usuario</a></div>` : ""}
        </div>
      </div>
      <div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#ffffff;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#516274;margin-bottom:10px;">Resumen de la solicitud</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:auto;">
          <tbody>
            ${codigo ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Código</td><td style="padding:4px 0;color:#22313f;">${escaparHtmlCorreo(codigo)}</td></tr>` : ""}
            <tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:128px;">Estado actual</td><td style="padding:4px 0;color:#22313f;">${estadoBadgeHtml}</td></tr>
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
      ${String(nuevoEstado || "").toUpperCase() === "RECHAZADA" && contexto?.rechazo_elimina_en ? `
        <div style="border:1px solid #f1d58b;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#fff8e6;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#8a5b00;margin-bottom:8px;">Plazo de subsanación</div>
          <div style="font-size:14px;color:#5a4630;">Si no subsanas lo solicitado en las observaciones y reenvías la solicitud, esta solicitud quedará definitivamente eliminada del sistema el <strong>${escaparHtmlCorreo(formatearFechaAvisoRechazo(contexto.rechazo_elimina_en))}</strong>.</div>
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
    mensaje: `Tu solicitud para ${contexto?.actividad_nombre || "la actividad"}${contexto?.codigo_reserva ? ` (${contexto.codigo_reserva})` : ""} ha sido rechazada. Subsana lo indicado en las observaciones y reenvíala${contexto?.rechazo_elimina_en ? ` antes del ${formatearFechaAvisoRechazo(contexto.rechazo_elimina_en)}` : ""} para evitar su eliminación definitiva.`,
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

async function crearNotificacionSolicitanteReservaRevisionDocumental(env, contexto = {}) {
  const usuarioId = Number(contexto?.usuario_id || 0);
  if (!(usuarioId > 0)) return { ok: false, skipped: true, error: "Solicitud sin usuario asociado." };

  return await crearNotificacion(env, {
    usuarioId,
    rolDestino: "SOLICITANTE",
    tipo: "RESERVA",
    titulo: "Solicitud en revisión documental",
    mensaje: `Tu solicitud para ${contexto?.actividad_nombre || "la actividad"}${contexto?.codigo_reserva ? ` (${contexto.codigo_reserva})` : ""} queda en revisión documental hasta que la documentación obligatoria esté actualizada y validada.`,
    urlDestino: "/usuario-panel.html"
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    await asegurarColumnaObservacionesAdmin(env);
    await asegurarColumnaRechazoEliminaEn(env);
    await asegurarTablaHistorialReservas(env);
    await ejecutarMantenimientoReservas(env);
    const session = await obtenerSesionLecturaReservas(request, env);
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

    const rol = session.rol || await getRolUsuario(env, session.usuario_id);

    filtros.esSuperadmin = rol === "SUPERADMIN";
    filtros.rol = rol;
    filtros.adminId = Number(session.usuario_id || 0);
    filtros.adminIds = rol === "SECRETARIA" ? (session.adminIds || []) : [];

    if (filtros.actividadId) {
      await checkAccesoActividadReservas(env, session, filtros.actividadId);
    }

    const [rows, franjas, solicitantes] = await Promise.all([
      obtenerReservas(env, filtros),
      obtenerFranjas(env, filtros),
      obtenerSolicitantes(env, filtros)
    ]);
    const historialMap = await obtenerHistorialReservas(env, rows.map((row) => row.id));
    const requisitosMap = new Map();
    for (const actividadId of Array.from(new Set(rows.map((row) => Number(row.actividad_id || 0)).filter((id) => id > 0)))) {
      requisitosMap.set(actividadId, await obtenerRequisitosActividad(env, actividadId));
    }

    let reservas = await Promise.all(rows.map(async (row) => {
      const validacionDocumental = await validarDocumentacionReserva(env, {
        usuarioId: row.usuario_id,
        adminId: row.actividad_admin_id,
        actividadId: row.actividad_id,
        reservaId: row.id
      });
      const documentacionValidada = !!validacionDocumental?.ok;
      const estadoEfectivo = estadoReservaSegunDocumentacion(row.estado, validacionDocumental);
      return ({
      id: row.id,
      usuario_id: row.usuario_id,
      franja_id: row.franja_id,
      actividad_id: row.actividad_id,
      actividad_admin_id: row.actividad_admin_id,
      actividad_nombre: row.actividad_nombre,
      codigo_reserva: row.codigo_reserva,
      token_edicion: row.token_edicion || "",
      estado: estadoEfectivo,
      estado_real: normalizarEstadoReserva(row.estado),
      centro: row.centro || "",
      contacto: row.contacto || "",
      telefono: row.telefono || "",
      email: row.email || "",
      observaciones: row.observaciones || "",
      observaciones_admin: row.observaciones_admin || "",
      solicitante_activo: Number(row.solicitante_activo || 0) === 1 ? 1 : 0,
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
      requiere_documentacion: !!validacionDocumental?.requiere_documentacion,
      estado_documental: validacionDocumental?.estado_documental || "",
      estado_expediente_documental: validacionDocumental?.estado_expediente || "",
      documentacion_validada: documentacionValidada ? 1 : 0,
      documentacion_bloqueante: validacionDocumental?.requiere_documentacion && !documentacionValidada ? 1 : 0,
      documentos_estado: validacionDocumental?.documentos_estado || [],
      documentos_pendientes: validacionDocumental?.documentos_pendientes || [],
      requisitos_particulares: requisitosMap.get(Number(row.actividad_id || 0)) || [],
      historial_estados: historialMap.get(Number(row.id)) || []
      });
    }));

    if (filtros.estado) {
      reservas = reservas.filter((reserva) => normalizarEstadoReserva(reserva.estado) === normalizarEstadoReserva(filtros.estado));
    }

    const resumen = resumirReservas(reservas);

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
    await asegurarColumnaRechazoEliminaEn(env);
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
    const solicitanteReserva = await obtenerSolicitanteReserva(env, id);

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

    const solicitanteSuspendido =
      Number(solicitanteReserva?.usuario_id || 0) > 0 &&
      String(solicitanteReserva?.solicitante_rol || "").toUpperCase() === "SOLICITANTE" &&
      Number(solicitanteReserva?.solicitante_activo || 0) !== 1;

    if (solicitanteSuspendido && (nuevoEstado === "CONFIRMADA" || nuevoEstado === "PENDIENTE")) {
      return json(
        {
          ok: false,
          error: "No se puede readmitir ni confirmar esta solicitud mientras la cuenta del solicitante siga suspendida."
        },
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

    const validacionDocumental = await validarDocumentacionReserva(env, {
      usuarioId: contextoReserva?.usuario_id,
      adminId: contextoReserva?.actividad_admin_id,
      actividadId,
      reservaId: id
    });

    const confirmacionDiferidaPorDocumentacion = !validacionDocumental.ok && nuevoEstado === "CONFIRMADA";
    if (confirmacionDiferidaPorDocumentacion) {
      nuevoEstado = estadoReservaSegunDocumentacion(nuevoEstado, validacionDocumental);
    } else if (!validacionDocumental.ok) {
      return json(
        {
          ok: false,
          error: "La solicitud no puede resolverse hasta que la documentación obligatoria haya sido validada por sus propietarios documentales.",
          estado_documental: validacionDocumental.estado_documental || "",
          documentos_pendientes: validacionDocumental.documentos_pendientes || []
        },
        { status: 400 }
      );
    }

    const limpiarObservacionesRechazo =
      estadoActual === "RECHAZADA" && (nuevoEstado === "CONFIRMADA" || nuevoEstado === "PENDIENTE" || nuevoEstado === "EN_REVISION");
    const rechazoEliminaEn = nuevoEstado === "RECHAZADA"
      ? formatearFechaDb(calcularFechaEliminacionRechazo(contextoReserva))
      : "";

    const result = await env.DB.prepare(`
      UPDATE reservas
      SET estado = ?,
          observaciones_admin = CASE
            WHEN ? = 1 THEN ''
            WHEN ? <> '' THEN ?
            ELSE observaciones_admin
          END,
          rechazo_elimina_en = CASE
            WHEN ? = 'RECHAZADA' THEN NULLIF(?, '')
            WHEN ? = 1 THEN NULL
            ELSE rechazo_elimina_en
          END,
          fecha_modificacion = datetime('now')
      WHERE id = ?
    `).bind(
      nuevoEstado,
      limpiarObservacionesRechazo ? 1 : 0,
      observacionesAdmin,
      observacionesAdmin,
      nuevoEstado,
      rechazoEliminaEn,
      limpiarObservacionesRechazo ? 1 : 0,
      id
    ).run();

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
        observaciones_admin: limpiarObservacionesRechazo
          ? ""
          : (observacionesAdmin || contextoReserva?.observaciones_admin || ""),
        rechazo_elimina_en: rechazoEliminaEn || contextoReserva?.rechazo_elimina_en || "",
        base_url: baseUrl
      };
    try {
      if (nuevoEstado === "CONFIRMADA") {
        notificacionSolicitante = await crearNotificacionSolicitanteReservaAceptada(env, contextoNotificacion);
      } else if (nuevoEstado === "RECHAZADA") {
        notificacionSolicitante = await crearNotificacionSolicitanteReservaRechazada(env, contextoNotificacion);
      } else if (nuevoEstado === "PENDIENTE") {
        notificacionSolicitante = await crearNotificacionSolicitanteReservaReabierta(env, contextoNotificacion);
      } else if (nuevoEstado === "EN_REVISION") {
        notificacionSolicitante = await crearNotificacionSolicitanteReservaRevisionDocumental(env, contextoNotificacion);
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
      mensaje: confirmacionDiferidaPorDocumentacion
        ? "La solicitud queda en revisión documental hasta que todos los documentos obligatorios estén actualizados y validados."
        : `Estado actualizado a ${nuevoEstado}.`,
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

