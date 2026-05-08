function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function dbPrimaria(env) {
  if (typeof env?.DB?.withSession === "function") {
    return env.DB.withSession("first-primary");
  }
  return env.DB;
}

function esErrorColumnaDuplicada(error) {
  const texto = limpiarTexto(error?.message || error || "").toLowerCase();
  return (
    texto.includes("duplicate column name") ||
    texto.includes("duplicate column")
  );
}

async function asegurarTablaNotificaciones(env) {
  await dbPrimaria(env).prepare(`
    CREATE TABLE IF NOT EXISTS notificaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      rol_destino TEXT,
      tipo TEXT,
      titulo TEXT NOT NULL,
      mensaje TEXT,
      url_destino TEXT,
      leida INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      leida_at TEXT
    )
  `).run();

  const columnasOpcionales = [
    "ALTER TABLE notificaciones ADD COLUMN rol_destino TEXT",
    "ALTER TABLE notificaciones ADD COLUMN tipo TEXT",
    "ALTER TABLE notificaciones ADD COLUMN mensaje TEXT",
    "ALTER TABLE notificaciones ADD COLUMN url_destino TEXT",
    "ALTER TABLE notificaciones ADD COLUMN leida INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE notificaciones ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "ALTER TABLE notificaciones ADD COLUMN leida_at TEXT"
  ];

  for (const sql of columnasOpcionales) {
    try {
        await dbPrimaria(env).prepare(sql).run();
    } catch (error) {
      if (!esErrorColumnaDuplicada(error)) {
        const mensaje = limpiarTexto(error?.message || error || "").toLowerCase();
        if (!mensaje.includes("cannot add a column with non-constant default")) {
          throw error;
        }
      }
    }
  }

  try {
    await dbPrimaria(env).prepare(`
      CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario_created
      ON notificaciones (usuario_id, created_at DESC, id DESC)
    `).run();
  } catch (error) {
    if (!hayErrorEsquemaNotificaciones(error)) {
      throw error;
    }
    await dbPrimaria(env).prepare(`
      CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario_id
      ON notificaciones (usuario_id, id DESC)
    `).run();
  }
}

function esErrorColumnaAusente(error, columna) {
  const texto = limpiarTexto(error?.message || error || "").toLowerCase();
  const nombreColumna = String(columna || "").toLowerCase();
  return (
    texto.includes(nombreColumna) &&
    (
      texto.includes("no column named") ||
      texto.includes("has no column named") ||
      texto.includes("no such column")
    )
  );
}

function hayErrorEsquemaNotificaciones(error) {
  return [
    "rol_destino",
    "url_destino",
    "tipo",
    "mensaje",
    "leida",
    "leida_at",
    "created_at"
  ].some((columna) => esErrorColumnaAusente(error, columna));
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
    },
    {
      columnas: ["usuario_id", "titulo", "mensaje", "leida", "created_at"],
      binds: [
        valores.usuario_id,
        valores.titulo,
        valores.mensaje
      ]
    },
    {
      columnas: ["usuario_id", "titulo", "leida", "created_at"],
      binds: [
        valores.usuario_id,
        valores.titulo
      ]
    },
    {
      columnas: ["usuario_id", "titulo", "mensaje", "created_at"],
      binds: [
        valores.usuario_id,
        valores.titulo,
        valores.mensaje
      ]
    },
    {
      columnas: ["usuario_id", "titulo", "created_at"],
      binds: [
        valores.usuario_id,
        valores.titulo
      ]
    },
    {
      columnas: ["usuario_id", "titulo", "mensaje", "leida"],
      binds: [
        valores.usuario_id,
        valores.titulo,
        valores.mensaje
      ]
    },
    {
      columnas: ["usuario_id", "titulo", "leida"],
      binds: [
        valores.usuario_id,
        valores.titulo
      ]
    },
    {
      columnas: ["usuario_id", "titulo", "mensaje"],
      binds: [
        valores.usuario_id,
        valores.titulo,
        valores.mensaje
      ]
    },
    {
      columnas: ["usuario_id", "titulo"],
      binds: [
        valores.usuario_id,
        valores.titulo
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
      await dbPrimaria(env).prepare(sql).bind(...variante.binds).run();
      return { ok: true };
    } catch (error) {
      ultimoError = error;
      if (!hayErrorEsquemaNotificaciones(error)) {
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
    `,
    `
      SELECT
        id,
        usuario_id,
        '' AS rol_destino,
        '' AS tipo,
        titulo,
        mensaje,
        '' AS url_destino,
        leida,
        created_at,
        '' AS leida_at
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
        '' AS tipo,
        titulo,
        '' AS mensaje,
        '' AS url_destino,
        leida,
        created_at,
        '' AS leida_at
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
        '' AS tipo,
        titulo,
        '' AS mensaje,
        '' AS url_destino,
        0 AS leida,
        created_at,
        '' AS leida_at
      FROM notificaciones
      WHERE usuario_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `,
    `
      SELECT
        id,
        usuario_id,
        '' AS rol_destino,
        '' AS tipo,
        titulo,
        '' AS mensaje,
        '' AS url_destino,
        0 AS leida,
        '' AS created_at,
        '' AS leida_at
      FROM notificaciones
      WHERE usuario_id = ?
      ORDER BY id DESC
      LIMIT ?
    `
  ];

  let ultimoError = null;
  for (const sql of variantes) {
    try {
      return await dbPrimaria(env).prepare(sql).bind(usuarioId, limiteSeguro).all();
    } catch (error) {
      ultimoError = error;
      if (!hayErrorEsquemaNotificaciones(error)) {
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

  await asegurarTablaNotificaciones(env);
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

  await asegurarTablaNotificaciones(env);
  const whereNoLeidas = soloNoLeidas ? "AND COALESCE(leida, 0) = 0" : "";

  const rows = await listarNotificacionesCompatible(env, id, limiteSeguro, whereNoLeidas);
  let unreadRow = null;
  try {
    unreadRow = await dbPrimaria(env).prepare(`
      SELECT COUNT(*) AS total
      FROM notificaciones
      WHERE usuario_id = ?
        AND COALESCE(leida, 0) = 0
    `).bind(id).first();
  } catch (error) {
    if (!hayErrorEsquemaNotificaciones(error)) {
      throw error;
    }
    unreadRow = { total: Number(rows?.results?.length || 0) };
  }

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

  await asegurarTablaNotificaciones(env);
  let result;
  try {
    result = await dbPrimaria(env).prepare(`
      UPDATE notificaciones
      SET
        leida = 1,
        leida_at = CASE WHEN leida_at IS NULL THEN CURRENT_TIMESTAMP ELSE leida_at END
      WHERE id = ?
        AND usuario_id = ?
    `).bind(id, userId).run();
  } catch (error) {
    if (!hayErrorEsquemaNotificaciones(error)) {
      throw error;
    }
    try {
      result = await dbPrimaria(env).prepare(`
        UPDATE notificaciones
        SET leida = 1
        WHERE id = ?
          AND usuario_id = ?
      `).bind(id, userId).run();
    } catch (errorLeida) {
      if (!hayErrorEsquemaNotificaciones(errorLeida)) {
        throw errorLeida;
      }
      return { ok: true, changes: 0 };
    }
  }

  return { ok: true, changes: Number(result?.meta?.changes || 0) };
}

export async function marcarTodasLasNotificacionesLeidas(env, usuarioId) {
  const userId = Number(usuarioId || 0);
  if (!userId) return { ok: false, error: "Usuario inválido." };

  let result;
  try {
    result = await dbPrimaria(env).prepare(`
      UPDATE notificaciones
      SET
        leida = 1,
        leida_at = CASE WHEN leida_at IS NULL THEN CURRENT_TIMESTAMP ELSE leida_at END
      WHERE usuario_id = ?
        AND COALESCE(leida, 0) = 0
    `).bind(userId).run();
  } catch (error) {
    if (!hayErrorEsquemaNotificaciones(error)) {
      throw error;
    }
    try {
      result = await dbPrimaria(env).prepare(`
        UPDATE notificaciones
        SET leida = 1
        WHERE usuario_id = ?
      `).bind(userId).run();
    } catch (errorLeida) {
      if (!hayErrorEsquemaNotificaciones(errorLeida)) {
        throw errorLeida;
      }
      return { ok: true, changes: 0 };
    }
  }

  return { ok: true, changes: Number(result?.meta?.changes || 0) };
}
