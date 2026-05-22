import { getAdminSession } from "./_auth.js";
import { hashPassword } from "../usuario/_password.js";
import {
  asegurarTablaSolicitudesArmada,
  generarPasswordTemporal,
  limpiarTexto,
  normalizarCentro
} from "./_solicitudes_armada.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    if (String(session.rol || "").toUpperCase() !== "SUPERADMIN") {
      return json({ ok: false, error: "Solo SUPERADMIN" }, 403);
    }

    await asegurarTablaSolicitudesArmada(env.DB);

    const body = await request.json();
    const solicitudId = Number(body.solicitud_id || 0);
    const accion = limpiarTexto(body.accion).toUpperCase();
    const motivo = limpiarTexto(body.motivo);

    if (!solicitudId || !["APROBAR", "RECHAZAR"].includes(accion)) {
      return json({ ok: false, error: "Datos de resolución no válidos" }, 400);
    }

    const solicitud = await env.DB.prepare(`
      SELECT *
      FROM solicitudes_registro_armada
      WHERE id = ?
      LIMIT 1
    `).bind(solicitudId).first();

    if (!solicitud) {
      return json({ ok: false, error: "Solicitud no encontrada" }, 404);
    }

    if (String(solicitud.estado || "").toUpperCase() !== "PENDIENTE") {
      return json({ ok: false, error: "La solicitud ya fue resuelta anteriormente" }, 400);
    }

    if (accion === "RECHAZAR") {
      await env.DB.prepare(`
        UPDATE solicitudes_registro_armada
        SET
          estado = 'RECHAZADA',
          fecha_resolucion = datetime('now'),
          resuelto_por_superadmin_id = ?,
          motivo_resolucion = ?
        WHERE id = ?
      `).bind(session.usuario_id, motivo, solicitudId).run();

      return json({
        ok: true,
        estado: "RECHAZADA",
        mensaje: "Solicitud rechazada correctamente."
      });
    }

    const email = limpiarTexto(solicitud.email).toLowerCase();
    const centroNormalizado = normalizarCentro(solicitud.centro);

    const existingEmail = await env.DB.prepare(`
      SELECT id
      FROM usuarios
      WHERE email = ?
      LIMIT 1
    `).bind(email).first();

    if (existingEmail) {
      return json({ ok: false, error: "Ya existe un usuario con ese correo electrónico." }, 400);
    }

    const existingCentro = await env.DB.prepare(`
      SELECT id
      FROM usuarios
      WHERE UPPER(TRIM(centro)) = ?
        AND rol IN ('ADMIN', 'SUPERADMIN')
      LIMIT 1
    `).bind(centroNormalizado).first();

    if (existingCentro) {
      return json({ ok: false, error: "Ya existe una cuenta administrativa asociada a esa unidad o dependencia." }, 400);
    }

    const passwordTemporal = generarPasswordTemporal();
    const passwordHash = await hashPassword(passwordTemporal);

    const creado = await env.DB.prepare(`
      INSERT INTO usuarios (
        nombre,
        centro,
        localidad,
        email,
        password_hash,
        rol,
        telefono_contacto,
        responsable_legal,
        tipo_documento,
        documento_identificacion,
        activo,
        fecha_alta
      )
      VALUES (?, ?, ?, ?, ?, 'ADMIN', ?, ?, ?, ?, 1, datetime('now'))
    `).bind(
      limpiarTexto(solicitud.responsable_legal) || limpiarTexto(solicitud.centro),
      limpiarTexto(solicitud.centro),
      limpiarTexto(solicitud.localidad),
      email,
      passwordHash,
      limpiarTexto(solicitud.telefono_contacto),
      limpiarTexto(solicitud.responsable_legal),
      limpiarTexto(solicitud.tipo_documento).toUpperCase(),
      limpiarTexto(solicitud.documento_identificacion).toUpperCase()
    ).run();

    const usuarioCreadoId = Number(creado.meta?.last_row_id || 0);

    await env.DB.prepare(`
      UPDATE solicitudes_registro_armada
      SET
        estado = 'APROBADA',
        fecha_resolucion = datetime('now'),
        resuelto_por_superadmin_id = ?,
        motivo_resolucion = ?,
        usuario_creado_id = ?
      WHERE id = ?
    `).bind(session.usuario_id, motivo, usuarioCreadoId, solicitudId).run();

    return json({
      ok: true,
      estado: "APROBADA",
      mensaje: "Solicitud aprobada correctamente.",
      credenciales_temporales: {
        email,
        password_temporal: passwordTemporal
      }
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error resolviendo la solicitud de Usuario Armada",
      detalle: error.message
    }, 500);
  }
}
