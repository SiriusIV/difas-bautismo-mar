function valorActivado(valor) {
  return ["1", "true", "yes", "on"].includes(String(valor || "").trim().toLowerCase());
}

function obtenerIpsPermitidas(raw) {
  return new Set(
    String(raw || "")
      .split(/[\s,;]+/g)
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function obtenerIpCliente(request) {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp && cfIp.trim()) return cfIp.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded && forwarded.trim()) {
    const primera = forwarded.split(",")[0]?.trim();
    if (primera) return primera;
  }

  return "";
}

function respuestaBloqueo(ipActual) {
  const detalleIp = ipActual ? `IP detectada: ${ipActual}` : "IP no detectada.";
  return new Response(
    `Acceso temporalmente restringido.\n${detalleIp}\nContacta con el administrador del sitio.`,
    {
      status: 403,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}

export async function onRequest(context) {
  const { request, env, next } = context;

  const bloqueoActivo = valorActivado(env?.LOCKDOWN_ENABLED);
  if (!bloqueoActivo) {
    return next();
  }

  const ipsPermitidas = obtenerIpsPermitidas(env?.LOCKDOWN_ALLOWED_IPS);
  const ipCliente = obtenerIpCliente(request);

  if (!ipCliente || !ipsPermitidas.has(ipCliente)) {
    return respuestaBloqueo(ipCliente);
  }

  return next();
}

