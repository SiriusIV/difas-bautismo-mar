function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function esErrorColumnaDuplicada(error) {
  const texto = limpiarTexto(error?.message || error || "").toLowerCase();
  return texto.includes("duplicate column name") || texto.includes("duplicate column");
}

export async function asegurarColumnaRechazoEliminaEn(env) {
  try {
    await env.DB.prepare(`
      ALTER TABLE reservas
      ADD COLUMN rechazo_elimina_en TEXT
    `).run();
  } catch (error) {
    if (!esErrorColumnaDuplicada(error)) {
      throw error;
    }
  }
}

function obtenerOffsetZonaMs(date, timeZone) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});

  const zonaComoUtc = Date.UTC(
    Number(partes.year),
    Number(partes.month) - 1,
    Number(partes.day),
    Number(partes.hour),
    Number(partes.minute),
    Number(partes.second)
  );
  return zonaComoUtc - date.getTime();
}

function fechaMadridDesdePartes(fecha, hora) {
  const fechaLimpia = limpiarTexto(fecha);
  if (!fechaLimpia) return null;
  const horaLimpia = limpiarTexto(hora) || "00:00:00";
  const normalizada = horaLimpia.length === 5 ? `${horaLimpia}:00` : horaLimpia;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(`${fechaLimpia}T${normalizada}`);
  if (!match) return null;

  const aproximacionUtc = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0)
  ));
  const offsetMs = obtenerOffsetZonaMs(aproximacionUtc, "Europe/Madrid");
  const date = new Date(aproximacionUtc.getTime() - offsetMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function obtenerInicioReserva(contexto = {}) {
  return fechaMadridDesdePartes(contexto?.fecha, contexto?.hora_inicio)
    || fechaMadridDesdePartes(contexto?.fecha_inicio, "00:00:00");
}

export function calcularFechaEliminacionRechazo(contexto = {}, ahora = new Date()) {
  const inicio = obtenerInicioReserva(contexto);
  if (!inicio) return null;

  const ahoraMs = ahora.getTime();
  const inicioMs = inicio.getTime();
  if (!Number.isFinite(inicioMs)) return null;

  const mitadMs = ahoraMs + Math.max(inicioMs - ahoraMs, 0) / 2;
  const veinticuatroHorasAntesMs = inicioMs - (24 * 60 * 60 * 1000);
  const eliminaMs = Math.min(mitadMs, veinticuatroHorasAntesMs);
  return new Date(eliminaMs);
}

export function formatearFechaDb(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function formatearFechaAvisoRechazo(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return "";
  const date = texto instanceof Date
    ? texto
    : new Date(`${texto.replace(" ", "T")}Z`);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return texto;

  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    dateStyle: "full",
    timeStyle: "short"
  }).format(date);
}

export async function obtenerReservasRechazadasConPlazoCentro(env, centroUsuarioId) {
  const usuarioId = Number(centroUsuarioId || 0);
  if (!(usuarioId > 0)) return [];

  await asegurarColumnaRechazoEliminaEn(env);

  const rows = await env.DB.prepare(`
    SELECT
      r.id,
      r.codigo_reserva,
      r.rechazo_elimina_en,
      COALESCE(r.observaciones_admin, '') AS observaciones_admin,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      COALESCE(a.fecha_inicio, '') AS fecha_inicio,
      COALESCE(f.fecha, '') AS fecha,
      COALESCE(f.hora_inicio, '') AS hora_inicio
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.usuario_id = ?
      AND UPPER(TRIM(COALESCE(r.estado, ''))) = 'RECHAZADA'
    ORDER BY COALESCE(r.rechazo_elimina_en, '9999-12-31 23:59:59') ASC, r.id ASC
  `).bind(usuarioId).all();

  const reservas = rows?.results || [];
  const resultado = [];

  for (const reserva of reservas) {
    const id = Number(reserva.id || 0);
    if (!(id > 0)) continue;

    let rechazoEliminaEn = limpiarTexto(reserva.rechazo_elimina_en || "");
    if (!rechazoEliminaEn) {
      rechazoEliminaEn = formatearFechaDb(calcularFechaEliminacionRechazo(reserva));
      if (rechazoEliminaEn) {
        await env.DB.prepare(`
          UPDATE reservas
          SET rechazo_elimina_en = ?
          WHERE id = ?
            AND (rechazo_elimina_en IS NULL OR TRIM(rechazo_elimina_en) = '')
        `).bind(rechazoEliminaEn, id).run();
      }
    }

    resultado.push({
      id,
      codigo_reserva: limpiarTexto(reserva.codigo_reserva || ""),
      actividad: limpiarTexto(reserva.actividad_nombre || "Actividad"),
      observaciones: limpiarTexto(reserva.observaciones_admin || ""),
      rechazo_elimina_en: rechazoEliminaEn,
      rechazo_elimina_en_texto: formatearFechaAvisoRechazo(rechazoEliminaEn)
    });
  }

  return resultado;
}
