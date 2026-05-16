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

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    return json({
      ok: true,
      diagnostico: construirDiagnosticoConfig(env)
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
