import { requireAdminSession, getAdminSession } from "./_auth.js";
import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";
import { checkAdminActividad } from "./_permisos.js";
import { crearNotificacion } from "../_notificaciones.js";
import { enviarEmail } from "../_email.js";
import { borrarHistorialReservas, registrarEventoReserva } from "../_reservas_historial.js";
import { obtenerInicioReserva } from "../_reservas_rechazo_plazo.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function normalizarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarFecha(valor) {
  return normalizarTexto(valor);
}

function normalizarHora(valor) {
  return normalizarTexto(valor);
}

function normalizarHoraFinOpcional(valor) {
  const hora = normalizarHora(valor);
  return hora || null;
}

function parsearCapacidad(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === "") return null;
  const n = parseInt(valor, 10);
  return Number.isInteger(n) ? n : NaN;
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsearFlag(valor, defecto = 0) {
  if (valor === true || valor === 1 || valor === "1") return 1;
  if (valor === false || valor === 0 || valor === "0") return 0;
  return defecto;
}

function esErrorColumnaDuplicada(error) {
  const texto = normalizarTexto(error?.message || error || "").toLowerCase();
  return texto.includes("duplicate column name") || texto.includes("duplicate column");
}

function dbPrimaria(env) {
  if (typeof env?.DB?.withSession === "function") {
    return env.DB.withSession("first-primary");
  }
  return env.DB;
}

async function asegurarEstructuraEstadoFranjas(env) {
  const columnas = [
    ["activa", "INTEGER NOT NULL DEFAULT 1"],
    ["recurrencia_origen_id", "INTEGER"],
    ["recurrencia_tipo", "TEXT"],
    ["recurrencia_intervalo", "INTEGER NOT NULL DEFAULT 1"],
    ["recurrencia_weekday", "INTEGER"],
    ["recurrencia_weekdays", "TEXT"],
    ["recurrencia_ordinal", "INTEGER"],
    ["recurrencia_monthday", "INTEGER"],
    ["recurrencia_month", "INTEGER"],
    ["recurrencia_inicio", "TEXT"],
    ["recurrencia_fin", "TEXT"],
    ["recurrencia_fin_tipo", "TEXT"],
    ["recurrencia_repeticiones", "INTEGER"]
  ];

  for (const [nombre, definicion] of columnas) {
    try {
      await env.DB.prepare(`ALTER TABLE franjas ADD COLUMN ${nombre} ${definicion}`).run();
    } catch (error) {
      if (!esErrorColumnaDuplicada(error)) throw error;
    }
  }

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS franja_desactivacion_avisos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      franja_id INTEGER NOT NULL,
      actividad_id INTEGER NOT NULL,
      usuario_id INTEGER,
      email TEXT,
      contacto TEXT,
      actividad_nombre TEXT,
      organizador_nombre TEXT,
      franja_descripcion TEXT,
      notificado_reactivacion INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reactivado_at TEXT
    )
  `).run();
}

function parsearEnteroNullable(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === "") return null;
  const n = parseInt(valor, 10);
  return Number.isInteger(n) ? n : null;
}

function normalizarListaWeekdays(valor) {
  const valores = Array.isArray(valor)
    ? valor
    : String(valor || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  return [...new Set(valores
    .map((item) => parseInt(item, 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))]
    .sort((a, b) => a - b);
}

function fechaIsoLocal(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fechaHoyIso() {
  return fechaIsoLocal(new Date());
}

function crearFechaLocal(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return null;
  const [y, m, d] = String(iso).split("-").map(Number);
  const fecha = new Date(y, m - 1, d);
  if (fecha.getFullYear() !== y || fecha.getMonth() !== m - 1 || fecha.getDate() !== d) return null;
  return fecha;
}

function sumarDias(fecha, dias) {
  const siguiente = new Date(fecha);
  siguiente.setDate(siguiente.getDate() + dias);
  return siguiente;
}

function sumarMeses(fecha, meses) {
  const siguiente = new Date(fecha);
  siguiente.setMonth(siguiente.getMonth() + meses);
  return siguiente;
}

function inicioMes(fecha) {
  return new Date(fecha.getFullYear(), fecha.getMonth(), 1);
}

function finMes(fecha) {
  return new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0);
}

function finVentanaRecurrencia(dosMesesDesde = new Date()) {
  const base = inicioMes(dosMesesDesde);
  return finMes(sumarMeses(base, 1));
}

function normalizarReglaRecurrencia(data = {}) {
  const tipo = normalizarTexto(data.recurrencia_tipo).toUpperCase();
  const weekdays = normalizarListaWeekdays(data.recurrencia_weekdays || data.recurrencia_weekday);
  const weekday = weekdays.length ? weekdays[0] : parsearEnteroNullable(data.recurrencia_weekday);
  return {
    tipo,
    intervalo: Math.max(parsearEnteroNullable(data.recurrencia_intervalo) || 1, 1),
    weekday,
    weekdays,
    ordinal: parsearEnteroNullable(data.recurrencia_ordinal),
    monthday: parsearEnteroNullable(data.recurrencia_monthday),
    month: parsearEnteroNullable(data.recurrencia_month),
    inicio: normalizarFecha(data.recurrencia_inicio || data.fecha),
    fin: normalizarFecha(data.recurrencia_fin),
    fin_tipo: normalizarTexto(data.recurrencia_fin_tipo || (data.recurrencia_fin ? "FECHA" : "NUNCA")).toUpperCase(),
    repeticiones: parsearEnteroNullable(data.recurrencia_repeticiones)
  };
}

function nombreDiaSemana(weekday) {
  return ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"][Number(weekday)] || "";
}

function nombreMes(month) {
  return ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"][Number(month)] || "";
}

function nombreOrdinal(ordinal) {
  if (Number(ordinal) === -1) return "último";
  return ["", "primer", "segundo", "tercer", "cuarto"][Number(ordinal)] || "";
}

function describirReglaRecurrencia(regla = {}) {
  if (regla.tipo === "DIARIA") return regla.intervalo === 1 ? "Cada día" : `Cada ${regla.intervalo} días`;
  if (regla.tipo === "SEMANAL") {
    const dias = (regla.weekdays?.length ? regla.weekdays : [regla.weekday])
      .filter((dia) => dia !== null && dia !== undefined)
      .map(nombreDiaSemana)
      .filter(Boolean);
    const textoDias = dias.length ? dias.join(", ") : nombreDiaSemana(regla.weekday);
    return regla.intervalo === 1 ? `Cada semana (${textoDias})` : `Cada ${regla.intervalo} semanas (${textoDias})`;
  }
  if (regla.tipo === "MENSUAL_DIA_SEMANA") {
    return `${nombreOrdinal(regla.ordinal)} ${nombreDiaSemana(regla.weekday)} de cada mes`;
  }
  if (regla.tipo === "MENSUAL_DIA_MES") {
    return `Día ${regla.monthday} de cada mes`;
  }
  if (regla.tipo === "ANUAL") {
    return `Cada año, el día ${regla.monthday} de ${nombreMes(regla.month)}`;
  }
  return "";
}

function validarReglaRecurrencia(regla = {}) {
  const tipos = new Set(["DIARIA", "SEMANAL", "MENSUAL_DIA_SEMANA", "MENSUAL_DIA_MES", "ANUAL"]);
  if (!tipos.has(regla.tipo)) return "Debe seleccionar un tipo de repetición válido.";
  if (!crearFechaLocal(regla.inicio)) return "Debe indicar una fecha de inicio válida para el patrón.";
  if (!["NUNCA", "FECHA", "REPETICIONES"].includes(regla.fin_tipo || "NUNCA")) return "Debe seleccionar un modo de finalización válido.";
  if (regla.fin_tipo === "FECHA" && !crearFechaLocal(regla.fin)) return "La fecha de fin del patrón no es válida.";
  if (regla.fin_tipo === "FECHA" && regla.fin < regla.inicio) return "La fecha de fin del patrón no puede ser anterior a la fecha de inicio.";
  if (regla.fin_tipo === "REPETICIONES" && !(Number(regla.repeticiones) > 0)) return "Debe indicar un número de repeticiones mayor que 0.";
  if (regla.tipo === "SEMANAL" && (!Array.isArray(regla.weekdays) || regla.weekdays.length === 0)) {
    return "Debe seleccionar al menos un día de la semana.";
  }
  if (regla.tipo === "MENSUAL_DIA_SEMANA" && (regla.weekday === null || regla.weekday < 0 || regla.weekday > 6)) {
    return "Debe seleccionar un día de la semana válido.";
  }
  if (regla.tipo === "MENSUAL_DIA_SEMANA" && ![1, 2, 3, 4, -1].includes(Number(regla.ordinal))) {
    return "Debe seleccionar un ordinal mensual válido.";
  }
  if ((regla.tipo === "MENSUAL_DIA_MES" || regla.tipo === "ANUAL") && (regla.monthday === null || regla.monthday < 1 || regla.monthday > 31)) {
    return "Debe seleccionar un día del mes válido.";
  }
  if (regla.tipo === "ANUAL" && (regla.month === null || regla.month < 1 || regla.month > 12)) {
    return "Debe seleccionar un mes válido.";
  }
  return null;
}

function nthWeekdayOfMonth(year, monthIndex, weekday, ordinal) {
  if (Number(ordinal) === -1) {
    const fecha = new Date(year, monthIndex + 1, 0);
    while (fecha.getDay() !== Number(weekday)) fecha.setDate(fecha.getDate() - 1);
    return fecha;
  }
  const fecha = new Date(year, monthIndex, 1);
  while (fecha.getDay() !== Number(weekday)) fecha.setDate(fecha.getDate() + 1);
  fecha.setDate(fecha.getDate() + (Number(ordinal) - 1) * 7);
  return fecha.getMonth() === monthIndex ? fecha : null;
}

function generarFechasRecurrencia(regla = {}, hasta = finVentanaRecurrencia()) {
  const inicio = crearFechaLocal(regla.inicio);
  if (!inicio) return [];
  const finRegla = regla.fin_tipo === "FECHA" && regla.fin ? crearFechaLocal(regla.fin) : null;
  const limite = finRegla && finRegla < hasta ? finRegla : hasta;
  const inicioMinimo = crearFechaLocal(regla.inicio_minimo);
  const minimo = inicioMinimo && inicioMinimo > inicio ? inicioMinimo : inicio;
  const fechas = [];
  const maxRepeticiones = regla.fin_tipo === "REPETICIONES" ? Number(regla.repeticiones || 0) : null;
  const agregarFecha = (fecha) => {
    if (maxRepeticiones && fechas.length >= maxRepeticiones) return false;
    if (fecha < minimo || fecha > limite) return true;
    fechas.push(fechaIsoLocal(fecha));
    return !(maxRepeticiones && fechas.length >= maxRepeticiones);
  };

  if (regla.tipo === "DIARIA") {
    for (let actual = new Date(inicio); actual <= limite; actual = sumarDias(actual, regla.intervalo || 1)) {
      if (!agregarFecha(actual)) break;
    }
  } else if (regla.tipo === "SEMANAL") {
    const weekdays = (regla.weekdays?.length ? regla.weekdays : [regla.weekday]).map(Number).sort((a, b) => a - b);
    for (let semanaBase = new Date(inicio); semanaBase <= limite; semanaBase = sumarDias(semanaBase, 7 * (regla.intervalo || 1))) {
      const inicioSemana = sumarDias(semanaBase, -semanaBase.getDay());
      for (const weekday of weekdays) {
        const fecha = sumarDias(inicioSemana, weekday);
        if (!agregarFecha(fecha)) return [...new Set(fechas)].sort();
      }
    }
  } else if (regla.tipo === "MENSUAL_DIA_SEMANA") {
    for (let cursor = inicioMes(inicio); cursor <= limite; cursor = sumarMeses(cursor, regla.intervalo || 1)) {
      const fecha = nthWeekdayOfMonth(cursor.getFullYear(), cursor.getMonth(), regla.weekday, regla.ordinal);
      if (fecha && !agregarFecha(fecha)) break;
    }
  } else if (regla.tipo === "MENSUAL_DIA_MES") {
    for (let cursor = inicioMes(inicio); cursor <= limite; cursor = sumarMeses(cursor, regla.intervalo || 1)) {
      const fecha = new Date(cursor.getFullYear(), cursor.getMonth(), Number(regla.monthday));
      if (fecha.getMonth() === cursor.getMonth() && !agregarFecha(fecha)) break;
    }
  } else if (regla.tipo === "ANUAL") {
    for (let year = inicio.getFullYear(); year <= limite.getFullYear(); year += regla.intervalo || 1) {
      const fecha = new Date(year, Number(regla.month) - 1, Number(regla.monthday));
      if (fecha.getMonth() === Number(regla.month) - 1 && !agregarFecha(fecha)) break;
    }
  }

  return [...new Set(fechas)].sort();
}

function haFinalizadoFranja(row, ahora = new Date()) {
  const fechaHoraInicio = obtenerInicioReserva(row);
  if (!fechaHoraInicio) return false;
  if (Number.isNaN(fechaHoraInicio.getTime())) return false;
  return fechaHoraInicio.getTime() <= ahora.getTime();
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function descripcionFranja(row = {}) {
  const horaFin = normalizarTexto(row.hora_fin);
  const horario = horaFin
    ? `${normalizarTexto(row.hora_inicio)}-${horaFin}`
    : `Desde las ${normalizarTexto(row.hora_inicio)}`;
  if (Number(row.es_recurrente || 0) === 1) {
    return `${normalizarTexto(row.patron_recurrencia)} - ${horario}`.trim();
  }
  return `${normalizarTexto(row.fecha)} - ${horario}`.trim();
}

function franjaHaCambiado(existente = {}, siguiente = {}) {
  return (
    normalizarTexto(existente.fecha) !== normalizarTexto(siguiente.fecha) ||
    normalizarTexto(existente.hora_inicio) !== normalizarTexto(siguiente.hora_inicio) ||
    normalizarTexto(existente.hora_fin) !== normalizarTexto(siguiente.hora_fin) ||
    String(Number(existente.capacidad ?? "")) !== String(Number(siguiente.capacidad ?? "")) ||
    Number(existente.es_recurrente || 0) !== Number(siguiente.es_recurrente || 0) ||
    normalizarTexto(existente.patron_recurrencia) !== normalizarTexto(siguiente.patron_recurrencia) ||
    normalizarTexto(existente.recurrencia_tipo) !== normalizarTexto(siguiente.recurrencia_tipo) ||
    String(Number(existente.recurrencia_intervalo || 1)) !== String(Number(siguiente.recurrencia_intervalo || 1)) ||
    normalizarTexto(existente.recurrencia_weekday) !== normalizarTexto(siguiente.recurrencia_weekday) ||
    normalizarTexto(existente.recurrencia_weekdays) !== normalizarTexto(siguiente.recurrencia_weekdays) ||
    normalizarTexto(existente.recurrencia_ordinal) !== normalizarTexto(siguiente.recurrencia_ordinal) ||
    normalizarTexto(existente.recurrencia_monthday) !== normalizarTexto(siguiente.recurrencia_monthday) ||
    normalizarTexto(existente.recurrencia_month) !== normalizarTexto(siguiente.recurrencia_month) ||
    normalizarTexto(existente.recurrencia_inicio) !== normalizarTexto(siguiente.recurrencia_inicio) ||
    normalizarTexto(existente.recurrencia_fin) !== normalizarTexto(siguiente.recurrencia_fin) ||
    normalizarTexto(existente.recurrencia_fin_tipo) !== normalizarTexto(siguiente.recurrencia_fin_tipo) ||
    normalizarTexto(existente.recurrencia_repeticiones) !== normalizarTexto(siguiente.recurrencia_repeticiones)
  );
}

async function obtenerReservasAfectadasFranja(env, franjaId) {
  const result = await env.DB.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.codigo_reserva,
      r.contacto,
      COALESCE(NULLIF(TRIM(r.email), ''), NULLIF(TRIM(us.email), '')) AS email,
      r.estado,
      COALESCE(a.organizador_publico, 'Organizador') AS organizador_nombre,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios us
      ON us.id = r.usuario_id
    WHERE r.franja_id = ?
      AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA', 'RECHAZADA')
    ORDER BY r.id ASC
  `).bind(franjaId).all();

  return result?.results || [];
}

async function aplicarCambiosYNotificarFranja(env, reservas = [], franjaAnterior = {}, franjaNueva = {}, actor = {}) {
  const resumen = {
    total: reservas.length,
    suspendidas: 0,
    notificaciones_creadas: 0,
    correos_enviados: 0,
    incidencias: []
  };

  for (const reserva of reservas) {
    try {
      const descripcionAnterior = descripcionFranja(franjaAnterior);
      const descripcionNueva = descripcionFranja(franjaNueva);
      const actividad = normalizarTexto(reserva.actividad_nombre || "la actividad");
      const codigo = normalizarTexto(reserva.codigo_reserva || "");
      const contacto = normalizarTexto(reserva.contacto || "");
      const organizador = normalizarTexto(reserva.organizador_nombre || "el organizador");
      const estadoActual = normalizarTexto(reserva.estado).toUpperCase();
      let mensajeFinal = "";
      const mensaje = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Revisa la nueva programación y confirma que sigue encajando con tu solicitud.`;

      mensajeFinal = mensaje;
      if (estadoActual === "PENDIENTE" || estadoActual === "CONFIRMADA") {
        const update = await env.DB.prepare(`
          UPDATE reservas
          SET estado = 'SUSPENDIDA',
              fecha_modificacion = datetime('now')
          WHERE id = ?
            AND UPPER(TRIM(COALESCE(estado, ''))) IN ('PENDIENTE', 'CONFIRMADA')
        `).bind(reserva.id).run();

        if ((update?.meta?.changes || 0) > 0) {
          resumen.suspendidas += 1;
          await registrarEventoReserva(env, {
            reservaId: reserva.id,
            accion: "CAMBIO_FRANJA",
            estadoOrigen: estadoActual,
            estadoDestino: "SUSPENDIDA",
            observaciones: `Programación modificada: ${descripcionAnterior} -> ${descripcionNueva}`,
            actorUsuarioId: actor.actorUsuarioId,
            actorRol: actor.actorRol,
            actorNombre: actor.actorNombre
          });
        }

        mensajeFinal = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Tu solicitud ha pasado a estado suspendida hasta que revises la nueva programación.`;
      } else if (estadoActual === "SUSPENDIDA") {
        await registrarEventoReserva(env, {
          reservaId: reserva.id,
          accion: "CAMBIO_FRANJA",
          estadoOrigen: "SUSPENDIDA",
          estadoDestino: "SUSPENDIDA",
          observaciones: `Programación modificada: ${descripcionAnterior} -> ${descripcionNueva}`,
          actorUsuarioId: actor.actorUsuarioId,
          actorRol: actor.actorRol,
          actorNombre: actor.actorNombre
        });
        mensajeFinal = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Tu solicitud continúa suspendida y debes revisar la nueva programación.`;
      } else if (estadoActual === "RECHAZADA") {
        await registrarEventoReserva(env, {
          reservaId: reserva.id,
          accion: "CAMBIO_FRANJA",
          estadoOrigen: "RECHAZADA",
          estadoDestino: "RECHAZADA",
          observaciones: `Programación modificada: ${descripcionAnterior} -> ${descripcionNueva}`,
          actorUsuarioId: actor.actorUsuarioId,
          actorRol: actor.actorRol,
          actorNombre: actor.actorNombre
        });
        mensajeFinal = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Tu solicitud continúa rechazada, pero te avisamos para que conozcas el cambio.`;
      }

      const notificacion = await crearNotificacion(env, {
        usuarioId: Number(reserva.usuario_id || 0),
        rolDestino: "SOLICITANTE",
        tipo: "RESERVA",
        titulo: "Cambio en la franja horaria",
        mensaje: mensajeFinal,
        urlDestino: "/usuario-panel.html"
      });

      if (notificacion?.ok) {
        resumen.notificaciones_creadas += 1;
      }

      const destinatario = normalizarTexto(reserva.email || "");
      if (destinatario) {
        const saludo = contacto ? `Hola ${contacto},` : "Hola,";
        const text = [
          saludo,
          "",
          mensajeFinal,
          "",
          `Franja anterior: ${descripcionAnterior}`,
          `Franja actualizada: ${descripcionNueva}`,
          `Organiza: ${organizador}`,
          "",
          "Puedes revisar el cambio desde tu panel de usuario y decidir como proceder con tu solicitud."
        ].join("\n");

        const html = `
          <p>${escaparHtml(saludo)}</p>
          <p>${escaparHtml(mensajeFinal)}</p>
          <p><strong>Franja anterior:</strong> ${escaparHtml(descripcionAnterior)}</p>
          <p><strong>Franja actualizada:</strong> ${escaparHtml(descripcionNueva)}</p>
          <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
          <p>Puedes revisar el cambio desde tu panel de usuario y decidir como proceder con tu solicitud.</p>
        `;

        const correo = await enviarEmail(env, {
          to: destinatario,
          subject: "[Reservas] Cambio en la franja horaria de tu solicitud",
          text,
          html
        });

        if (correo?.ok) {
          resumen.correos_enviados += 1;
        } else if (!correo?.skipped) {
          resumen.incidencias.push(`Correo reserva ${reserva.id}: ${correo?.error || "error desconocido"}`);
        }
      }
    } catch (error) {
      resumen.incidencias.push(`Reserva ${reserva.id}: ${error?.message || String(error || "")}`);
    }
  }

  return resumen;
}

async function obtenerReservasFuturasFranja(env, franjaId) {
  const result = await env.DB.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.codigo_reserva,
      r.contacto,
      COALESCE(NULLIF(TRIM(r.email), ''), NULLIF(TRIM(us.email), '')) AS email,
      r.estado,
      COALESCE(a.organizador_publico, 'Organizador') AS organizador_nombre,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.es_recurrente,
      f.patron_recurrencia
    FROM reservas r
    JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios us
      ON us.id = r.usuario_id
    WHERE r.franja_id = ?
      AND (
        f.fecha IS NULL
        OR datetime(f.fecha || ' ' || COALESCE(NULLIF(f.hora_inicio, ''), '00:00')) > datetime('now')
      )
    ORDER BY r.id ASC
  `).bind(franjaId).all();

  return result?.results || [];
}

async function contarReservasHistoricasFranja(env, franjaId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM reservas r
    JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.franja_id = ?
      AND f.fecha IS NOT NULL
      AND datetime(f.fecha || ' ' || COALESCE(NULLIF(f.hora_inicio, ''), '00:00')) <= datetime('now')
  `).bind(franjaId).first();

  return Number(row?.total || 0);
}

async function obtenerFranjasDisponiblesAlternativas(env, actividadId, franjaExcluidaId) {
  const actividad = await obtenerActividad(env, actividadId);
  const aforoLimitado = Number(actividad?.aforo_limitado || 0) === 1;
  const franjas = await obtenerResumenFranjas(env, actividadId);

  return franjas
    .filter((franja) => Number(franja.id || 0) !== Number(franjaExcluidaId || 0))
    .filter((franja) => Number(franja.activa ?? 1) === 1)
    .filter((franja) => !haFinalizadoFranja(franja))
    .filter((franja) => !aforoLimitado || Number(franja.disponibles || 0) > 0)
    .map((franja) => ({
      descripcion: descripcionFranja(franja),
      disponibles: aforoLimitado ? Number(franja.disponibles || 0) : null
    }));
}

function construirTextoFranjasAlternativas(franjas = []) {
  if (!franjas.length) {
    return "Actualmente no constan otras franjas horarias con plazas disponibles para esta actividad.";
  }

  return [
    "Franjas horarias disponibles para volver a solicitar esta actividad:",
    ...franjas.map((franja) => {
      const plazas = franja.disponibles === null ? "aforo no limitado" : `${franja.disponibles} plaza(s) disponible(s)`;
      return `- ${franja.descripcion} (${plazas})`;
    })
  ].join("\n");
}

function construirHtmlFranjasAlternativas(franjas = []) {
  if (!franjas.length) {
    return "<p>Actualmente no constan otras franjas horarias con plazas disponibles para esta actividad.</p>";
  }

  return `
    <p><strong>Franjas horarias disponibles para volver a solicitar esta actividad:</strong></p>
    <ul>
      ${franjas.map((franja) => {
        const plazas = franja.disponibles === null ? "aforo no limitado" : `${franja.disponibles} plaza(s) disponible(s)`;
        return `<li>${escaparHtml(franja.descripcion)} (${escaparHtml(plazas)})</li>`;
      }).join("")}
    </ul>
  `;
}

async function eliminarReservasPorEliminacionFranja(env, reservas = [], franjaEliminada = {}, franjasAlternativas = [], motivo = "cancelada") {
  const resumen = {
    total: reservas.length,
    reservas_eliminadas: 0,
    correos_enviados: 0,
    incidencias: []
  };

  for (const reserva of reservas) {
    try {
      const destinatario = normalizarTexto(reserva.email || "");
      const actividad = normalizarTexto(reserva.actividad_nombre || "la actividad");
      const codigo = normalizarTexto(reserva.codigo_reserva || "");
      const contacto = normalizarTexto(reserva.contacto || "");
      const organizador = normalizarTexto(reserva.organizador_nombre || "el organizador");
      const franja = descripcionFranja(franjaEliminada);
      const saludo = contacto ? `Hola ${contacto},` : "Hola,";
      const accionFranja = motivo === "desactivada" ? "desactivada" : "cancelada";
      const mensaje = `La franja horaria ${franja} asociada a tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido ${accionFranja} por el organizador. La actividad continúa activa, pero tu solicitud para esa franja ha sido eliminada del sistema.`;
      const alternativasTexto = construirTextoFranjasAlternativas(franjasAlternativas);
      const alternativasHtml = construirHtmlFranjasAlternativas(franjasAlternativas);

      await borrarHistorialReservas(env, [reserva.id]);
      await env.DB.prepare(`
        DELETE FROM visitantes
        WHERE reserva_id = ?
      `).bind(reserva.id).run();

      const borrado = await env.DB.prepare(`
        DELETE FROM reservas
        WHERE id = ?
      `).bind(reserva.id).run();

      if ((borrado?.meta?.changes || 0) > 0) {
        resumen.reservas_eliminadas += 1;
      } else {
        resumen.incidencias.push(`Reserva ${reserva.id}: no se pudo eliminar tras cancelar la franja.`);
        continue;
      }

      if (destinatario) {
        const text = [
          saludo,
          "",
          mensaje,
          "",
          `Actividad: ${actividad}`,
          codigo ? `Código de solicitud: ${codigo}` : "",
          `Franja ${accionFranja}: ${franja}`,
          `Organiza: ${organizador}`,
          "",
          alternativasTexto,
          "",
          "Puedes realizar una nueva solicitud de esta actividad seleccionando una de las franjas horarias que sigan disponibles."
        ].filter(Boolean).join("\n");

        const html = `
          <p>${escaparHtml(saludo)}</p>
          <p>${escaparHtml(mensaje)}</p>
          <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
          ${codigo ? `<p><strong>Código de solicitud:</strong> ${escaparHtml(codigo)}</p>` : ""}
          <p><strong>Franja ${escaparHtml(accionFranja)}:</strong> ${escaparHtml(franja)}</p>
          <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
          ${alternativasHtml}
          <p>Puedes realizar una nueva solicitud de esta actividad seleccionando una de las franjas horarias que sigan disponibles.</p>
        `;

        const correo = await enviarEmail(env, {
          to: destinatario,
          subject: motivo === "desactivada"
            ? "[Reservas] Franja horaria desactivada y solicitud eliminada"
            : "[Reservas] Franja horaria cancelada y solicitud eliminada",
          text,
          html
        });

        if (correo?.ok) {
          resumen.correos_enviados += 1;
        } else if (!correo?.skipped) {
          resumen.incidencias.push(`Correo reserva ${reserva.id}: ${correo?.error || "error desconocido"}`);
        }
      }
    } catch (error) {
      resumen.incidencias.push(`Reserva ${reserva.id}: ${error?.message || String(error || "")}`);
    }
  }

  return resumen;
}

async function registrarAvisosReactivacionFranja(env, reservas = [], franja = {}) {
  const descripcion = descripcionFranja(franja);
  for (const reserva of reservas) {
    await env.DB.prepare(`
      INSERT INTO franja_desactivacion_avisos (
        franja_id,
        actividad_id,
        usuario_id,
        email,
        contacto,
        actividad_nombre,
        organizador_nombre,
        franja_descripcion
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      Number(franja.id || 0),
      Number(franja.actividad_id || 0),
      Number(reserva.usuario_id || 0) || null,
      normalizarTexto(reserva.email || ""),
      normalizarTexto(reserva.contacto || ""),
      normalizarTexto(reserva.actividad_nombre || "la actividad"),
      normalizarTexto(reserva.organizador_nombre || "el organizador"),
      descripcion
    ).run();
  }
}

async function notificarReactivacionFranja(env, franja = {}) {
  const avisos = await env.DB.prepare(`
    SELECT *
    FROM franja_desactivacion_avisos
    WHERE franja_id = ?
      AND COALESCE(notificado_reactivacion, 0) = 0
    ORDER BY id ASC
  `).bind(Number(franja.id || 0)).all();

  const rows = avisos?.results || [];
  const resumen = {
    total: rows.length,
    correos_enviados: 0,
    notificaciones_creadas: 0,
    incidencias: []
  };

  if (!rows.length) return resumen;

  const descripcionActual = descripcionFranja(franja);
  for (const aviso of rows) {
    try {
      const actividad = normalizarTexto(aviso.actividad_nombre || "la actividad");
      const organizador = normalizarTexto(aviso.organizador_nombre || "el organizador");
      const contacto = normalizarTexto(aviso.contacto || "");
      const destinatario = normalizarTexto(aviso.email || "");
      const saludo = contacto ? `Hola ${contacto},` : "Hola,";
      const mensaje = `La franja horaria ${descripcionActual} de ${actividad} vuelve a estar disponible. Si lo deseas, puedes realizar una nueva solicitud seleccionando de nuevo esta franja horaria.`;

      const usuarioId = Number(aviso.usuario_id || 0);
      if (usuarioId > 0) {
        const notificacion = await crearNotificacion(env, {
          usuarioId,
          rolDestino: "SOLICITANTE",
          tipo: "RESERVA",
          titulo: "Franja horaria disponible de nuevo",
          mensaje,
          urlDestino: "/portal.html"
        });
        if (notificacion?.ok) resumen.notificaciones_creadas += 1;
      }

      if (destinatario) {
        const text = [
          saludo,
          "",
          mensaje,
          "",
          `Actividad: ${actividad}`,
          `Franja disponible: ${descripcionActual}`,
          `Organiza: ${organizador}`,
          "",
          "La solicitud anterior fue eliminada al desactivarse la franja, por lo que si quieres participar debes iniciar una nueva solicitud."
        ].join("\n");

        const html = `
          <p>${escaparHtml(saludo)}</p>
          <p>${escaparHtml(mensaje)}</p>
          <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
          <p><strong>Franja disponible:</strong> ${escaparHtml(descripcionActual)}</p>
          <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
          <p>La solicitud anterior fue eliminada al desactivarse la franja, por lo que si quieres participar debes iniciar una nueva solicitud.</p>
        `;

        const correo = await enviarEmail(env, {
          to: destinatario,
          subject: "[Reservas] Franja horaria disponible de nuevo",
          text,
          html
        });

        if (correo?.ok) {
          resumen.correos_enviados += 1;
        } else if (!correo?.skipped) {
          resumen.incidencias.push(`Aviso ${aviso.id}: ${correo?.error || "error desconocido"}`);
        }
      }

      await env.DB.prepare(`
        UPDATE franja_desactivacion_avisos
        SET notificado_reactivacion = 1,
            reactivado_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(Number(aviso.id || 0)).run();
    } catch (error) {
      resumen.incidencias.push(`Aviso ${aviso.id}: ${error?.message || String(error || "")}`);
    }
  }

  return resumen;
}

async function cambiarEstadoFranja(env, franja = {}, activaNueva = 1, opciones = {}) {
  const activaActual = Number(franja.activa ?? 1) === 1 ? 1 : 0;
  const siguiente = activaNueva === 1 ? 1 : 0;
  if (activaActual === siguiente) {
    return { resumen: null, mensaje: siguiente ? "La franja ya estaba activa." : "La franja ya estaba desactivada." };
  }

  if (siguiente === 0) {
    const reservasAfectadas = await obtenerReservasFuturasFranja(env, franja.id);
    if (reservasAfectadas.length > 0 && !opciones.confirmado) {
      return {
        requiere_confirmacion: true,
        total_afectadas: reservasAfectadas.length,
        mensaje: reservasAfectadas.length === 1
          ? "Existe 1 solicitud futura asociada a esta franja. Si continúas, esa solicitud se eliminará y se enviará un correo al solicitante."
          : `Existen ${reservasAfectadas.length} solicitudes futuras asociadas a esta franja. Si continúas, esas solicitudes se eliminarán y se enviará un correo a cada solicitante.`
      };
    }

    const franjasAlternativas = reservasAfectadas.length > 0
      ? await obtenerFranjasDisponiblesAlternativas(env, franja.actividad_id, franja.id)
      : [];

    if (reservasAfectadas.length > 0) {
      await registrarAvisosReactivacionFranja(env, reservasAfectadas, franja);
    }

    const resumen = reservasAfectadas.length > 0
      ? await eliminarReservasPorEliminacionFranja(env, reservasAfectadas, franja, franjasAlternativas, "desactivada")
      : null;

    await env.DB.prepare(`
      UPDATE franjas
      SET activa = 0
      WHERE id = ?
    `).bind(Number(franja.id || 0)).run();

    return {
      resumen,
      mensaje: reservasAfectadas.length > 0
        ? "Franja desactivada correctamente. Las solicitudes futuras afectadas han sido eliminadas y se han enviado los avisos correspondientes."
        : "Franja desactivada correctamente."
    };
  }

  await env.DB.prepare(`
    UPDATE franjas
    SET activa = 1
    WHERE id = ?
  `).bind(Number(franja.id || 0)).run();

  const franjaActualizada = await obtenerFranjaPorId(env, franja.id);
  const resumen = await notificarReactivacionFranja(env, franjaActualizada || { ...franja, activa: 1 });
  return {
    resumen,
    mensaje: resumen.total > 0
      ? "Franja reactivada correctamente. Se ha avisado a los solicitantes afectados por la desactivación anterior."
      : "Franja reactivada correctamente."
  };
}

function validarDatosFranja({
  fecha,
  hora_inicio,
  hora_fin,
  capacidad,
  es_recurrente,
  patron_recurrencia,
  regla_recurrencia,
  aforo_limitado
}) {
  if (!hora_inicio) {
    return "La hora de inicio es obligatoria.";
  }

  if (!/^\d{2}:\d{2}$/.test(hora_inicio)) {
    return "La hora de inicio debe tener formato HH:MM.";
  }

  if (hora_fin && !/^\d{2}:\d{2}$/.test(hora_fin)) {
    return "La hora de fin debe tener formato HH:MM.";
  }

  if (hora_fin && hora_inicio >= hora_fin) {
    return "La hora de inicio debe ser anterior a la hora de fin.";
  }

  if (Number(es_recurrente) === 1) {
    const errorRegla = validarReglaRecurrencia(regla_recurrencia || {});
    if (errorRegla) return errorRegla;
    if (!patron_recurrencia) return "Debe indicar un patrón de recurrencia.";
  } else {
    if (!fecha) {
      return "La fecha es obligatoria.";
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return "La fecha debe tener formato YYYY-MM-DD.";
    }
  }

  if (Number(aforo_limitado) === 1) {
    if (!(capacidad > 0)) {
      return "La capacidad debe ser un entero mayor que 0.";
    }
  }

  return null;
}

async function insertarFranjaMaterializada(env, patron, fecha) {
  const existente = await env.DB.prepare(`
    SELECT id
    FROM franjas
    WHERE actividad_id = ?
      AND fecha = ?
      AND hora_inicio = ?
      AND COALESCE(hora_fin, '') = COALESCE(?, '')
      AND COALESCE(es_recurrente, 0) = 0
    LIMIT 1
  `)
    .bind(patron.actividad_id, fecha, patron.hora_inicio, patron.hora_fin)
    .first();

  if (existente) return false;

  await env.DB.prepare(`
    INSERT INTO franjas (
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
      actividad_id,
      activa,
      es_recurrente,
      patron_recurrencia,
      recurrencia_origen_id,
      recurrencia_tipo,
      recurrencia_intervalo,
      recurrencia_weekday,
      recurrencia_weekdays,
      recurrencia_ordinal,
      recurrencia_monthday,
      recurrencia_month,
      recurrencia_inicio,
      recurrencia_fin,
      recurrencia_fin_tipo,
      recurrencia_repeticiones
    )
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      fecha,
      patron.hora_inicio,
      patron.hora_fin,
      patron.capacidad,
      patron.actividad_id,
      patron.patron_recurrencia,
      patron.id,
      patron.recurrencia_tipo,
      Number(patron.recurrencia_intervalo || 1),
      patron.recurrencia_weekday,
      patron.recurrencia_weekdays,
      patron.recurrencia_ordinal,
      patron.recurrencia_monthday,
      patron.recurrencia_month,
      patron.recurrencia_inicio,
      patron.recurrencia_fin,
      patron.recurrencia_fin_tipo,
      patron.recurrencia_repeticiones
    )
    .run();

  return true;
}

async function contarConflictosMismaFechaDistintoHorario(env, actividadId, fechas = [], horaInicio, horaFin, excluirId = null) {
  const listaFechas = [...new Set((Array.isArray(fechas) ? fechas : [fechas]).map(normalizarFecha).filter(Boolean))];
  if (!listaFechas.length) return 0;

  let total = 0;
  for (const fecha of listaFechas) {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM franjas
      WHERE actividad_id = ?
        AND COALESCE(es_recurrente, 0) = 0
        AND fecha = ?
        AND (
          hora_inicio <> ?
          OR COALESCE(hora_fin, '') <> COALESCE(?, '')
        )
        AND (? IS NULL OR id <> ?)
    `).bind(actividadId, fecha, horaInicio, horaFin, excluirId, excluirId).first();
    total += Number(row?.total || 0);
  }

  return total;
}

async function limpiarDuplicadosExactosFuturosActividad(env, actividadId) {
  const grupos = await env.DB.prepare(`
    SELECT
      fecha,
      hora_inicio,
      COALESCE(hora_fin, '') AS hora_fin_norm,
      COUNT(*) AS total
    FROM franjas
    WHERE actividad_id = ?
      AND COALESCE(es_recurrente, 0) = 0
      AND fecha IS NOT NULL
      AND datetime(fecha || ' ' || COALESCE(NULLIF(hora_inicio, ''), '00:00')) > datetime('now')
    GROUP BY fecha, hora_inicio, COALESCE(hora_fin, '')
    HAVING COUNT(*) > 1
  `).bind(actividadId).all();

  let eliminadas = 0;
  for (const grupo of grupos?.results || []) {
    const filas = await env.DB.prepare(`
      SELECT
        f.id,
        COUNT(r.id) AS reservas
      FROM franjas f
      LEFT JOIN reservas r ON r.franja_id = f.id
      WHERE f.actividad_id = ?
        AND COALESCE(f.es_recurrente, 0) = 0
        AND f.fecha = ?
        AND f.hora_inicio = ?
        AND COALESCE(f.hora_fin, '') = ?
      GROUP BY f.id
      ORDER BY COUNT(r.id) DESC, f.id ASC
    `).bind(actividadId, grupo.fecha, grupo.hora_inicio, grupo.hora_fin_norm).all();

    for (const row of (filas?.results || []).slice(1)) {
      if (Number(row.reservas || 0) > 0) continue;
      const borrado = await env.DB.prepare(`
        DELETE FROM franjas
        WHERE id = ?
      `).bind(row.id).run();
      eliminadas += Number(borrado?.meta?.changes || 0);
    }
  }

  return eliminadas;
}

function fechasPrevistasReglaRecurrencia(regla = {}) {
  if (validarReglaRecurrencia(regla)) return [];
  return generarFechasRecurrencia(regla, finVentanaRecurrencia());
}

async function materializarPatronRecurrencia(env, patron, hasta = finVentanaRecurrencia()) {
  if (!patron || Number(patron.es_recurrente || 0) !== 1) return 0;
  const finActividad = crearFechaLocal(patron.actividad_fecha_fin);
  const hastaEfectivo = finActividad && finActividad < hasta ? finActividad : hasta;
  const inicioActividad = normalizarFecha(patron.actividad_fecha_inicio);
  const regla = {
    tipo: normalizarTexto(patron.recurrencia_tipo).toUpperCase(),
    intervalo: Number(patron.recurrencia_intervalo || 1),
    weekday: patron.recurrencia_weekday === null || patron.recurrencia_weekday === undefined ? null : Number(patron.recurrencia_weekday),
    weekdays: normalizarListaWeekdays(patron.recurrencia_weekdays || patron.recurrencia_weekday),
    ordinal: patron.recurrencia_ordinal === null || patron.recurrencia_ordinal === undefined ? null : Number(patron.recurrencia_ordinal),
    monthday: patron.recurrencia_monthday === null || patron.recurrencia_monthday === undefined ? null : Number(patron.recurrencia_monthday),
    month: patron.recurrencia_month === null || patron.recurrencia_month === undefined ? null : Number(patron.recurrencia_month),
    inicio: normalizarFecha(patron.recurrencia_inicio),
    inicio_minimo: inicioActividad,
    fin: normalizarFecha(patron.recurrencia_fin),
    fin_tipo: normalizarTexto(patron.recurrencia_fin_tipo || (patron.recurrencia_fin ? "FECHA" : "NUNCA")).toUpperCase(),
    repeticiones: parsearEnteroNullable(patron.recurrencia_repeticiones)
  };

  if (validarReglaRecurrencia(regla)) return 0;

  let creadas = 0;
  for (const fecha of generarFechasRecurrencia(regla, hastaEfectivo)) {
    const insertada = await insertarFranjaMaterializada(env, patron, fecha);
    if (insertada) creadas += 1;
  }
  return creadas;
}

async function materializarPatronesActividad(env, actividadId) {
  await limpiarDuplicadosExactosFuturosActividad(env, actividadId);
  const result = await env.DB.prepare(`
    SELECT
      f.id,
      f.actividad_id,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.es_recurrente,
      f.patron_recurrencia,
      f.recurrencia_tipo,
      f.recurrencia_intervalo,
      f.recurrencia_weekday,
      f.recurrencia_weekdays,
      f.recurrencia_ordinal,
      f.recurrencia_monthday,
      f.recurrencia_month,
      f.recurrencia_inicio,
      f.recurrencia_fin,
      f.recurrencia_fin_tipo,
      f.recurrencia_repeticiones,
      a.fecha_inicio AS actividad_fecha_inicio,
      a.fecha_fin AS actividad_fecha_fin
    FROM franjas f
    LEFT JOIN actividades a ON a.id = f.actividad_id
    WHERE f.actividad_id = ?
      AND COALESCE(f.es_recurrente, 0) = 1
      AND f.recurrencia_tipo IS NOT NULL
  `).bind(actividadId).all();

  let creadas = 0;
  for (const patron of result?.results || []) {
    creadas += await materializarPatronRecurrencia(env, patron);
  }
  await limpiarDuplicadosExactosFuturosActividad(env, actividadId);
  return creadas;
}

async function obtenerActividad(env, actividad_id) {
  return await dbPrimaria(env).prepare(`
    SELECT
      id,
      nombre,
      tipo,
      fecha_inicio,
      fecha_fin,
      aforo_limitado,
      borrador_tecnico
    FROM actividades
    WHERE id = ?
    LIMIT 1
  `)
    .bind(actividad_id)
    .first();
}

function resolverAforoLimitadoActual(data, actividad) {
  return parsearFlag(data?.aforo_limitado, Number(actividad?.aforo_limitado || 0));
}

function resolverActividadActual(data, actividad = {}) {
  return {
    ...actividad,
    tipo: normalizarTexto(data?.tipo_actividad || actividad?.tipo).toUpperCase() || "PERMANENTE",
    fecha_inicio: normalizarFecha(data?.actividad_fecha_inicio || actividad?.fecha_inicio),
    fecha_fin: normalizarFecha(data?.actividad_fecha_fin || actividad?.fecha_fin)
  };
}

function validarFechaDentroDeActividad(actividad, fecha, es_recurrente) {
  if (!actividad) {
    return "La actividad indicada no existe.";
  }

  if (Number(es_recurrente) === 1) {
    return null;
  }

  if (Number(actividad.borrador_tecnico) === 1) {
    return null;
  }
  
  if (actividad.tipo === "PERMANENTE") {
    return null;
  }

  if (!actividad.fecha_inicio || !actividad.fecha_fin) {
    return "La actividad temporal no tiene definido correctamente su intervalo de fechas.";
  }

  if (fecha < actividad.fecha_inicio || fecha > actividad.fecha_fin) {
    return `La fecha de la franja debe estar dentro del intervalo de la actividad (${actividad.fecha_inicio} a ${actividad.fecha_fin}).`;
  }

  return null;
}

function validarFechaNuevaNoPasada(fecha) {
  const normalizada = normalizarFecha(fecha);
  if (normalizada && normalizada < fechaHoyIso()) {
    return "La fecha de inicio de una nueva franja no puede ser anterior a la fecha actual.";
  }
  return null;
}

function validarReglaRecurrenciaDentroDeActividad(actividad, regla = {}) {
  if (!actividad) {
    return "La actividad indicada no existe.";
  }

  if (Number(actividad.borrador_tecnico) === 1) {
    return null;
  }

  if (normalizarTexto(actividad.tipo).toUpperCase() === "PENDIENTE") {
    return "Para programar franjas horarias la actividad debe ser temporal o permanente.";
  }

  if (actividad.fecha_inicio && regla.inicio && regla.inicio < actividad.fecha_inicio) {
    return `La fecha de inicio del patrón no puede ser anterior al inicio de la actividad (${actividad.fecha_inicio}).`;
  }

  if (actividad.fecha_fin && regla.fin_tipo === "FECHA" && regla.fin && regla.fin > actividad.fecha_fin) {
    return `La fecha de finalización del patrón no puede ser posterior a la finalización de la actividad (${actividad.fecha_fin}).`;
  }

  return null;
}

async function obtenerBloqueoActualFranja(env, franjaId) {
  const sql = `
    SELECT
      COALESCE(SUM(
        CASE
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN
            CASE
              WHEN r.prereserva_expira_en IS NOT NULL
                   AND datetime('now') <= datetime(r.prereserva_expira_en)
                THEN MAX(
                  COALESCE(r.plazas_prereservadas, 0),
                  COALESCE((
                    SELECT COUNT(*)
                    FROM visitantes v
                    WHERE v.reserva_id = r.id
                  ), 0)
                )
              ELSE COALESCE((
                SELECT COUNT(*)
                FROM visitantes v
                WHERE v.reserva_id = r.id
              ), 0)
            END
          ELSE 0
        END
      ), 0) AS ocupadas
    FROM reservas r
    WHERE r.franja_id = ?
  `;

  const row = await env.DB.prepare(sql).bind(franjaId).first();
  return Number(row?.ocupadas || 0);
}

async function contarFranjasMaterializadasDelMismoPatron(env, recurrenciaOrigenId, excluirId = null) {
  if (!recurrenciaOrigenId) return 0;

  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM franjas
    WHERE recurrencia_origen_id = ?
      AND (? IS NULL OR id <> ?)
  `)
    .bind(recurrenciaOrigenId, excluirId, excluirId)
    .first();

  return Number(result?.total || 0);
}

async function obtenerMaterializacionesFuturasPatron(env, recurrenciaOrigenId) {
  if (!recurrenciaOrigenId) return [];

  const result = await env.DB.prepare(`
    SELECT *
    FROM franjas
    WHERE recurrencia_origen_id = ?
      AND COALESCE(es_recurrente, 0) = 0
      AND (
        fecha IS NULL
        OR datetime(fecha || ' ' || COALESCE(NULLIF(hora_inicio, ''), '00:00')) > datetime('now')
      )
    ORDER BY fecha ASC, hora_inicio ASC, id ASC
  `).bind(recurrenciaOrigenId).all();

  return result?.results || [];
}

async function contarReservasFuturasMaterializacionesPatron(env, recurrenciaOrigenId) {
  const franjas = await obtenerMaterializacionesFuturasPatron(env, recurrenciaOrigenId);
  let total = 0;

  for (const franja of franjas) {
    const reservas = await obtenerReservasFuturasFranja(env, franja.id);
    total += reservas.length;
  }

  return total;
}

async function limpiarMaterializacionesFuturasPatron(env, patron = {}) {
  const franjas = await obtenerMaterializacionesFuturasPatron(env, patron.id);
  const resumen = {
    franjas_eliminadas: 0,
    reservas_afectadas: 0,
    correos_enviados: 0,
    incidencias: []
  };

  for (const franja of franjas) {
    const reservas = await obtenerReservasFuturasFranja(env, franja.id);
    if (reservas.length > 0) {
      const alternativas = await obtenerFranjasDisponiblesAlternativas(env, franja.actividad_id, franja.id);
      const resultado = await eliminarReservasPorEliminacionFranja(env, reservas, franja, alternativas);
      resumen.reservas_afectadas += Number(resultado?.reservas_eliminadas || 0);
      resumen.correos_enviados += Number(resultado?.correos_enviados || 0);
      resumen.incidencias.push(...(resultado?.incidencias || []));
    }

    const deleteResult = await env.DB.prepare(`
      DELETE FROM franjas
      WHERE id = ?
        AND COALESCE(es_recurrente, 0) = 0
        AND recurrencia_origen_id = ?
    `).bind(franja.id, patron.id).run();

    if ((deleteResult?.meta?.changes || 0) > 0) {
      resumen.franjas_eliminadas += 1;
    }
  }

  return resumen;
}

async function obtenerFranjasActividadParaReset(env, actividadId) {
  const result = await env.DB.prepare(`
    SELECT *
    FROM franjas
    WHERE actividad_id = ?
    ORDER BY COALESCE(es_recurrente, 0) ASC, fecha ASC, hora_inicio ASC, id ASC
  `).bind(actividadId).all();

  return result?.results || [];
}

async function resetearProgramacionActividad(env, actividadId) {
  const franjas = await obtenerFranjasActividadParaReset(env, actividadId);
  const resumen = {
    franjas_eliminadas: 0,
    reservas_afectadas: 0,
    correos_enviados: 0,
    incidencias: []
  };

  for (const franja of franjas) {
    const historicas = await contarReservasHistoricasFranja(env, franja.id);
    if (historicas > 0) {
      return {
        ok: false,
        bloquear: true,
        error: "No se puede resetear la programación porque existen solicitudes históricas asociadas. El histórico debe conservarse."
      };
    }
  }

  for (const franja of franjas) {
    const reservas = await obtenerReservasFuturasFranja(env, franja.id);
    if (reservas.length > 0) {
      const resultado = await eliminarReservasPorEliminacionFranja(env, reservas, franja, []);
      resumen.reservas_afectadas += Number(resultado?.reservas_eliminadas || 0);
      resumen.correos_enviados += Number(resultado?.correos_enviados || 0);
      resumen.incidencias.push(...(resultado?.incidencias || []));
    }

    const deleteResult = await env.DB.prepare(`
      DELETE FROM franjas
      WHERE id = ?
    `).bind(franja.id).run();

    if ((deleteResult?.meta?.changes || 0) > 0) {
      resumen.franjas_eliminadas += 1;
    }
  }

  return { ok: true, resumen };
}

async function obtenerResumenFranjas(env, actividad_id) {
  await materializarPatronesActividad(env, actividad_id);

  const actividad = await obtenerActividad(env, actividad_id);
  const aforoLimitado = Number(actividad?.aforo_limitado || 0);

  const sql = `
    SELECT
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.actividad_id,
      COALESCE(f.activa, 1) AS activa,
      f.es_recurrente,
      f.patron_recurrencia,
      f.recurrencia_origen_id,
      f.recurrencia_tipo,
      f.recurrencia_intervalo,
      f.recurrencia_weekday,
      f.recurrencia_weekdays,
      f.recurrencia_ordinal,
      f.recurrencia_monthday,
      f.recurrencia_month,
      f.recurrencia_inicio,
      f.recurrencia_fin,
      f.recurrencia_fin_tipo,
      f.recurrencia_repeticiones,
      COUNT(CASE WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN r.id END) AS numero_reservas,
      COALESCE(SUM(
        CASE
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN
            CASE
              WHEN r.prereserva_expira_en IS NOT NULL
                   AND datetime('now') <= datetime(r.prereserva_expira_en)
                THEN MAX(
                  COALESCE(r.plazas_prereservadas, 0),
                  COALESCE((
                    SELECT COUNT(*)
                    FROM visitantes v
                    WHERE v.reserva_id = r.id
                  ), 0)
                )
              ELSE COALESCE((
                SELECT COUNT(*)
                FROM visitantes v
                WHERE v.reserva_id = r.id
              ), 0)
            END
          ELSE 0
        END
      ), 0) AS ocupadas
    FROM franjas f
    LEFT JOIN reservas r
      ON f.id = r.franja_id
    WHERE f.actividad_id = ?
      AND COALESCE(f.es_recurrente, 0) = 0
    GROUP BY
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.actividad_id,
      f.activa,
      f.es_recurrente,
      f.patron_recurrencia,
      f.recurrencia_origen_id,
      f.recurrencia_tipo,
      f.recurrencia_intervalo,
      f.recurrencia_weekday,
      f.recurrencia_weekdays,
      f.recurrencia_ordinal,
      f.recurrencia_monthday,
      f.recurrencia_month,
      f.recurrencia_inicio,
      f.recurrencia_fin,
      f.recurrencia_fin_tipo,
      f.recurrencia_repeticiones
    ORDER BY
      CASE WHEN f.es_recurrente = 1 THEN 1 ELSE 0 END,
      f.fecha,
      f.patron_recurrencia,
      f.hora_inicio,
      f.hora_fin
  `;

  const result = await dbPrimaria(env).prepare(sql).bind(actividad_id).all();
  const rows = result.results || [];

  let franjas = rows.map(row => {
    const capacidad = row.capacidad === null || row.capacidad === undefined ? null : Number(row.capacidad || 0);
    const ocupadas = aforoLimitado ? Number(row.ocupadas || 0) : 0;

    return {
      ...row,
      activa: Number(row.activa ?? 1) === 1 ? 1 : 0,
      es_recurrente: Number(row.es_recurrente || 0),
      generada_por_recurrencia: row.recurrencia_origen_id ? 1 : 0,
      capacidad,
      ocupadas,
      disponibles: aforoLimitado && capacidad !== null ? Math.max(capacidad - ocupadas, 0) : null,
      numero_reservas: aforoLimitado ? Number(row.numero_reservas || 0) : 0
    };
  });

  return franjas;
}

async function obtenerFranjaPorId(env, id) {
  return await dbPrimaria(env).prepare(`
    SELECT
      id,
      actividad_id,
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
      activa,
      es_recurrente,
      patron_recurrencia,
      recurrencia_origen_id,
      recurrencia_tipo,
      recurrencia_intervalo,
      recurrencia_weekday,
      recurrencia_weekdays,
      recurrencia_ordinal,
      recurrencia_monthday,
      recurrencia_month,
      recurrencia_inicio,
      recurrencia_fin,
      recurrencia_fin_tipo,
      recurrencia_repeticiones
    FROM franjas
    WHERE id = ?
    LIMIT 1
  `)
    .bind(id)
    .first();
}

export async function onRequestGet(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    await asegurarEstructuraEstadoFranjas(env);
    await ejecutarMantenimientoReservas(env);
    const session = await getAdminSession(request, env);
    const url = new URL(request.url);
    const actividad_id = parsearIdPositivo(url.searchParams.get("actividad_id"));

    if (!actividad_id) {
      return json({ ok: false, error: "actividad_id es obligatorio." }, { status: 400 });
    }

    await checkAdminActividad(env, session.usuario_id, actividad_id);

    const franjas = await obtenerResumenFranjas(env, actividad_id);

    return json({
      ok: true,
      total: franjas.length,
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al obtener las franjas.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestPost(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    await asegurarEstructuraEstadoFranjas(env);
    const session = await getAdminSession(request, env);
    const data = await request.json();

    const actividad_id = parsearIdPositivo(data.actividad_id);
    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHoraFinOpcional(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);
    const es_recurrente = parsearFlag(data.es_recurrente, 0);
    const regla_recurrencia = normalizarReglaRecurrencia(data);
    const patron_recurrencia = es_recurrente === 1
      ? (normalizarTexto(data.patron_recurrencia) || describirReglaRecurrencia(regla_recurrencia))
      : normalizarTexto(data.patron_recurrencia);
    const confirmarDuplicadoFecha = data.confirmar_duplicado_fecha === true || data.confirmar_duplicado_fecha === 1 || data.confirmar_duplicado_fecha === "1";

    if (!actividad_id) {
      return json({ ok: false, error: "actividad_id es obligatorio." }, { status: 400 });
    }

    await checkAdminActividad(env, session.usuario_id, actividad_id);

    const actividadBase = await obtenerActividad(env, actividad_id);

    if (!actividadBase) {
      return json({ ok: false, error: "Actividad no válida." }, { status: 400 });
    }
    
    const actividad = resolverActividadActual(data, actividadBase);
    const aforo_limitado = resolverAforoLimitadoActual(data, actividad);

    const errorValidacion = validarDatosFranja({
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
      es_recurrente,
      patron_recurrencia,
      regla_recurrencia,
      aforo_limitado
    });

    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, { status: 400 });
    }

    const errorFecha = validarFechaDentroDeActividad(actividad, fecha, es_recurrente);

    if (errorFecha) {
      return json({ ok: false, error: errorFecha }, { status: 400 });
    }

    const errorFechaPasada = validarFechaNuevaNoPasada(es_recurrente === 1 ? regla_recurrencia.inicio : fecha);

    if (errorFechaPasada) {
      return json({ ok: false, error: errorFechaPasada }, { status: 400 });
    }

    if (es_recurrente === 1) {
      const errorReglaActividad = validarReglaRecurrenciaDentroDeActividad(actividad, regla_recurrencia);
      if (errorReglaActividad) {
        return json({ ok: false, error: errorReglaActividad }, { status: 400 });
      }
    }

    let duplicada;

    if (es_recurrente === 1) {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND es_recurrente = 1
          AND recurrencia_tipo = ?
          AND recurrencia_inicio = ?
          AND COALESCE(recurrencia_fin, '') = COALESCE(?, '')
          AND COALESCE(recurrencia_fin_tipo, '') = COALESCE(?, '')
          AND COALESCE(recurrencia_repeticiones, -99) = COALESCE(?, -99)
          AND COALESCE(recurrencia_weekday, -99) = COALESCE(?, -99)
          AND COALESCE(recurrencia_weekdays, '') = COALESCE(?, '')
          AND COALESCE(recurrencia_ordinal, -99) = COALESCE(?, -99)
          AND COALESCE(recurrencia_monthday, -99) = COALESCE(?, -99)
          AND COALESCE(recurrencia_month, -99) = COALESCE(?, -99)
          AND hora_inicio = ?
          AND COALESCE(hora_fin, '') = COALESCE(?, '')
        LIMIT 1
      `)
        .bind(
          actividad_id,
          regla_recurrencia.tipo,
          regla_recurrencia.inicio,
          regla_recurrencia.fin_tipo === "FECHA" ? regla_recurrencia.fin : null,
          regla_recurrencia.fin_tipo,
          regla_recurrencia.repeticiones,
          regla_recurrencia.weekday,
          regla_recurrencia.weekdays.join(","),
          regla_recurrencia.ordinal,
          regla_recurrencia.monthday,
          regla_recurrencia.month,
          hora_inicio,
          hora_fin
        )
        .first();
    } else {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND COALESCE(es_recurrente, 0) = 0
          AND fecha = ?
          AND hora_inicio = ?
          AND COALESCE(hora_fin, '') = COALESCE(?, '')
        LIMIT 1
      `)
        .bind(actividad_id, fecha, hora_inicio, hora_fin)
        .first();
    }

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe una franja con esos datos para esta actividad."
        },
        { status: 409 }
      );
    }

    const fechasParaConflicto = es_recurrente === 1 ? fechasPrevistasReglaRecurrencia(regla_recurrencia) : [fecha];
    const conflictosMismaFecha = await contarConflictosMismaFechaDistintoHorario(
      env,
      actividad_id,
      fechasParaConflicto,
      hora_inicio,
      hora_fin
    );

    if (conflictosMismaFecha > 0 && !confirmarDuplicadoFecha) {
      return json({
        ok: false,
        requiere_confirmacion_duplicado_fecha: true,
        total_conflictos_fecha: conflictosMismaFecha,
        mensaje: conflictosMismaFecha === 1
          ? "Ya existe una franja en la misma fecha con un horario distinto. ¿Deseas incluir también esta nueva franja?"
          : `Ya existen ${conflictosMismaFecha} franjas en las mismas fechas con horarios distintos. ¿Deseas incluir también esta nueva programación?`
      }, { status: 409 });
    }

    const insertResult = await env.DB.prepare(`
      INSERT INTO franjas (
        fecha,
        hora_inicio,
        hora_fin,
        capacidad,
        actividad_id,
        es_recurrente,
        patron_recurrencia,
        recurrencia_tipo,
        recurrencia_intervalo,
        recurrencia_weekday,
        recurrencia_weekdays,
        recurrencia_ordinal,
        recurrencia_monthday,
        recurrencia_month,
        recurrencia_inicio,
        recurrencia_fin,
        recurrencia_fin_tipo,
        recurrencia_repeticiones
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        es_recurrente === 1 ? null : fecha,
        hora_inicio,
        hora_fin,
        aforo_limitado === 1 ? capacidad : null,
        actividad_id,
        es_recurrente,
        es_recurrente === 1 ? patron_recurrencia : null,
        es_recurrente === 1 ? regla_recurrencia.tipo : null,
        es_recurrente === 1 ? regla_recurrencia.intervalo : 1,
        es_recurrente === 1 ? regla_recurrencia.weekday : null,
        es_recurrente === 1 ? regla_recurrencia.weekdays.join(",") : null,
        es_recurrente === 1 ? regla_recurrencia.ordinal : null,
        es_recurrente === 1 ? regla_recurrencia.monthday : null,
        es_recurrente === 1 ? regla_recurrencia.month : null,
        es_recurrente === 1 ? regla_recurrencia.inicio : null,
        es_recurrente === 1 && regla_recurrencia.fin_tipo === "FECHA" ? regla_recurrencia.fin : null,
        es_recurrente === 1 ? regla_recurrencia.fin_tipo : null,
        es_recurrente === 1 ? regla_recurrencia.repeticiones : null
      )
      .run();

    if ((insertResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo crear la franja." },
        { status: 500 }
      );
    }

    if (es_recurrente === 1) {
      const patronCreado = await env.DB.prepare(`
        SELECT *
        FROM franjas
        WHERE actividad_id = ?
          AND es_recurrente = 1
          AND recurrencia_tipo = ?
          AND recurrencia_inicio = ?
          AND hora_inicio = ?
          AND COALESCE(hora_fin, '') = COALESCE(?, '')
        ORDER BY id DESC
        LIMIT 1
      `).bind(actividad_id, regla_recurrencia.tipo, regla_recurrencia.inicio, hora_inicio, hora_fin).first();
      await materializarPatronRecurrencia(env, patronCreado);
    }

    const franjas = await obtenerResumenFranjas(env, actividad_id);

    return json({
      ok: true,
      mensaje: "Franja creada correctamente.",
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al crear la franja.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestPut(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    await asegurarEstructuraEstadoFranjas(env);
    const session = await getAdminSession(request, env);
    const data = await request.json();

    const id = parsearIdPositivo(data.id);
    const accion = normalizarTexto(data.accion).toLowerCase();
    const confirmarEstado = data.confirmar_estado === true || data.confirmar_estado === 1 || data.confirmar_estado === "1";

    if (!id) {
      return json({ ok: false, error: "ID de franja no válido." }, { status: 400 });
    }

    const existente = await obtenerFranjaPorId(env, id);

    if (!existente) {
      return json(
        { ok: false, error: "La franja indicada no existe." },
        { status: 404 }
      );
    }

    await checkAdminActividad(env, session.usuario_id, existente.actividad_id);

    if (accion === "estado") {
      const activaNueva = parsearFlag(data.activa, Number(existente.activa ?? 1));
      const resultado = await cambiarEstadoFranja(env, existente, activaNueva, { confirmado: confirmarEstado });

      if (resultado?.requiere_confirmacion) {
        return json({ ok: false, ...resultado }, { status: 409 });
      }

      const franjas = await obtenerResumenFranjas(env, existente.actividad_id);
      return json({
        ok: true,
        mensaje: resultado?.mensaje || "Estado de franja actualizado correctamente.",
        resumen_afectacion: resultado?.resumen || null,
        franjas
      });
    }

    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHoraFinOpcional(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);
    const es_recurrente = parsearFlag(data.es_recurrente, 0);
    const regla_recurrencia = normalizarReglaRecurrencia(data);
    const patron_recurrencia = es_recurrente === 1
      ? (normalizarTexto(data.patron_recurrencia) || describirReglaRecurrencia(regla_recurrencia))
      : normalizarTexto(data.patron_recurrencia);
    const confirmarAfectacion = data.confirmar_afectacion === true || data.confirmar_afectacion === 1 || data.confirmar_afectacion === "1";
    const confirmarDuplicadoFecha = data.confirmar_duplicado_fecha === true || data.confirmar_duplicado_fecha === 1 || data.confirmar_duplicado_fecha === "1";

    const actividadBase = await obtenerActividad(env, existente.actividad_id);
    const actividad = resolverActividadActual(data, actividadBase);
    const aforo_limitado = resolverAforoLimitadoActual(data, actividad);
    const siguienteFranja = {
      fecha: es_recurrente === 1 ? null : fecha,
      hora_inicio,
      hora_fin,
      capacidad: aforo_limitado === 1 ? capacidad : null,
      es_recurrente,
      patron_recurrencia: es_recurrente === 1 ? patron_recurrencia : null,
      recurrencia_tipo: es_recurrente === 1 ? regla_recurrencia.tipo : null,
      recurrencia_intervalo: es_recurrente === 1 ? regla_recurrencia.intervalo : 1,
      recurrencia_weekday: es_recurrente === 1 ? regla_recurrencia.weekday : null,
      recurrencia_weekdays: es_recurrente === 1 ? regla_recurrencia.weekdays.join(",") : null,
      recurrencia_ordinal: es_recurrente === 1 ? regla_recurrencia.ordinal : null,
      recurrencia_monthday: es_recurrente === 1 ? regla_recurrencia.monthday : null,
      recurrencia_month: es_recurrente === 1 ? regla_recurrencia.month : null,
      recurrencia_inicio: es_recurrente === 1 ? regla_recurrencia.inicio : null,
      recurrencia_fin: es_recurrente === 1 && regla_recurrencia.fin_tipo === "FECHA" ? regla_recurrencia.fin : null,
      recurrencia_fin_tipo: es_recurrente === 1 ? regla_recurrencia.fin_tipo : null,
      recurrencia_repeticiones: es_recurrente === 1 ? regla_recurrencia.repeticiones : null
    };

    const errorValidacion = validarDatosFranja({
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
      es_recurrente,
      patron_recurrencia,
      regla_recurrencia,
      aforo_limitado
    });

    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, { status: 400 });
    }

    const errorFecha = validarFechaDentroDeActividad(actividad, fecha, es_recurrente);

    if (errorFecha) {
      return json({ ok: false, error: errorFecha }, { status: 400 });
    }

    const fechaReferenciaNueva = es_recurrente === 1 ? regla_recurrencia.inicio : fecha;
    const fechaReferenciaAnterior = Number(existente.es_recurrente || 0) === 1
      ? normalizarFecha(existente.recurrencia_inicio)
      : normalizarFecha(existente.fecha);
    if (fechaReferenciaNueva !== fechaReferenciaAnterior) {
      const errorFechaPasada = validarFechaNuevaNoPasada(fechaReferenciaNueva);
      if (errorFechaPasada) {
        return json({ ok: false, error: errorFechaPasada }, { status: 400 });
      }
    }

    if (es_recurrente === 1) {
      const errorReglaActividad = validarReglaRecurrenciaDentroDeActividad(actividad, regla_recurrencia);
      if (errorReglaActividad) {
        return json({ ok: false, error: errorReglaActividad }, { status: 400 });
      }
    }

    let duplicada;

    if (es_recurrente === 1) {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND es_recurrente = 1
          AND recurrencia_tipo = ?
          AND recurrencia_inicio = ?
          AND COALESCE(recurrencia_fin, '') = COALESCE(?, '')
          AND COALESCE(recurrencia_fin_tipo, '') = COALESCE(?, '')
          AND COALESCE(recurrencia_repeticiones, -99) = COALESCE(?, -99)
          AND COALESCE(recurrencia_weekday, -99) = COALESCE(?, -99)
          AND COALESCE(recurrencia_weekdays, '') = COALESCE(?, '')
          AND COALESCE(recurrencia_ordinal, -99) = COALESCE(?, -99)
          AND COALESCE(recurrencia_monthday, -99) = COALESCE(?, -99)
          AND COALESCE(recurrencia_month, -99) = COALESCE(?, -99)
          AND hora_inicio = ?
          AND COALESCE(hora_fin, '') = COALESCE(?, '')
          AND id <> ?
        LIMIT 1
      `)
        .bind(
          existente.actividad_id,
          regla_recurrencia.tipo,
          regla_recurrencia.inicio,
          regla_recurrencia.fin_tipo === "FECHA" ? regla_recurrencia.fin : null,
          regla_recurrencia.fin_tipo,
          regla_recurrencia.repeticiones,
          regla_recurrencia.weekday,
          regla_recurrencia.weekdays.join(","),
          regla_recurrencia.ordinal,
          regla_recurrencia.monthday,
          regla_recurrencia.month,
          hora_inicio,
          hora_fin,
          id
        )
        .first();
    } else {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND COALESCE(es_recurrente, 0) = 0
          AND fecha = ?
          AND hora_inicio = ?
          AND COALESCE(hora_fin, '') = COALESCE(?, '')
          AND id <> ?
        LIMIT 1
      `)
        .bind(existente.actividad_id, fecha, hora_inicio, hora_fin, id)
        .first();
    }

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe otra franja con esos datos para esta actividad."
        },
        { status: 409 }
      );
    }

    const fechasParaConflicto = es_recurrente === 1 ? fechasPrevistasReglaRecurrencia(regla_recurrencia) : [fecha];
    const conflictosMismaFecha = await contarConflictosMismaFechaDistintoHorario(
      env,
      existente.actividad_id,
      fechasParaConflicto,
      hora_inicio,
      hora_fin,
      id
    );

    if (conflictosMismaFecha > 0 && !confirmarDuplicadoFecha) {
      return json({
        ok: false,
        requiere_confirmacion_duplicado_fecha: true,
        total_conflictos_fecha: conflictosMismaFecha,
        mensaje: conflictosMismaFecha === 1
          ? "Ya existe una franja en la misma fecha con un horario distinto. ¿Deseas mantener también esta franja?"
          : `Ya existen ${conflictosMismaFecha} franjas en las mismas fechas con horarios distintos. ¿Deseas mantener también esta programación?`
      }, { status: 409 });
    }

    if (aforo_limitado === 1) {
      const ocupadas = await obtenerBloqueoActualFranja(env, id);

      if (capacidad < ocupadas) {
        return json(
          {
            ok: false,
            error: `La capacidad no puede ser inferior a las plazas ya bloqueadas (${ocupadas}).`
          },
          { status: 400 }
        );
      }
    }

    const hayCambioReal = franjaHaCambiado(existente, siguienteFranja);
    const franjaEstabaActiva = Number(existente.activa ?? 1) === 1;
    const debeNotificarCambios = hayCambioReal && franjaEstabaActiva;
    const debeResincronizarPatron = hayCambioReal && Number(existente.es_recurrente || 0) === 1;
    const reservasAfectadas = debeNotificarCambios ? await obtenerReservasAfectadasFranja(env, id) : [];
    const reservasMaterializadasAfectadas = debeResincronizarPatron
      ? await contarReservasFuturasMaterializacionesPatron(env, id)
      : 0;
    if (debeNotificarCambios && (reservasAfectadas.length > 0 || reservasMaterializadasAfectadas > 0) && !confirmarAfectacion) {
      const totalAfectadas = reservasAfectadas.length + reservasMaterializadasAfectadas;
      return json({
        ok: false,
        requiere_confirmacion_afectacion: true,
        total_afectadas: totalAfectadas,
        mensaje: totalAfectadas === 1
          ? "Existe 1 solicitud vinculada a esta programación. Si continúas, se notificará al solicitante y se aplicarán las reglas de negocio correspondientes."
          : `Existen ${totalAfectadas} solicitudes vinculadas a esta programación. Si continúas, se notificará a los solicitantes y se aplicarán las reglas de negocio correspondientes.`
      }, { status: 409 });
    }

    const updateResult = await env.DB.prepare(`
      UPDATE franjas
      SET
        fecha = ?,
        hora_inicio = ?,
        hora_fin = ?,
        capacidad = ?,
        es_recurrente = ?,
        patron_recurrencia = ?,
        recurrencia_tipo = ?,
        recurrencia_intervalo = ?,
        recurrencia_weekday = ?,
        recurrencia_weekdays = ?,
        recurrencia_ordinal = ?,
        recurrencia_monthday = ?,
        recurrencia_month = ?,
        recurrencia_inicio = ?,
        recurrencia_fin = ?,
        recurrencia_fin_tipo = ?,
        recurrencia_repeticiones = ?
      WHERE id = ?
    `)
      .bind(
        es_recurrente === 1 ? null : fecha,
        hora_inicio,
        hora_fin,
        aforo_limitado === 1 ? capacidad : null,
        es_recurrente,
        es_recurrente === 1 ? patron_recurrencia : null,
        es_recurrente === 1 ? regla_recurrencia.tipo : null,
        es_recurrente === 1 ? regla_recurrencia.intervalo : 1,
        es_recurrente === 1 ? regla_recurrencia.weekday : null,
        es_recurrente === 1 ? regla_recurrencia.weekdays.join(",") : null,
        es_recurrente === 1 ? regla_recurrencia.ordinal : null,
        es_recurrente === 1 ? regla_recurrencia.monthday : null,
        es_recurrente === 1 ? regla_recurrencia.month : null,
        es_recurrente === 1 ? regla_recurrencia.inicio : null,
        es_recurrente === 1 && regla_recurrencia.fin_tipo === "FECHA" ? regla_recurrencia.fin : null,
        es_recurrente === 1 ? regla_recurrencia.fin_tipo : null,
        es_recurrente === 1 ? regla_recurrencia.repeticiones : null,
        id
      )
      .run();

    if ((updateResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo actualizar la franja." },
        { status: 500 }
      );
    }

    let resumenAfectacion = null;
    if (debeNotificarCambios && reservasAfectadas.length > 0) {
      resumenAfectacion = await aplicarCambiosYNotificarFranja(
        env,
        reservasAfectadas,
        existente,
        siguienteFranja,
        {
          actorUsuarioId: session.usuario_id,
          actorRol: "ADMIN"
        }
      );
    }

    if (debeResincronizarPatron) {
      const resumenMaterializaciones = await limpiarMaterializacionesFuturasPatron(env, existente);
      if (es_recurrente === 1) {
        await materializarPatronRecurrencia(env, {
          ...existente,
          ...siguienteFranja,
          id,
          actividad_id: existente.actividad_id
        });
      }
      if (resumenMaterializaciones.franjas_eliminadas > 0 || resumenMaterializaciones.reservas_afectadas > 0) {
        resumenAfectacion = {
          ...(resumenAfectacion || {}),
          materializaciones: resumenMaterializaciones
        };
      }
    }

    const franjas = await obtenerResumenFranjas(env, existente.actividad_id);

    return json({
      ok: true,
      mensaje: "Franja actualizada correctamente.",
      resumen_afectacion: resumenAfectacion,
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al actualizar la franja.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestDelete(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    await asegurarEstructuraEstadoFranjas(env);
    const session = await getAdminSession(request, env);
    const data = await request.json();
    const resetProgramacion = data.reset_programacion === true || data.reset_programacion === 1 || data.reset_programacion === "1";
    const actividadResetId = parsearIdPositivo(data.actividad_id);

    if (resetProgramacion) {
      if (!actividadResetId) {
        return json({ ok: false, error: "actividad_id es obligatorio para resetear la programación." }, { status: 400 });
      }

      await checkAdminActividad(env, session.usuario_id, actividadResetId);
      const resultadoReset = await resetearProgramacionActividad(env, actividadResetId);

      if (resultadoReset?.bloquear) {
        return json(
          { ok: false, bloquear: true, error: resultadoReset.error },
          { status: 400 }
        );
      }

      const franjas = await obtenerResumenFranjas(env, actividadResetId);

      return json({
        ok: true,
        mensaje: "Programación reseteada correctamente.",
        resumen_afectacion: resultadoReset?.resumen || null,
        franjas
      });
    }

    const id = parsearIdPositivo(data.id);

    if (!id) {
      return json({ ok: false, error: "ID de franja no válido." }, { status: 400 });
    }

    const existente = await obtenerFranjaPorId(env, id);

    if (!existente) {
      return json(
        { ok: false, error: "La franja indicada no existe." },
        { status: 404 }
      );
    }

    await checkAdminActividad(env, session.usuario_id, existente.actividad_id);

    const actividad = await obtenerActividad(env, existente.actividad_id);
    const confirmarEliminacion = data.confirmar === true || data.confirmar === 1 || data.confirmar === "1";
    const reservasHistoricas = await contarReservasHistoricasFranja(env, id);

    if (reservasHistoricas > 0) {
      return json({
        ok: false,
        bloquear: true,
        error: "No se puede eliminar la franja porque tiene solicitudes históricas asociadas. El histórico debe conservarse."
      }, { status: 400 });
    }

    const reservasAfectadas = Number(actividad?.borrador_tecnico || 0) === 1
      ? []
      : await obtenerReservasFuturasFranja(env, id);

    if (reservasAfectadas.length > 0 && !confirmarEliminacion) {
      return json({
        ok: false,
        requiere_confirmacion: true,
        total_afectadas: reservasAfectadas.length,
        mensaje: reservasAfectadas.length === 1
          ? "Existe 1 solicitud futura asociada a esta franja. Si continúas, la solicitud se eliminará automáticamente y se enviará un correo al solicitante."
          : `Existen ${reservasAfectadas.length} solicitudes futuras asociadas a esta franja. Si continúas, esas solicitudes se eliminarán automáticamente y se enviará un correo a cada solicitante.`
      }, { status: 409 });
    }

    const franjasAlternativas = reservasAfectadas.length > 0
      ? await obtenerFranjasDisponiblesAlternativas(env, existente.actividad_id, id)
      : [];

    let resumenAfectacion = null;
    if (reservasAfectadas.length > 0) {
      resumenAfectacion = await eliminarReservasPorEliminacionFranja(
        env,
        reservasAfectadas,
        existente,
        franjasAlternativas
      );
    }
    const deleteResult = await env.DB.prepare(`
      DELETE FROM franjas
      WHERE id = ?
    `)
      .bind(id)
      .run();

    if ((deleteResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo eliminar la franja." },
        { status: 500 }
      );
    }

    if (existente.recurrencia_origen_id) {
      const restantesMismoPatron = await contarFranjasMaterializadasDelMismoPatron(
        env,
        existente.recurrencia_origen_id,
        id
      );

      if (restantesMismoPatron === 0) {
        await env.DB.prepare(`
          DELETE FROM franjas
          WHERE id = ?
            AND COALESCE(es_recurrente, 0) = 1
        `)
          .bind(existente.recurrencia_origen_id)
          .run();
      }
    }

    const franjas = await obtenerResumenFranjas(env, existente.actividad_id);

    return json({
      ok: true,
      mensaje: "Franja eliminada correctamente.",
      resumen_afectacion: resumenAfectacion,
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al eliminar la franja.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
