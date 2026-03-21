export async function getRolUsuario(env, usuario_id) {
  const { results } = await env.DB.prepare(`
    SELECT rol
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `)
    .bind(usuario_id)
    .all();

  return results?.[0]?.rol || null;
}

export async function checkAdminActividad(env, usuario_id, actividad_id) {
  const rol = await getRolUsuario(env, usuario_id);

  if (rol === "SUPERADMIN") {
    return;
  }

  if (!actividad_id) {
    throw new Error("actividad_id requerido");
  }

  const { results } = await env.DB.prepare(`
    SELECT 1
    FROM usuario_actividad
    WHERE usuario_id = ?
      AND actividad_id = ?
      AND activo = 1
    LIMIT 1
  `)
    .bind(usuario_id, actividad_id)
    .all();

  if (!results || results.length === 0) {
    throw new Error("No autorizado para esta actividad");
  }
}
