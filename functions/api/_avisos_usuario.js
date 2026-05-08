function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function dbPrimaria(env) {
  if (typeof env?.DB?.withSession === "function") {
    return env.DB.withSession("first-primary");
  }
  return env.DB;
}

export async function asegurarTablaAvisosUsuario(env) {
  await dbPrimaria(env).prepare(`
    CREATE TABLE IF NOT EXISTS reservas_avisos_usuario (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      tipo TEXT,
      titulo TEXT NOT NULL,
      mensaje TEXT,
      url_destino TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await dbPrimaria(env).prepare(`
    CREATE INDEX IF NOT EXISTS idx_avisos_usuario_created
    ON reservas_avisos_usuario (usuario_id, created_at DESC, id DESC)
  `).run();
}

export async function crearAvisoUsuario(env, {
  usuarioId,
  tipo = "",
  titulo,
  mensaje = "",
  urlDestino = ""
} = {}) {
  const id = Number(usuarioId || 0);
  const tituloLimpio = limpiarTexto(titulo);
  if (!(id > 0) || !tituloLimpio) {
    return { ok: false, skipped: true, error: "Faltan datos para crear el aviso." };
  }

  await asegurarTablaAvisosUsuario(env);
  const result = await dbPrimaria(env).prepare(`
    INSERT INTO reservas_avisos_usuario (
      usuario_id,
      tipo,
      titulo,
      mensaje,
      url_destino,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    id,
    limpiarTexto(tipo).toUpperCase() || null,
    tituloLimpio,
    limpiarTexto(mensaje) || null,
    limpiarTexto(urlDestino) || null
  ).run();

  return {
    ok: Number(result?.meta?.changes || 0) > 0,
    id: Number(result?.meta?.last_row_id || 0)
  };
}

export async function listarAvisosUsuario(env, usuarioId, { limit = 25 } = {}) {
  const id = Number(usuarioId || 0);
  const limiteSeguro = Math.max(1, Math.min(100, Number(limit || 25)));
  if (!(id > 0)) return [];

  await asegurarTablaAvisosUsuario(env);
  const result = await dbPrimaria(env).prepare(`
    SELECT
      id,
      usuario_id,
      tipo,
      titulo,
      mensaje,
      url_destino,
      created_at
    FROM reservas_avisos_usuario
    WHERE usuario_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).bind(id, limiteSeguro).all();

  return (result?.results || []).map((row) => ({
    id: Number(row.id || 0),
    usuario_id: Number(row.usuario_id || 0),
    tipo: limpiarTexto(row.tipo).toUpperCase(),
    titulo: limpiarTexto(row.titulo),
    mensaje: limpiarTexto(row.mensaje),
    url_destino: limpiarTexto(row.url_destino),
    created_at: limpiarTexto(row.created_at)
  }));
}
