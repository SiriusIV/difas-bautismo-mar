function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function esErrorColumnaAusente(error, columna) {
  const texto = limpiarTexto(error?.message || error || "").toLowerCase();
  return texto.includes("no column named") && texto.includes(String(columna || "").toLowerCase());
}

async function insertarNotificacionCompatible(env, valores) {
  const variantes = [
    {
      columnas: ["usuario_id", "rol_destino", "tipo", "titulo", "mensaje", "url_destino", "leida", "created_at"],
      binds: [
        valores.usuario_id,
        valores.rol_destino,
        valores.tipo,
        valores.titulo,
        valores.mensaje,
        valores.url_destino
      ]
    },
    {
      columnas: ["usuario_id", "tipo", "titulo", "mensaje", "url_destino", "leida", "created_at"],
      binds: [
        valores.usuario_id,
        valores.tipo,
        valores.titulo,
        valores.mensaje,
        valores.url_destino
      ]
    },
    {
      columnas: ["usuario_id", "rol_destino", "tipo", "titulo", "mensaje", "leida", "created_at"],
      binds: [
        valores.usuario_id,
        valores.rol_destino,
        valores.tipo,
        valores.titulo,
        valores.mensaje
      ]
    },
    {
      columnas: ["usuario_id", "tipo", "titulo", "mensaje", "leida", "created_at"],
      binds: [
        valores.usuario_id,
        valores.tipo,
        valores.titulo,
        valores.mensaje
      ]
    }
  ];

  let ultimoError = null;
  for (const variante of variantes) {
    try {
      const placeholders = variante.columnas
        .map((columna) => (columna === "leida" ? "0" : columna === "created_at" ? "CURRENT_TIMESTAMP" : "?"))
        .join(", ");
      const sql = `
        INSERT INTO notificaciones (
          ${variante.columnas.join(", ")}
        ) VALUES (${placeholders})
      `;
      await env.DB.prepare(sql).bind(...variante.binds).run();
      return { ok: true };
    } catch (error) {
      ultimoError = error;
      const faltaRol = esErrorColumnaAusente(error, "rol_destino");
      const faltaUrl = esErrorColumnaAusente(error, "url_destino");
      if (!faltaRol && !faltaUrl) {
        throw error;
      }
    }
  }

  throw ultimoError || new Error("No se pudo insertar la notificación.");
}

async function listarNotificacionesCompatible(env, usuarioId, limiteSeguro, whereNoLeidas) {
  const variantes = [
    `
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
    `,
    `
      SELECT
        id,
        usuario_id,
        '' AS rol_destino,
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
    `,
    `
      SELECT
        id,
        usuario_id,
        rol_destino,
        tipo,
        titulo,
        mensaje,
        '' AS url_destino,
        leida,
        created_at,
        leida_at
      FROM notificaciones
      WHERE usuario_id = ?
        ${whereNoLeidas}
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `,
    `
      SELECT
        id,
        usuario_id,
        '' AS rol_destino,
        tipo,
        titulo,
        mensaje,
        '' AS url_destino,
        leida,
        created_at,
        leida_at
      FROM notificaciones
      WHERE usuario_id = ?
        ${whereNoLeidas}
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `
  ];

  let ultimoError = null;
  for (const sql of variantes) {
    try {
      return await env.DB.prepare(sql).bind(usuarioId, limiteSeguro).all();
    } catch (error) {
      ultimoError = error;
      const faltaRol = esErrorColumnaAusente(error, "rol_destino");
      const faltaUrl = esErrorColumnaAusente(error, "url_destino");
      if (!faltaRol && !faltaUrl) {
        throw error;
      }
    }
  }

  throw ultimoError || new Error("No se pudieron listar las notificaciones.");
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

  return await insertarNotificacionCompatible(env, {
    usuario_id: id,
    rol_destino: limpiarTexto(rolDestino).toUpperCase() || null,
    tipo: limpiarTexto(tipo).toUpperCase() || null,
    titulo: tituloLimpio,
    mensaje: limpiarTexto(mensaje) || null,
    url_destino: limpiarTexto(urlDestino) || null
  });
}

export async function listarNotificaciones(env, usuarioId, { limit = 25, soloNoLeidas = false } = {}) {
  const id = Number(usuarioId || 0);
  const limiteSeguro = Math.max(1, Math.min(100, Number(limit || 25)));
  if (!id) return { total: 0, unread: 0, items: [] };

  const whereNoLeidas = soloNoLeidas ? "AND COALESCE(leida, 0) = 0" : "";

  let unreadRow;

  const [rows, unread] = await Promise.all([
    listarNotificacionesCompatible(env, id, limiteSeguro, whereNoLeidas),
    env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM notificaciones
      WHERE usuario_id = ?
        AND COALESCE(leida, 0) = 0
    `).bind(id).first()
  ]);
  unreadRow = unread;

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
