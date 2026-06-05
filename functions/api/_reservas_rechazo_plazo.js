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
