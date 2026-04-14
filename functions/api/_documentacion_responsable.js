function limpiarTexto(valor) {
  return String(valor || "").trim();
}

export async function obtenerAdminDocumental(env, adminId) {
  const admin = await env.DB.prepare(`
    SELECT
      id,
      nombre,
      nombre_publico,
      localidad,
      email,
      rol,
      COALESCE(modulo_secretaria, 0) AS modulo_secretaria,
      secretaria_usuario_id
    FROM usuarios
    WHERE id = ?
      AND rol IN ('ADMIN', 'SUPERADMIN')
    LIMIT 1
  `).bind(adminId).first();

  if (!admin) {
    return null;
  }

  return {
    id: Number(admin.id || 0),
    nombre: admin.nombre || "",
    nombre_publico: admin.nombre_publico || "",
    localidad: admin.localidad || "",
    email: admin.email || "",
    rol: admin.rol || "",
    modulo_secretaria: Number(admin.modulo_secretaria || 0) === 1,
    secretaria_usuario_id: admin.secretaria_usuario_id ? Number(admin.secretaria_usuario_id) : null
  };
}

export async function resolverResponsableDocumental(env, adminId) {
  const admin = await obtenerAdminDocumental(env, adminId);
  if (!admin) return null;

  if (admin.modulo_secretaria) {
    return {
      modo: "AUTOGESTION",
      admin,
      responsable: admin,
      puede_gestionar_documentacion: true
    };
  }

  if (admin.secretaria_usuario_id) {
    const secretaria = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        nombre_publico,
        localidad,
        email,
        rol
      FROM usuarios
      WHERE id = ?
        AND rol = 'SECRETARIA'
      LIMIT 1
    `).bind(admin.secretaria_usuario_id).first();

    if (secretaria) {
      return {
        modo: "SECRETARIA_EXTERNA",
        admin,
        responsable: {
          id: Number(secretaria.id || 0),
          nombre: secretaria.nombre || "",
          nombre_publico: secretaria.nombre_publico || "",
          localidad: secretaria.localidad || "",
          email: secretaria.email || "",
          rol: secretaria.rol || ""
        },
        puede_gestionar_documentacion: true
      };
    }
  }

  return {
    modo: "SIN_SECRETARIA_ASIGNADA",
    admin,
    responsable: admin,
    puede_gestionar_documentacion: false,
    observacion: limpiarTexto("El administrador no tiene módulo de secretaría activado ni una secretaría externa válida asignada.")
  };
}
