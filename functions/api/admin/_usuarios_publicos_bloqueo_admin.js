function limpiarTexto(valor) {
  return String(valor || "").trim();
}

export async function asegurarTablaBloqueosUsuariosPublicosAdmin(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS usuarios_publicos_bloqueos_admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_usuario_id INTEGER NOT NULL,
      usuario_publico_id INTEGER NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      motivo TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(admin_usuario_id, usuario_publico_id)
    )
  `).run();
}

export async function obtenerBloqueoUsuarioPublicoPorAdmin(env, adminUsuarioId, usuarioPublicoId) {
  await asegurarTablaBloqueosUsuariosPublicosAdmin(env);
  const adminId = Number(adminUsuarioId || 0);
  const usuarioId = Number(usuarioPublicoId || 0);
  if (!(adminId > 0) || !(usuarioId > 0)) return null;

  return await env.DB.prepare(`
    SELECT
      id,
      admin_usuario_id,
      usuario_publico_id,
      activo,
      motivo,
      created_by,
      created_at,
      updated_at
    FROM usuarios_publicos_bloqueos_admin
    WHERE admin_usuario_id = ?
      AND usuario_publico_id = ?
    LIMIT 1
  `).bind(adminId, usuarioId).first();
}

export async function estaUsuarioPublicoBloqueadoParaAdmin(env, adminUsuarioId, usuarioPublicoId) {
  const row = await obtenerBloqueoUsuarioPublicoPorAdmin(env, adminUsuarioId, usuarioPublicoId);
  return Number(row?.activo || 0) === 1;
}

export async function actualizarBloqueoUsuarioPublicoPorAdmin(env, {
  adminUsuarioId,
  usuarioPublicoId,
  activo,
  motivo,
  actorUsuarioId
} = {}) {
  await asegurarTablaBloqueosUsuariosPublicosAdmin(env);
  const adminId = Number(adminUsuarioId || 0);
  const usuarioId = Number(usuarioPublicoId || 0);
  const actorId = Number(actorUsuarioId || 0) || null;
  const activoNormalizado = activo ? 1 : 0;
  const motivoNormalizado = limpiarTexto(motivo);

  if (!(adminId > 0)) {
    throw new Error("Administrador no válido.");
  }
  if (!(usuarioId > 0)) {
    throw new Error("Usuario público no válido.");
  }
  if (activoNormalizado === 1 && !motivoNormalizado) {
    throw new Error("Debes indicar el motivo del bloqueo.");
  }

  const usuario = await env.DB.prepare(`
    SELECT id, rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(usuarioId).first();

  if (!usuario || String(usuario.rol || "").toUpperCase() !== "SOLICITANTE") {
    throw new Error("La cuenta indicada no corresponde a un usuario público.");
  }

  await env.DB.prepare(`
    INSERT INTO usuarios_publicos_bloqueos_admin (
      admin_usuario_id,
      usuario_publico_id,
      activo,
      motivo,
      created_by,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(admin_usuario_id, usuario_publico_id) DO UPDATE SET
      activo = excluded.activo,
      motivo = excluded.motivo,
      created_by = excluded.created_by,
      updated_at = datetime('now')
  `).bind(
    adminId,
    usuarioId,
    activoNormalizado,
    activoNormalizado === 1 ? motivoNormalizado : "",
    actorId
  ).run();

  return await obtenerBloqueoUsuarioPublicoPorAdmin(env, adminId, usuarioId);
}
