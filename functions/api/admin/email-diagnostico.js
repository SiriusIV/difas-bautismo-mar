import { getAdminSession } from "./_auth.js";
import { enviarEmail, esEmailConfigurable } from "../_email.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function esEmailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function ocultarApiKey(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return "";
  if (texto.length <= 8) return `${texto.slice(0, 2)}***`;
  return `${texto.slice(0, 4)}***${texto.slice(-4)}`;
}

function construirDiagnosticoConfig(env) {
  return {
    email_configurado: esEmailConfigurable(env),
    resend_api_key_presente: !!limpiarTexto(env?.RESEND_API_KEY),
    resend_api_key_mascara: ocultarApiKey(env?.RESEND_API_KEY),
    email_from_presente: !!limpiarTexto(env?.EMAIL_FROM),
    email_from: limpiarTexto(env?.EMAIL_FROM)
  };
}

function mascarEmail(email) {
  const texto = limpiarTexto(email).toLowerCase();
  if (!texto || !texto.includes("@")) return "";
  const [local, dominio] = texto.split("@");
  if (!local || !dominio) return texto;
  const visible = local.length <= 2
    ? `${local.charAt(0)}*`
    : `${local.slice(0, 2)}***${local.slice(-1)}`;
  return `${visible}@${dominio}`;
}

async function obtenerDestinoActividad(env, actividadId) {
  const id = Number(actividadId || 0);
  if (!(id > 0)) return null;
  const row = await env.DB.prepare(`
    SELECT
      a.id,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      a.admin_id,
      COALESCE(NULLIF(TRIM(u.email), ''), '') AS admin_email,
      COALESCE(NULLIF(TRIM(u.nombre_publico), ''), NULLIF(TRIM(u.nombre), ''), 'Administrador') AS admin_nombre
    FROM actividades a
    LEFT JOIN usuarios u
      ON u.id = a.admin_id
    WHERE a.id = ?
    LIMIT 1
  `).bind(id).first();

  if (!row) return null;

  return {
    actividad_id: Number(row.id || 0),
    actividad_nombre: limpiarTexto(row.actividad_nombre || "Actividad"),
    admin_id: Number(row.admin_id || 0),
    admin_nombre: limpiarTexto(row.admin_nombre || "Administrador"),
    destinatario_resuelto: limpiarTexto(row.admin_email || ""),
    destinatario_mascara: mascarEmail(row.admin_email || "")
  };
}

async function obtenerDestinoReserva(env, reservaId) {
  const id = Number(reservaId || 0);
  if (!(id > 0)) return null;
  const row = await env.DB.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.actividad_id,
      r.codigo_reserva,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      COALESCE(NULLIF(TRIM(r.email), ''), '') AS email_reserva,
      COALESCE(NULLIF(TRIM(u.email), ''), '') AS email_usuario,
      COALESCE(NULLIF(TRIM(r.email), ''), NULLIF(TRIM(u.email), ''), '') AS email_resuelto,
      COALESCE(NULLIF(TRIM(r.contacto), ''), NULLIF(TRIM(u.nombre), ''), 'Solicitante') AS contacto_nombre
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios u
      ON u.id = r.usuario_id
    WHERE r.id = ?
    LIMIT 1
  `).bind(id).first();

  if (!row) return null;

  return {
    reserva_id: Number(row.id || 0),
    actividad_id: Number(row.actividad_id || 0),
    actividad_nombre: limpiarTexto(row.actividad_nombre || "Actividad"),
    usuario_id: Number(row.usuario_id || 0),
    codigo_reserva: limpiarTexto(row.codigo_reserva || ""),
    contacto_nombre: limpiarTexto(row.contacto_nombre || "Solicitante"),
    email_reserva: limpiarTexto(row.email_reserva || ""),
    email_usuario: limpiarTexto(row.email_usuario || ""),
    destinatario_resuelto: limpiarTexto(row.email_resuelto || ""),
    destinatario_mascara: mascarEmail(row.email_resuelto || "")
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const url = new URL(request.url);
    const actividadId = Number(url.searchParams.get("actividad_id") || 0);
    const reservaId = Number(url.searchParams.get("reserva_id") || 0);

    const [destinoActividad, destinoReserva] = await Promise.all([
      actividadId > 0 ? obtenerDestinoActividad(env, actividadId) : Promise.resolve(null),
      reservaId > 0 ? obtenerDestinoReserva(env, reservaId) : Promise.resolve(null)
    ]);

    return json({
      ok: true,
      diagnostico: construirDiagnosticoConfig(env),
      destinos: {
        actividad: destinoActividad,
        reserva: destinoReserva
      }
    });
  } catch (error) {
    return json(
      { ok: false, error: "No se pudo comprobar la configuración de correo.", detalle: error.message },
      500
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const destinatario = limpiarTexto(body?.to || "");
    const asunto = limpiarTexto(body?.subject || "") || "[Diagnóstico] Prueba de correo";

    if (!destinatario || !esEmailValido(destinatario)) {
      return json({ ok: false, error: "Debes indicar un destinatario válido." }, 400);
    }

    const resultado = await enviarEmail(env, {
      to: destinatario,
      subject: asunto,
      text: [
        "Este es un correo de diagnóstico del sistema.",
        "",
        `Administrador emisor: ${session.email || session.usuario_id || "desconocido"}`,
        `Fecha UTC: ${new Date().toISOString()}`,
        "",
        "Si estás leyendo este mensaje, la capa de envío ha aceptado la entrega."
      ].join("\n"),
      html: `
        <p>Este es un correo de diagnóstico del sistema.</p>
        <p><strong>Administrador emisor:</strong> ${limpiarTexto(session.email || session.usuario_id || "desconocido")}</p>
        <p><strong>Fecha UTC:</strong> ${new Date().toISOString()}</p>
        <p>Si estás leyendo este mensaje, la capa de envío ha aceptado la entrega.</p>
      `
    });

    return json({
      ok: true,
      diagnostico: construirDiagnosticoConfig(env),
      envio: {
        enviado: !!resultado.ok,
        omitido: !!resultado.skipped,
        error: resultado.ok ? "" : (resultado.error || ""),
        provider: resultado.provider || "",
        provider_id: resultado.id || "",
        provider_response: resultado.response || null
      }
    });
  } catch (error) {
    return json(
      { ok: false, error: "No se pudo ejecutar el diagnóstico de correo.", detalle: error.message },
      500
    );
  }
}
