export async function checkAdminActividad(env, usuario_id, actividad_id) {
  if (!actividad_id) {
    throw new Error("actividad_id requerido");
  }

  // Obtener rol
  const { results: rolRes } = await env.DB.prepare(`
    SELECT rol
    FROM usuarios
    WHERE id = ?
  `)
    .bind(usuario_id)
    .all();

  if (rolRes.length && rolRes[0].rol === "SUPERADMIN") {
    return; // acceso total
  }

  // Validar asignación a actividad
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
