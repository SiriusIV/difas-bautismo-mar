import { getAdminSession } from "./_auth.js";
import { actualizarBloqueoUsuarioPublicoPorAdmin } from "./_usuarios_publicos_bloqueo_admin.js";
import { enviarEmail } from "../_email.js";
import { crearNotificacion } from "../_notificaciones.js";
import { registrarEventoReserva } from "../_reservas_historial.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function escapeHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatearFechaTexto(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return "";
  const normalizado = texto.includes("T") ? texto : texto.replace(" ", "T");
  const fecha = new Date(normalizado);
  if (Number.isNaN(fecha.getTime())) return texto;
  const yyyy = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const dd = String(fecha.getDate()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy}`;
}

async function obtenerUsuarioPublico(env, usuarioId) {
  return await env.DB.prepare(`
    SELECT id, nombre, centro, email
    FROM usuarios
    WHERE id = ?
      AND rol = 'SOLICITANTE'
    LIMIT 1
  `).bind(Number(usuarioId || 0)).first();
}

async function obtenerReservasAfectadasAmbito(env, adminId, usuarioId) {
  const rows = await env.DB.prepare(`
    SELECT
      r.id,
      r.estado,
      r.actividad_id,
      r.codigo_reserva,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre
    FROM reservas r
    INNER JOIN actividades a
      ON a.id = r.actividad_id
    WHERE a.admin_id = ?
      AND r.usuario_id = ?
      AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
    ORDER BY r.id ASC
  `).bind(Number(adminId || 0), Number(usuarioId || 0)).all();
  return rows?.results || [];
}

function construirCorreoBloqueoAmbito(adminNombre, motivo, reservas = []) {
  const actividades = (reservas || []).map((r) => {
    const actividad = limpiarTexto(r.actividad_nombre || "Actividad");
    const codigo = limpiarTexto(r.codigo_reserva || "");
    return codigo ? `${actividad} (${codigo})` : actividad;
  });
  const asunto = "Bloqueo de solicitudes por organizador";
  const texto = [
    "Tu cuenta sigue activa en la plataforma, pero se ha bloqueado la posibilidad de solicitar actividades de un organizador concreto.",
    "",
    `Organizador: ${adminNombre}`,
    `Motivo del bloqueo: ${motivo}`,
    "",
    actividades.length
      ? "Solicitudes rechazadas automaticamente en este ambito:"
      : "No habia solicitudes activas afectadas en este ambito.",
    ...actividades.map((item) => `- ${item}`),
    "",
    "Las plazas asociadas a esas solicitudes han quedado liberadas segun la logica habitual."
  ].join("\n");
  const html = `
    <p>Tu cuenta sigue activa en la plataforma, pero se ha bloqueado la posibilidad de solicitar actividades de un organizador concreto.</p>
    <p><strong>Organizador:</strong> ${escapeHtml(adminNombre)}<br><strong>Motivo del bloqueo:</strong> ${escapeHtml(motivo)}</p>
    ${actividades.length ? `
      <p><strong>Solicitudes rechazadas automaticamente en este ambito:</strong></p>
      <ul>${actividades.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      <p>Las plazas asociadas a esas solicitudes han quedado liberadas segun la logica habitual.</p>
    ` : `<p>No habia solicitudes activas afectadas en este ambito.</p>`}
  `;
  return { asunto, texto, html };
}

function construirCorreoDesbloqueoAmbito(adminNombre) {
  const asunto = "Desbloqueo de solicitudes por organizador";
  const texto = [
    "Se ha levantado el bloqueo por ambito para tus solicitudes.",
    "",
    `Organizador: ${adminNombre}`,
    "",
    "Desde este momento puedes volver a solicitar actividades de ese organizador si cumples el resto de requisitos."
  ].join("\n");
  const html = `
    <p>Se ha levantado el bloqueo por ambito para tus solicitudes.</p>
    <p><strong>Organizador:</strong> ${escapeHtml(adminNombre)}</p>
    <p>Desde este momento puedes volver a solicitar actividades de ese organizador si cumples el resto de requisitos.</p>
  `;
  return { asunto, texto, html };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    if (String(session.rol || "").toUpperCase() !== "ADMIN") {
      return json({ ok: false, error: "Solo ADMIN" }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const usuarioId = Number(body.usuario_id || 0);
    const bloqueado = body.bloqueado === true || body.bloqueado === 1 || body.bloqueado === "1";
    const motivo = limpiarTexto(body.motivo || "");

    if (!(usuarioId > 0)) {
      return json({ ok: false, error: "Usuario público no válido." }, 400);
    }

    const usuario = await obtenerUsuarioPublico(env, usuarioId);
    if (!usuario) {
      return json({ ok: false, error: "Usuario público no válido." }, 400);
    }

    const row = await actualizarBloqueoUsuarioPublicoPorAdmin(env, {
      adminUsuarioId: Number(session.usuario_id || 0),
      usuarioPublicoId: usuarioId,
      activo: bloqueado ? 1 : 0,
      motivo,
      actorUsuarioId: Number(session.usuario_id || 0)
    });

    const resumen = {
      reservas_rechazadas: 0,
      correo_enviado: 0,
      notificacion_creada: 0
    };
    const adminNombre = limpiarTexto(session.username || "Administrador");

    if (bloqueado) {
      const reservasAfectadas = await obtenerReservasAfectadasAmbito(env, session.usuario_id, usuario.id);
      for (const reserva of reservasAfectadas) {
        const estadoOrigen = limpiarTexto(reserva.estado).toUpperCase();
        const update = await env.DB.prepare(`
          UPDATE reservas
          SET estado = 'RECHAZADA',
              observaciones_admin = ?,
              fecha_modificacion = datetime('now')
          WHERE id = ?
            AND UPPER(TRIM(COALESCE(estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
        `).bind(motivo, Number(reserva.id || 0)).run();
        if (Number(update?.meta?.changes || 0) > 0) {
          resumen.reservas_rechazadas += 1;
          await registrarEventoReserva(env, {
            reservaId: Number(reserva.id || 0),
            accion: "BLOQUEO_SOLICITANTE_AMBITO_ADMIN",
            estadoOrigen,
            estadoDestino: "RECHAZADA",
            observaciones: motivo,
            actorUsuarioId: Number(session.usuario_id || 0),
            actorRol: "ADMIN",
            actorNombre: adminNombre
          });
        }
      }

      const correo = construirCorreoBloqueoAmbito(adminNombre, motivo, reservasAfectadas);
      const envio = await enviarEmail(env, {
        to: limpiarTexto(usuario.email).toLowerCase(),
        subject: correo.asunto,
        text: correo.texto,
        html: correo.html
      });
      if (envio?.ok) resumen.correo_enviado = 1;

      const notificacion = await crearNotificacion(env, {
        usuarioId: Number(usuario.id || 0),
        rolDestino: "SOLICITANTE",
        tipo: "RESERVA",
        titulo: "Solicitudes bloqueadas por organizador",
        mensaje: `Se han bloqueado tus solicitudes para actividades de ${adminNombre}.`,
        urlDestino: "/portal.html"
      });
      if (notificacion?.ok) resumen.notificacion_creada = 1;
    } else {
      const correo = construirCorreoDesbloqueoAmbito(adminNombre);
      const envio = await enviarEmail(env, {
        to: limpiarTexto(usuario.email).toLowerCase(),
        subject: correo.asunto,
        text: correo.texto,
        html: correo.html
      });
      if (envio?.ok) resumen.correo_enviado = 1;

      const notificacion = await crearNotificacion(env, {
        usuarioId: Number(usuario.id || 0),
        rolDestino: "SOLICITANTE",
        tipo: "RESERVA",
        titulo: "Solicitudes desbloqueadas por organizador",
        mensaje: `Se ha levantado el bloqueo de solicitudes para actividades de ${adminNombre}.`,
        urlDestino: "/portal.html"
      });
      if (notificacion?.ok) resumen.notificacion_creada = 1;
    }

    return json({
      ok: true,
      mensaje: bloqueado
        ? "Usuario público bloqueado para tus actividades."
        : "Usuario público desbloqueado para tus actividades.",
      bloqueo: row || null,
      fecha_estado_texto: formatearFechaTexto(row?.updated_at || ""),
      resumen
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Error actualizando el bloqueo por ámbito.",
      detalle: error.message
    }, 500);
  }
}
