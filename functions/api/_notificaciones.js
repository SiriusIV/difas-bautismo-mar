function limpiarTexto(valor) {
  return String(valor || "").trim();
}

export async function crearNotificacion(env, {
  usuarioId,
  rolDestino = "",
  tipo = "",
  titulo,
  mensaje = "",
  urlDestino = ""
} = {}) {
  const id = Number(usuarioId || 0);
  const tituloLimpio = limpiarTexto(titulo);
  if (!id || !tituloLimpio) {
    return { ok: false, error: "Faltan datos para crear la notificación." };
  }

  await env.DB.prepare(`
    INSERT INTO notificaciones (
      usuario_id,
      rol_destino,
      tipo,
      titulo,
      mensaje,
      url_destino,
      leida,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
  `).bind(
    id,
    limpiarTexto(rolDestino).toUpperCase() || null,
    limpiarTexto(tipo).toUpperCase() || null,
    tituloLimpio,
    limpiarTexto(mensaje) || null,
    limpiarTexto(urlDestino) || null
  ).run();

  return { ok: true };
}

export async function listarNotificaciones(env, usuarioId, { limit = 25, soloNoLeidas = false } = {}) {
  const id = Number(usuarioId || 0);
  const limiteSeguro = Math.max(1, Math.min(100, Number(limit || 25)));
  if (!id) return { total: 0, unread: 0, items: [] };

  const whereNoLeidas = soloNoLeidas ? "AND COALESCE(leida, 0) = 0" : "";

  const [rows, unreadRow] = await Promise.all([
    env.DB.prepare(`
      SELECT
        id,
        usuario_id,
        rol_destino,
        tipo,
        titulo,
        mensaje,
        url_destino,
        leida,
        created_at,
        leida_at
      FROM notificaciones
      WHERE usuario_id = ?
        ${whereNoLeidas}
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).bind(id, limiteSeguro).all(),
    env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM notificaciones
      WHERE usuario_id = ?
        AND COALESCE(leida, 0) = 0
    `).bind(id).first()
  ]);

  const items = (rows?.results || []).map((row) => ({
    id: Number(row.id || 0),
    usuario_id: Number(row.usuario_id || 0),
    rol_destino: row.rol_destino || "",
    tipo: row.tipo || "",
    titulo: row.titulo || "",
    mensaje: row.mensaje || "",
    url_destino: row.url_destino || "",
    leida: Number(row.leida || 0) === 1,
    created_at: row.created_at || "",
    leida_at: row.leida_at || ""
  }));

  return {
    total: items.length,
    unread: Number(unreadRow?.total || 0),
    items
  };
}

export async function marcarNotificacionLeida(env, usuarioId, notificacionId) {
  const userId = Number(usuarioId || 0);
  const id = Number(notificacionId || 0);
  if (!userId || !id) return { ok: false, error: "Identificador inválido." };

  const result = await env.DB.prepare(`
    UPDATE notificaciones
    SET
      leida = 1,
      leida_at = CASE WHEN leida_at IS NULL THEN CURRENT_TIMESTAMP ELSE leida_at END
    WHERE id = ?
      AND usuario_id = ?
  `).bind(id, userId).run();

  return { ok: true, changes: Number(result?.meta?.changes || 0) };
}

export async function marcarTodasLasNotificacionesLeidas(env, usuarioId) {
  const userId = Number(usuarioId || 0);
  if (!userId) return { ok: false, error: "Usuario inválido." };

  const result = await env.DB.prepare(`
    UPDATE notificaciones
    SET
      leida = 1,
      leida_at = CASE WHEN leida_at IS NULL THEN CURRENT_TIMESTAMP ELSE leida_at END
    WHERE usuario_id = ?
      AND COALESCE(leida, 0) = 0
  `).bind(userId).run();

  return { ok: true, changes: Number(result?.meta?.changes || 0) };
}
