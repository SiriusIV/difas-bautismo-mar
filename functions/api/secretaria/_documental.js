import { getUserSession } from "../usuario/_auth.js";
import { recalcularImpactoDocumentalReservas } from "../_impacto_documental_reservas.js";
import { resolverResponsableDocumental } from "../_documentacion_responsable.js";

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

export async function getSecretariaSession(request, env) {
  const session = await getUserSession(request, env.SECRET_KEY);
  if (!session) return null;

  const rol = limpiarTexto(session.rol).toUpperCase();
  if (!["SECRETARIA", "SUPERADMIN"].includes(rol)) {
    return null;
  }

  return {
    usuario_id: Number(session.id || 0),
    username: session.email || "",
    rol
  };
}

export async function obtenerSecretariaPerfil(env, secretariaId) {
  return await env.DB.prepare(`
    SELECT
      id,
      nombre,
      nombre_publico,
      email,
      localidad,
      telefono_contacto,
      rol
    FROM usuarios
    WHERE id = ?
      AND rol = 'SECRETARIA'
    LIMIT 1
  `).bind(secretariaId).first();
}

export async function obtenerAdminsAdscritos(env, secretariaId) {
  const rows = await env.DB.prepare(`
    SELECT
      id,
      nombre,
      nombre_publico,
      email,
      localidad
    FROM usuarios
    WHERE rol = 'ADMIN'
      AND secretaria_usuario_id = ?
      AND COALESCE(modulo_secretaria, 0) = 0
    ORDER BY
      CASE
        WHEN nombre_publico IS NOT NULL AND TRIM(nombre_publico) <> '' THEN TRIM(nombre_publico)
        ELSE TRIM(nombre)
      END COLLATE NOCASE ASC,
      id ASC
  `).bind(secretariaId).all();

  return rows?.results || [];
}

export async function obtenerAdminAdscrito(env, secretariaId, adminId) {
  return await env.DB.prepare(`
    SELECT
      id,
      nombre,
      nombre_publico,
      email,
      localidad
    FROM usuarios
    WHERE id = ?
      AND rol = 'ADMIN'
      AND secretaria_usuario_id = ?
      AND COALESCE(modulo_secretaria, 0) = 0
    LIMIT 1
  `).bind(adminId, secretariaId).first();
}

export async function obtenerExpedienteGestionadoPorSecretaria(env, secretariaId, documentacionId) {
  return await env.DB.prepare(`
    SELECT
      cad.id,
      cad.centro_usuario_id,
      cad.admin_id,
      cad.version_requerida,
      cad.version_aportada,
      cad.estado,
      cad.fecha_ultima_entrega,
      cad.fecha_validacion,
      cad.observaciones_admin,
      cad.updated_at,
      u.centro,
      u.email,
      u.telefono_contacto,
      admin.nombre AS admin_nombre,
      admin.nombre_publico AS admin_nombre_publico
    FROM centro_admin_documentacion cad
    INNER JOIN usuarios u
      ON u.id = cad.centro_usuario_id
    INNER JOIN usuarios admin
      ON admin.id = cad.admin_id
    WHERE cad.id = ?
      AND admin.rol = 'ADMIN'
      AND admin.secretaria_usuario_id = ?
      AND COALESCE(admin.modulo_secretaria, 0) = 0
    LIMIT 1
  `).bind(documentacionId, secretariaId).first();
}

export async function obtenerDocumentosBaseSecretaria(env, secretariaId) {
  const rows = await env.DB.prepare(`
    SELECT
      id,
      admin_id,
      nombre,
      descripcion,
      archivo_url,
      orden,
      activo,
      version_documental,
      fecha_actualizacion
    FROM admin_documentos_comunes
    WHERE admin_id = ?
    ORDER BY orden ASC, id ASC
  `).bind(secretariaId).all();

  return rows?.results || [];
}

export async function recalcularImpactoSecretaria(env, secretariaId, baseUrl, motivo) {
  const admins = await obtenerAdminsAdscritos(env, secretariaId);
  const resumen = {
    ok: true,
    secretaria_id: Number(secretariaId || 0),
    motivo: motivo || "",
    admins_afectados: admins.length,
    detalle: []
  };

  for (const admin of admins) {
    const impacto = await recalcularImpactoDocumentalReservas(env, {
      adminId: Number(admin.id || 0),
      baseUrl,
      motivo
    });
    resumen.detalle.push({
      admin_id: Number(admin.id || 0),
      admin_nombre: admin.nombre_publico || admin.nombre || "",
      impacto
    });
  }

  return resumen;
}

export async function secretariaEsResponsableDeAdmin(env, secretariaId, adminId) {
  const resolucion = await resolverResponsableDocumental(env, adminId);
  if (!resolucion) return false;
  return (
    limpiarTexto(resolucion.modo).toUpperCase() === "SECRETARIA_EXTERNA" &&
    Number(resolucion.responsable?.id || 0) === Number(secretariaId || 0)
  );
}
