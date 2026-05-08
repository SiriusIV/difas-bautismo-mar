function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function parsearIdPositivo(valor) {
  const numero = parseInt(valor, 10);
  return Number.isInteger(numero) && numero > 0 ? numero : null;
}

function nombreActorPorDefecto(rol = "") {
  const rolNormalizado = limpiarTexto(rol).toUpperCase();
  if (rolNormalizado === "SOLICITANTE") return "Solicitante";
  if (rolNormalizado === "ADMIN") return "Administrador";
  if (rolNormalizado === "SUPERADMIN") return "Superadministrador";
  if (rolNormalizado === "SECRETARIA") return "Secretaria";
  return "Sistema";
}

async function resolverActor(env, actor = {}) {
  const actorUsuarioId = parsearIdPositivo(actor.actorUsuarioId);
  let actorRol = limpiarTexto(actor.actorRol).toUpperCase();
  let actorNombre = limpiarTexto(actor.actorNombre);

  if (actorUsuarioId && (!actorRol || !actorNombre)) {
    const row = await env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(nombre_publico), ''), NULLIF(TRIM(nombre), ''), NULLIF(TRIM(email), ''), '') AS nombre_actor,
        COALESCE(NULLIF(TRIM(rol), ''), '') AS rol_actor
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(actorUsuarioId).first();

    if (!actorNombre) actorNombre = limpiarTexto(row?.nombre_actor);
    if (!actorRol) actorRol = limpiarTexto(row?.rol_actor).toUpperCase();
  }

  if (!actorRol) actorRol = "SISTEMA";
  if (!actorNombre) actorNombre = nombreActorPorDefecto(actorRol);

  return {
    actorUsuarioId,
    actorRol,
    actorNombre
  };
}

export async function asegurarTablaHistorialReservas(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS reservas_historial_estados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reserva_id INTEGER NOT NULL,
      accion TEXT NOT NULL,
      estado_origen TEXT,
      estado_destino TEXT,
      observaciones TEXT,
      actor_usuario_id INTEGER,
      actor_rol TEXT,
      actor_nombre TEXT,
      fecha_evento TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_reservas_historial_reserva_fecha
    ON reservas_historial_estados (reserva_id, fecha_evento DESC, id DESC)
  `).run();
}

export async function registrarEventoReserva(env, evento = {}) {
  const reservaId = parsearIdPositivo(evento.reservaId);
  const accion = limpiarTexto(evento.accion).toUpperCase();
  if (!reservaId || !accion) return { ok: false, skipped: true };

  await asegurarTablaHistorialReservas(env);
  const actor = await resolverActor(env, evento);

  const result = await env.DB.prepare(`
    INSERT INTO reservas_historial_estados (
      reserva_id,
      accion,
      estado_origen,
      estado_destino,
      observaciones,
      actor_usuario_id,
      actor_rol,
      actor_nombre,
      fecha_evento
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    reservaId,
    accion,
    limpiarTexto(evento.estadoOrigen).toUpperCase() || null,
    limpiarTexto(evento.estadoDestino).toUpperCase() || null,
    limpiarTexto(evento.observaciones) || null,
    actor.actorUsuarioId,
    actor.actorRol,
    actor.actorNombre
  ).run();

  return {
    ok: Number(result?.meta?.changes || 0) > 0
  };
}

export async function obtenerHistorialReservas(env, reservaIds = []) {
  const ids = Array.from(new Set((reservaIds || []).map(parsearIdPositivo).filter(Boolean)));
  if (!ids.length) return new Map();

  await asegurarTablaHistorialReservas(env);

  const placeholders = ids.map(() => "?").join(", ");
  const result = await env.DB.prepare(`
    SELECT
      id,
      reserva_id,
      accion,
      estado_origen,
      estado_destino,
      observaciones,
      actor_usuario_id,
      actor_rol,
      actor_nombre,
      fecha_evento
    FROM reservas_historial_estados
    WHERE reserva_id IN (${placeholders})
    ORDER BY fecha_evento DESC, id DESC
  `).bind(...ids).all();

  const mapa = new Map();
  for (const row of result?.results || []) {
    const reservaId = parsearIdPositivo(row.reserva_id);
    if (!reservaId) continue;
    if (!mapa.has(reservaId)) mapa.set(reservaId, []);
    mapa.get(reservaId).push({
      id: parsearIdPositivo(row.id),
      accion: limpiarTexto(row.accion).toUpperCase(),
      estado_origen: limpiarTexto(row.estado_origen).toUpperCase(),
      estado_destino: limpiarTexto(row.estado_destino).toUpperCase(),
      observaciones: limpiarTexto(row.observaciones),
      actor_usuario_id: parsearIdPositivo(row.actor_usuario_id),
      actor_rol: limpiarTexto(row.actor_rol).toUpperCase(),
      actor_nombre: limpiarTexto(row.actor_nombre),
      fecha_evento: limpiarTexto(row.fecha_evento)
    });
  }

  return mapa;
}

export async function borrarHistorialReservas(env, reservaIds = []) {
  const ids = Array.from(new Set((reservaIds || []).map(parsearIdPositivo).filter(Boolean)));
  if (!ids.length) return 0;

  await asegurarTablaHistorialReservas(env);
  const placeholders = ids.map(() => "?").join(", ");
  const result = await env.DB.prepare(`
    DELETE FROM reservas_historial_estados
    WHERE reserva_id IN (${placeholders})
  `).bind(...ids).run();

  return Number(result?.meta?.changes || 0);
}
