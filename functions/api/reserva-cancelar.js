import { getUserSession } from "./usuario/_auth.js";
import { crearNotificacion } from "./_notificaciones.js";
import { enviarEmail, nombreVisibleAdmin } from "./_email.js";

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function construirCorreoCancelacionSolicitante(contexto = {}) {
  const adminNombre = nombreVisibleAdmin({
    nombre_publico: contexto?.admin_nombre_publico,
    nombre: contexto?.admin_nombre,
    localidad: contexto?.admin_localidad
  });
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const centro = limpiarTexto(contexto?.centro || "un centro");
  const contacto = limpiarTexto(contexto?.contacto || "");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const fecha = limpiarTexto(contexto?.fecha || "");
  const inicio = limpiarTexto(contexto?.hora_inicio || "");
  const fin = limpiarTexto(contexto?.hora_fin || "");
  const horario = fecha && inicio && fin ? `${fecha} · ${inicio} - ${fin}` : "";
  const asunto = "[Reservas] Solicitud anulada por el solicitante";
  const mensaje = `${centro} ha anulado su solicitud para ${actividad}${codigo ? ` (${codigo})` : ""}.`;

  const texto = [
    `Hola ${adminNombre},`,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Centro solicitante: ${centro}`,
    contacto ? `Persona de contacto: ${contacto}` : "",
    horario ? `Franja: ${horario}` : "",
    "",
    "Puedes revisar el estado actualizado desde tu panel de reservas."
  ].filter(Boolean).join("\n");

  const html = `
    <p>Hola ${escaparHtml(adminNombre)},</p>
    <p>${escaparHtml(mensaje)}</p>
    <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
    ${codigo ? `<p><strong>Código de solicitud:</strong> ${escaparHtml(codigo)}</p>` : ""}
    <p><strong>Centro solicitante:</strong> ${escaparHtml(centro)}</p>
    ${contacto ? `<p><strong>Persona de contacto:</strong> ${escaparHtml(contacto)}</p>` : ""}
    ${horario ? `<p><strong>Franja:</strong> ${escaparHtml(horario)}</p>` : ""}
    <p>Puedes revisar el estado actualizado desde tu panel de reservas.</p>
  `;

  return { asunto, texto, html };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();
    const tokenEdicion = String(data.token_edicion || "").trim();
    const reservaId = Number(data.reserva_id || 0);
    const user = await getUserSession(request, env.SECRET_KEY);

    if (!user || !user.id) {
      return Response.json(
        { ok: false, error: "No autorizado." },
        { status: 401 }
      );
    }

    if (!tokenEdicion && !(reservaId > 0)) {
      return Response.json(
        { ok: false, error: "Falta el identificador de la solicitud." },
        { status: 400 }
      );
    }

    const session = env.DB.withSession("first-primary");

    let reserva = null;
    if (tokenEdicion) {
      reserva = await session
        .prepare(`
          SELECT
            r.id,
            r.usuario_id,
            r.franja_id,
            r.codigo_reserva,
            r.token_edicion,
            r.estado,
            r.actividad_id,
            r.centro,
            r.contacto,
            f.fecha,
            f.hora_inicio,
            f.hora_fin,
            f.capacidad,
            COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
            a.admin_id,
            u.email AS admin_email,
            u.nombre AS admin_nombre,
            u.nombre_publico AS admin_nombre_publico,
            u.localidad AS admin_localidad
          FROM reservas r
          LEFT JOIN franjas f
            ON r.franja_id = f.id
          LEFT JOIN actividades a
            ON r.actividad_id = a.id
          LEFT JOIN usuarios u
            ON a.admin_id = u.id
          WHERE r.token_edicion = ?
          LIMIT 1
        `)
        .bind(tokenEdicion)
        .first();
    } else {
      reserva = await session
        .prepare(`
          SELECT
            r.id,
            r.usuario_id,
            r.franja_id,
            r.codigo_reserva,
            r.token_edicion,
            r.estado,
            r.actividad_id,
            r.centro,
            r.contacto,
            f.fecha,
            f.hora_inicio,
            f.hora_fin,
            f.capacidad,
            COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
            a.admin_id,
            u.email AS admin_email,
            u.nombre AS admin_nombre,
            u.nombre_publico AS admin_nombre_publico,
            u.localidad AS admin_localidad
          FROM reservas r
          LEFT JOIN franjas f
            ON r.franja_id = f.id
          LEFT JOIN actividades a
            ON r.actividad_id = a.id
          LEFT JOIN usuarios u
            ON a.admin_id = u.id
          WHERE r.id = ?
            AND r.usuario_id = ?
          LIMIT 1
        `)
        .bind(reservaId, user.id)
        .first();
    }

    if (!reserva) {
      return Response.json(
        { ok: false, error: "No existe ninguna solicitud anulable con ese identificador." },
        { status: 404 }
      );
    }

    if (Number(reserva.usuario_id || 0) !== Number(user.id || 0)) {
      return Response.json(
        { ok: false, error: "La solicitud no corresponde al usuario autenticado." },
        { status: 403 }
      );
    }

    let notificacionAdmin = { ok: false, skipped: true, error: "" };
    let correoAdmin = { ok: false, skipped: true, error: "" };
    const adminId = Number(reserva.admin_id || 0);
    const adminEmail = limpiarTexto(reserva.admin_email || "");
    try {
      if (adminId > 0) {
        notificacionAdmin = await crearNotificacion(env, {
          usuarioId: adminId,
          rolDestino: "ADMIN",
          tipo: "RESERVA",
          titulo: "Solicitud anulada por el solicitante",
          mensaje: `${limpiarTexto(reserva.centro || "Un centro")} ha anulado ${limpiarTexto(reserva.actividad_nombre || "una actividad")}${limpiarTexto(reserva.codigo_reserva) ? ` (${limpiarTexto(reserva.codigo_reserva)})` : ""}.`,
          urlDestino: Number(reserva.actividad_id || 0) > 0
            ? `/admin-reservas.html?actividad_id=${encodeURIComponent(String(reserva.actividad_id))}`
            : "/admin-reservas.html"
        });
      }
      if (adminEmail) {
        const correo = construirCorreoCancelacionSolicitante(reserva);
        correoAdmin = await enviarEmail(env, {
          to: adminEmail,
          subject: correo.asunto,
          text: correo.texto,
          html: correo.html
        });
      }
    } catch (errorNotificacion) {
      notificacionAdmin = {
        ok: false,
        skipped: true,
        error: errorNotificacion?.message || String(errorNotificacion || "")
      };
      correoAdmin = {
        ok: false,
        skipped: true,
        error: errorNotificacion?.message || String(errorNotificacion || "")
      };
    }

    await session
      .prepare(`
        DELETE FROM visitantes
        WHERE reserva_id = ?
      `)
      .bind(reserva.id)
      .run();

    const deleteResult = await session
      .prepare(`
        DELETE FROM reservas
        WHERE id = ?
      `)
      .bind(reserva.id)
      .run();

    if ((deleteResult?.meta?.changes || 0) === 0) {
      return Response.json(
        { ok: false, error: "No se pudo anular la solicitud." },
        { status: 500 }
      );
    }

    let estadoFinal = null;
    if (Number(reserva.franja_id || 0) > 0) {
      estadoFinal = await session
        .prepare(`
          SELECT
            f.id,
            f.fecha,
            f.hora_inicio,
            f.hora_fin,
            f.capacidad,
            COALESCE(SUM(
              CASE
                WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN r.personas
                ELSE 0
              END
            ), 0) AS ocupadas,
            (
              f.capacidad - COALESCE(SUM(
                CASE
                  WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN r.personas
                  ELSE 0
                END
              ), 0)
            ) AS disponibles
          FROM franjas f
          LEFT JOIN reservas r
            ON f.id = r.franja_id
          WHERE f.id = ?
          GROUP BY f.id, f.fecha, f.hora_inicio, f.hora_fin, f.capacidad
        `)
        .bind(reserva.franja_id)
        .first();
    }

    return Response.json({
      ok: true,
      mensaje: "Solicitud anulada correctamente.",
      codigo_reserva: reserva.codigo_reserva,
      token_edicion: reserva.token_edicion,
      estado: "ANULADA",
      notificacion_admin: {
        creada: !!notificacionAdmin.ok,
        error: notificacionAdmin.ok ? "" : (notificacionAdmin.error || "")
      },
      correo_admin: {
        enviado: !!correoAdmin.ok,
        error: correoAdmin.ok ? "" : (correoAdmin.error || "")
      },
      franja: estadoFinal ? {
        id: estadoFinal.id,
        fecha: estadoFinal.fecha,
        hora_inicio: estadoFinal.hora_inicio,
        hora_fin: estadoFinal.hora_fin
      } : null,
      capacidad: estadoFinal?.capacidad ?? null,
      ocupadas: estadoFinal?.ocupadas ?? 0,
      disponibles_despues: estadoFinal?.disponibles ?? null
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Error interno al anular la solicitud.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
