import { crearNotificacion } from "./_notificaciones.js";
import { registrarEventoReserva } from "./_reservas_historial.js";
import { getUserSession } from "./usuario/_auth.js";
import { asegurarColumnaAforoMaximo, obtenerBloqueoActividadSinFranja } from "./_actividades_aforo.js";
import { enviarEmail } from "./_email.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim().replace(/\s+/g, " ");
}

function normalizarCentroComparacion(valor) {
  return limpiarTexto(valor).toUpperCase();
}

function esEmailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function calcularMinutosConsolidacion(plazasReservadas) {
  const plazas = Number(plazasReservadas || 0);
  return 20 + (plazas * 3);
}

async function obtenerFechaExpiracionSQLite(env, minutos) {
  const row = await env.DB.prepare(`
    SELECT datetime('now', '+' || ? || ' minutes') AS expira
  `).bind(minutos).first();

  return row?.expira || null;
}

function accionNormalizada(valor) {
  return limpiarTexto(valor).toLowerCase();
}

async function asegurarTablaRequisitos(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS actividad_requisitos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actividad_id INTEGER NOT NULL,
      texto TEXT NOT NULL,
      orden INTEGER NOT NULL DEFAULT 0
    )
  `).run();
}

async function obtenerRequisitosActividad(env, actividadId) {
  const id = Number(actividadId || 0);
  if (!(id > 0)) return [];
  await asegurarTablaRequisitos(env);
  const result = await env.DB.prepare(`
    SELECT texto
    FROM actividad_requisitos
    WHERE actividad_id = ?
    ORDER BY orden ASC, id ASC
  `).bind(id).all();

  return (result.results || [])
    .map((row) => limpiarTexto(row?.texto || ""))
    .filter(Boolean);
}

async function obtenerActividad(env, actividadId) {
  const actividad = await env.DB.prepare(`
    SELECT
      a.id,
      a.admin_id,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      a.activa,
      a.requiere_reserva,
      a.usa_franjas,
      a.aforo_limitado,
      COALESCE(a.aforo_maximo, 0) AS aforo_maximo,
      COALESCE(a.lugar, '') AS lugar,
      COALESCE(a.direccion_postal, '') AS direccion_postal,
      COALESCE(a.latitud, '') AS latitud,
      COALESCE(a.longitud, '') AS longitud,
      u.email AS admin_email,
      u.nombre AS admin_nombre,
      u.nombre_publico AS admin_nombre_publico,
      u.localidad AS admin_localidad
    FROM actividades a
    LEFT JOIN usuarios u
      ON u.id = a.admin_id
    WHERE a.id = ?
    LIMIT 1
  `).bind(actividadId).first();

  if (!actividad) return null;
  return {
    ...actividad,
    requisitos_particulares: await obtenerRequisitosActividad(env, actividad.id)
  };
}

async function crearNotificacionNuevaSolicitudAdmin(env, {
  adminId,
  actividadId,
  actividadNombre,
  centro,
  codigoReserva
} = {}) {
  const idAdmin = Number(adminId || 0);
  if (!(idAdmin > 0)) return { ok: false, skipped: true, error: "Administrador no vÃ¡lido." };

  return await crearNotificacion(env, {
    usuarioId: idAdmin,
    rolDestino: "ADMIN",
    tipo: "RESERVA",
    titulo: "Nueva solicitud de actividad",
    mensaje: `${centro || "Un centro"} ha solicitado ${actividadNombre || "una actividad"}${codigoReserva ? ` (${codigoReserva})` : ""}.`,
    urlDestino: actividadId ? `/admin-reservas.html?actividad_id=${encodeURIComponent(String(actividadId))}` : "/admin-reservas.html"
  });
}

function construirDescripcionProgramacion(contexto = {}) {
  const fecha = limpiarTexto(contexto?.fecha || "");
  const horaInicio = limpiarTexto(contexto?.hora_inicio || "");
  const horaFin = limpiarTexto(contexto?.hora_fin || "");
  if (fecha && horaInicio && horaFin) {
    return `${fecha} · ${horaInicio} - ${horaFin}`;
  }
  if (fecha) return fecha;
  return "";
}

function construirUrlGoogleMaps(contexto = {}) {
  const latitud = limpiarTexto(contexto?.latitud || "");
  const longitud = limpiarTexto(contexto?.longitud || "");
  if (latitud && longitud) {
    return `https://www.google.com/maps?q=${encodeURIComponent(`${latitud},${longitud}`)}`;
  }
  const direccion = limpiarTexto(contexto?.direccion_postal || "");
  const lugar = limpiarTexto(contexto?.lugar || "");
  const destino = direccion || lugar;
  if (!destino) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destino)}`;
}

function construirTextoContextualSolicitudAdmin(contexto = {}) {
  const usaFranjas = Number(contexto?.usa_franjas || 0) === 1;
  const aforoLimitado = Number(contexto?.aforo_limitado || 0) === 1;
  const aforoMaximo = Number(contexto?.aforo_maximo || 0);
  const programacion = construirDescripcionProgramacion(contexto);

  const lineas = [];
  if (usaFranjas && programacion) {
    lineas.push(`La solicitud se ha registrado para la franja ${programacion}.`);
  }
  if (aforoLimitado && aforoMaximo > 0) {
    lineas.push(`El aforo de esta actividad está limitado a ${aforoMaximo} plazas.`);
    lineas.push("Si fuese necesario ampliar asistentes más adelante, podrán seguir asignándose sobre esta misma solicitud mientras continúe existiendo disponibilidad.");
  } else if (!aforoLimitado) {
    lineas.push("La actividad no tiene aforo limitado.");
  }
  lineas.push("Revise la solicitud y continúe su tramitación desde el panel de reservas.");
  return lineas;
}

function construirLineasInformacionAdicionalSolicitudAdmin(contexto = {}) {
  const usaFranjas = Number(contexto?.usa_franjas || 0) === 1;
  const aforoLimitado = Number(contexto?.aforo_limitado || 0) === 1;
  const aforoMaximo = Number(contexto?.aforo_maximo || 0);
  const programacion = construirDescripcionProgramacion(contexto);

  const lineas = [];
  if (usaFranjas && programacion) {
    lineas.push(`La solicitud se ha registrado para la franja ${programacion}.`);
  }
  if (aforoLimitado && aforoMaximo > 0) {
    lineas.push(`El aforo de esta actividad está limitado a ${aforoMaximo} plazas.`);
    lineas.push("Si fuese necesario ampliar asistentes más adelante, podrán seguir asignándose sobre esta misma solicitud mientras continúe existiendo disponibilidad.");
  } else if (!aforoLimitado) {
    lineas.push("La actividad no tiene aforo limitado.");
  }
  lineas.push("Revise la solicitud y continúe su tramitación desde el panel de reservas.");
  return lineas;
}

function construirCorreoNuevaSolicitudAdmin(contexto = {}, modo = "nueva") {
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const centro = limpiarTexto(contexto?.centro || "un centro");
  const contacto = limpiarTexto(contexto?.contacto || "");
  const correoContacto = limpiarTexto(contexto?.email || "");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const plazas = Number(contexto?.plazas_prereservadas || 0);
  const observaciones = limpiarTexto(contexto?.observaciones || "");
  const programacion = construirDescripcionProgramacion(contexto);
  const asunto = modo === "reenviada"
    ? `${actividad} · Solicitud reenviada para revisión`
    : `${actividad} · Nueva solicitud de actividad`;
  const mensaje = modo === "reenviada"
    ? "Se ha reenviado una solicitud de actividad para nueva revisión."
    : "Se ha registrado una nueva solicitud de actividad.";
  const urlMaps = construirUrlGoogleMaps(contexto);
  const lugar = limpiarTexto(contexto?.lugar || "");
  const direccion = limpiarTexto(contexto?.direccion_postal || "");
  const ubicacion = direccion || lugar;
  const lineasContextuales = construirLineasInformacionAdicionalSolicitudAdmin(contexto);
  const bloqueDatosTexto = [
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Centro solicitante: ${centro}`,
    contacto ? `Contacto: ${contacto}` : "",
    correoContacto ? `Correo de contacto: ${correoContacto}` : "",
    plazas > 0 ? `Plazas solicitadas: ${plazas}` : "",
    programacion ? `Programación: ${programacion}` : "",
    modo === "reenviada" ? "Situación: Solicitud reenviada para revisión" : ""
  ].filter(Boolean);

  const texto = [
    mensaje,
    "",
    `ACTIVIDAD: ${actividad}`,
    "",
    "RESUMEN DE LA SOLICITUD",
    ...bloqueDatosTexto.map((linea) => `- ${linea}`),
    "",
    observaciones ? "OBSERVACIONES DEL SOLICITANTE" : "",
    observaciones ? observaciones : "",
    observaciones ? "" : "",
    urlMaps ? "LOCALIZACIÓN" : "",
    urlMaps ? `- Google Maps: ${urlMaps}` : "",
    urlMaps ? "" : "",
    "INFORMACIÓN ADICIONAL",
    ...lineasContextuales.map((linea) => `- ${linea}`)
  ].filter(Boolean).join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;color:#22313f;line-height:1.45;">
      <div style="background:#eef4ff;border:1px solid #c9dcff;border-radius:12px;padding:14px 16px;margin-bottom:14px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#1d4f91;margin-bottom:6px;">${modo === "reenviada" ? "Solicitud reenviada" : "Nueva solicitud"}</div>
        <div style="font-size:22px;font-weight:700;color:#123a63;line-height:1.2;margin-bottom:6px;">${escaparHtml(actividad)}</div>
        <div style="font-size:15px;font-weight:600;color:#355679;">${escaparHtml(mensaje)}</div>
      </div>
      <div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#ffffff;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#516274;margin-bottom:10px;">Resumen de la solicitud</div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tbody>
            ${codigo ? `<tr><td style="padding:6px 0;color:#5a6a7a;font-weight:700;">Código de solicitud</td><td style="padding:6px 0;color:#22313f;">${escaparHtml(codigo)}</td></tr>` : ""}
            <tr><td style="padding:6px 0;color:#5a6a7a;font-weight:700;">Centro solicitante</td><td style="padding:6px 0;color:#22313f;">${escaparHtml(centro)}</td></tr>
            ${contacto ? `<tr><td style="padding:6px 0;color:#5a6a7a;font-weight:700;">Contacto</td><td style="padding:6px 0;color:#22313f;">${escaparHtml(contacto)}</td></tr>` : ""}
            ${correoContacto ? `<tr><td style="padding:6px 0;color:#5a6a7a;font-weight:700;">Correo de contacto</td><td style="padding:6px 0;color:#22313f;">${escaparHtml(correoContacto)}</td></tr>` : ""}
            ${plazas > 0 ? `<tr><td style="padding:6px 0;color:#5a6a7a;font-weight:700;">Plazas solicitadas</td><td style="padding:6px 0;color:#22313f;">${escaparHtml(plazas)}</td></tr>` : ""}
            ${programacion ? `<tr><td style="padding:6px 0;color:#5a6a7a;font-weight:700;">Programación</td><td style="padding:6px 0;color:#22313f;">${escaparHtml(programacion)}</td></tr>` : ""}
            ${modo === "reenviada" ? `<tr><td style="padding:6px 0;color:#5a6a7a;font-weight:700;">Situación</td><td style="padding:6px 0;color:#22313f;">Solicitud reenviada para revisión</td></tr>` : ""}
          </tbody>
        </table>
      </div>
      ${observaciones ? `
        <div style="border:1px solid #f1d58b;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#fff8e6;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#8a5b00;margin-bottom:8px;">Observaciones del solicitante</div>
          <div style="font-size:14px;color:#5a4630;white-space:pre-wrap;">${escaparHtml(observaciones)}</div>
        </div>
      ` : ""}
      ${urlMaps ? `
        <div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#ffffff;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#516274;margin-bottom:8px;">Localización</div>
          <a href="${escaparHtml(urlMaps)}" style="color:#0b5ed7;text-decoration:none;font-weight:700;">Abrir ubicación en Google Maps</a>
        </div>
      ` : ""}
      <div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;background:#f8fafc;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#516274;margin-bottom:8px;">Información adicional</div>
        <ul style="margin:0;padding-left:18px;color:#22313f;">
          ${lineasContextuales.map((linea) => `<li style="margin:0 0 6px 0;">${escaparHtml(linea)}</li>`).join("")}
        </ul>
      </div>
    </div>
  `;

  const bloqueDatosCompletosTexto = [
    ...bloqueDatosTexto,
    ubicacion ? `Ubicación: ${ubicacion}` : "",
    urlMaps ? `Google Maps: ${urlMaps}` : ""
  ].filter(Boolean);
  const textoFinal = [
    mensaje,
    "",
    `ACTIVIDAD: ${actividad}`,
    "",
    "RESUMEN DE LA SOLICITUD",
    ...bloqueDatosCompletosTexto.map((linea) => `- ${linea}`),
    "",
    observaciones ? "OBSERVACIONES DEL SOLICITANTE" : "",
    observaciones ? observaciones : "",
    observaciones ? "" : "",
    "INFORMACIÓN ADICIONAL",
    ...lineasContextuales.map((linea) => `- ${linea}`)
  ].filter(Boolean).join("\n");

  const htmlFinal = `
    <div style="font-family:Arial,sans-serif;color:#22313f;line-height:1.45;">
      <div style="background:#eef4ff;border:1px solid #c9dcff;border-radius:12px;padding:14px 16px;margin-bottom:14px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#1d4f91;margin-bottom:6px;">${modo === "reenviada" ? "Solicitud reenviada" : "Nueva solicitud"}</div>
        <div style="font-size:22px;font-weight:700;color:#123a63;line-height:1.2;margin-bottom:6px;">${escaparHtml(actividad)}</div>
        <div style="font-size:15px;font-weight:600;color:#355679;">${escaparHtml(mensaje)}</div>
      </div>
      <div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#ffffff;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#516274;margin-bottom:10px;">Resumen de la solicitud</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:auto;">
          <tbody>
            ${codigo ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:112px;">Codigo</td><td style="padding:4px 0;color:#22313f;">${escaparHtml(codigo)}</td></tr>` : ""}
            <tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:112px;">Centro</td><td style="padding:4px 0;color:#22313f;">${escaparHtml(centro)}</td></tr>
            ${contacto ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:112px;">Contacto</td><td style="padding:4px 0;color:#22313f;">${escaparHtml(contacto)}</td></tr>` : ""}
            ${correoContacto ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:112px;">Correo</td><td style="padding:4px 0;color:#22313f;">${escaparHtml(correoContacto)}</td></tr>` : ""}
            ${plazas > 0 ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:112px;">Plazas</td><td style="padding:4px 0;color:#22313f;">${escaparHtml(plazas)}</td></tr>` : ""}
            ${programacion ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:112px;">Fecha y hora</td><td style="padding:4px 0;color:#22313f;">${escaparHtml(programacion)}</td></tr>` : ""}
            ${ubicacion ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:112px;">Ubicacion</td><td style="padding:4px 0;color:#22313f;">${escaparHtml(ubicacion)}</td></tr>` : ""}
            ${urlMaps ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:112px;">Mapa</td><td style="padding:4px 0;color:#22313f;"><a href="${escaparHtml(urlMaps)}" style="color:#0b5ed7;text-decoration:none;font-weight:700;">Abrir ubicacion</a></td></tr>` : ""}
            ${modo === "reenviada" ? `<tr><td style="padding:4px 8px 4px 0;color:#5a6a7a;font-weight:700;white-space:nowrap;width:112px;">Situacion</td><td style="padding:4px 0;color:#22313f;">Solicitud reenviada para revision</td></tr>` : ""}
          </tbody>
        </table>
      </div>
      ${observaciones ? `
        <div style="border:1px solid #f1d58b;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#fff8e6;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#8a5b00;margin-bottom:8px;">Observaciones del solicitante</div>
          <div style="font-size:14px;color:#5a4630;white-space:pre-wrap;">${escaparHtml(observaciones)}</div>
        </div>
      ` : ""}
      <div style="border:1px solid #dde4ea;border-radius:12px;padding:14px 16px;background:#f8fafc;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#516274;margin-bottom:8px;">Información adicional</div>
        <ul style="margin:0;padding-left:18px;color:#22313f;">
          ${lineasContextuales.map((linea) => `<li style="margin:0 0 6px 0;">${escaparHtml(linea)}</li>`).join("")}
        </ul>
      </div>
    </div>
  `;

  return { asunto, texto: textoFinal, html: htmlFinal };
}

async function enviarCorreoNuevaSolicitudAdmin(env, contexto = {}, modo = "nueva") {
  const destinatario = limpiarTexto(contexto?.admin_email || "");
  if (!destinatario) {
    return { ok: false, skipped: true, error: "El administrador no tiene correo de contacto." };
  }

  const correo = construirCorreoNuevaSolicitudAdmin(contexto, modo);
  return await enviarEmail(env, {
    to: destinatario,
    subject: correo.asunto,
    text: correo.texto,
    html: correo.html
  });
}

async function obtenerReservaPorToken(env, tokenEdicion) {
  const sql = `
    SELECT
      r.id,
      r.actividad_id,
      r.franja_id,
      r.centro,
      r.contacto,
      r.telefono,
      r.email,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      r.observaciones,
      r.estado,
      r.codigo_reserva,
      r.usuario_id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin
    FROM reservas r
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.token_edicion = ?
    LIMIT 1
  `;

  return await env.DB.prepare(sql).bind(tokenEdicion).first();
}

async function contarAsistentes(env, reservaId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM visitantes
    WHERE reserva_id = ?
  `).bind(reservaId).first();

  return Number(row?.total || 0);
}

async function obtenerFranja(env, franjaId) {
  return await env.DB.prepare(`
    SELECT
      id,
      actividad_id,
      fecha,
      hora_inicio,
      hora_fin,
      capacidad
    FROM franjas
    WHERE id = ?
    LIMIT 1
  `).bind(franjaId).first();
}

async function obtenerDisponibilidadFranja(env, franjaId) {
  const sql = `
    SELECT
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      COALESCE(SUM(
        CASE
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN
            CASE
              WHEN r.prereserva_expira_en IS NOT NULL
                   AND datetime('now') <= datetime(r.prereserva_expira_en)
                THEN COALESCE(r.plazas_prereservadas, 0)
              ELSE (
                SELECT COUNT(*)
                FROM visitantes v
                WHERE v.reserva_id = r.id
              )
            END
          ELSE 0
        END
      ), 0) AS ocupadas,
      (
        f.capacidad - COALESCE(SUM(
          CASE
            WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN
              CASE
                WHEN r.prereserva_expira_en IS NOT NULL
                     AND datetime('now') <= datetime(r.prereserva_expira_en)
                  THEN COALESCE(r.plazas_prereservadas, 0)
                ELSE (
                  SELECT COUNT(*)
                  FROM visitantes v
                  WHERE v.reserva_id = r.id
                )
              END
            ELSE 0
          END
        ), 0)
      ) AS disponibles
    FROM franjas f
    LEFT JOIN reservas r
      ON r.franja_id = f.id
    WHERE f.id = ?
    GROUP BY
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad
    LIMIT 1
  `;

  return await env.DB.prepare(sql).bind(franjaId).first();
}

function franjaTieneCapacidadLimitada(actividad, franja) {
  return Number(actividad?.aforo_limitado || 0) === 1 && franja?.capacidad != null;
}

async function existeSolicitudActivaMismoCentroFranjaExcluyendo(env, franjaId, centroComparacion, reservaIdExcluir) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado
    FROM reservas r
    WHERE r.franja_id = ?
      AND UPPER(TRIM(r.centro)) = ?
      AND r.id <> ?
      AND (
        r.estado = 'CONFIRMADA'
        OR (
          r.estado = 'PENDIENTE'
          AND (
            (
              r.prereserva_expira_en IS NOT NULL
              AND datetime('now') <= datetime(r.prereserva_expira_en)
            )
            OR EXISTS (
              SELECT 1
              FROM visitantes v
              WHERE v.reserva_id = r.id
              LIMIT 1
            )
          )
        )
      )
    LIMIT 1
  `;

  return await env.DB.prepare(sql)
    .bind(franjaId, centroComparacion, reservaIdExcluir)
    .first();
}

async function existeSolicitudActivaMismoCentroActividadSinFranjaExcluyendo(env, actividadId, centroComparacion, reservaIdExcluir) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado
    FROM reservas r
    WHERE r.actividad_id = ?
      AND r.franja_id IS NULL
      AND UPPER(TRIM(r.centro)) = ?
      AND r.id <> ?
      AND (
        r.estado = 'CONFIRMADA'
        OR (
          r.estado = 'PENDIENTE'
          AND (
            (
              r.prereserva_expira_en IS NOT NULL
              AND datetime('now') <= datetime(r.prereserva_expira_en)
            )
            OR EXISTS (
              SELECT 1
              FROM visitantes v
              WHERE v.reserva_id = r.id
              LIMIT 1
            )
          )
        )
      )
    LIMIT 1
  `;

  return await env.DB.prepare(sql)
    .bind(actividadId, centroComparacion, reservaIdExcluir)
    .first();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    await asegurarColumnaAforoMaximo(env);
    const user = await getUserSession(request, env.SECRET_KEY);
    if (!user?.id) {
      return json(
        { ok: false, authenticated: false, error: "Debes iniciar sesión para modificar esta solicitud." },
        { status: 401 }
      );
    }

    const data = await request.json();

    const tokenEdicion = limpiarTexto(data.token_edicion);
    const centro = limpiarTexto(data.centro);
    const contacto = limpiarTexto(data.contacto);
    const telefono = limpiarTexto(data.telefono);
    const email = limpiarTexto(data.email);
    const observaciones = limpiarTexto(data.observaciones);
    const accion = accionNormalizada(data.accion);
    const franjaRaw = data.franja;
    const franjaIdNueva = franjaRaw == null || String(franjaRaw).trim() === ""
      ? null
      : parseInt(franjaRaw, 10);
    const plazasSolicitadas = parseInt(
      data.plazas_reservadas ?? data.plazas_solicitadas,
      10
    );

    if (!tokenEdicion) {
      return json({ ok: false, error: "Falta el token de ediciÃ³n." }, { status: 400 });
    }

    if (!centro || !contacto || !telefono || !email) {
      return json({ ok: false, error: "Faltan datos obligatorios del solicitante." }, { status: 400 });
    }

    if (!esEmailValido(email)) {
      return json({ ok: false, error: "El correo electrÃ³nico no tiene un formato vÃ¡lido." }, { status: 400 });
    }

    if (!Number.isInteger(plazasSolicitadas) || plazasSolicitadas <= 0) {
      return json({ ok: false, error: "Debe indicar un nÃºmero vÃ¡lido de plazas reservadas." }, { status: 400 });
    }

    const reservaActual = await obtenerReservaPorToken(env, tokenEdicion);

    if (!reservaActual) {
      return json({ ok: false, error: "No existe ninguna reserva con ese token." }, { status: 404 });
    }

    if (Number(reservaActual.usuario_id || 0) !== Number(user.id || 0)) {
      return json({ ok: false, error: "Solo el solicitante originador puede modificar esta solicitud." }, { status: 403 });
    }

    const actividad = await obtenerActividad(env, reservaActual.actividad_id);
    if (!actividad || Number(actividad.requiere_reserva || 0) !== 1) {
      return json({ ok: false, error: "La actividad asociada ya no admite reservas." }, { status: 400 });
    }

    const usaFranjas = Number(actividad.usa_franjas || 0) === 1;
    const estadoActual = String(reservaActual.estado || "").toUpperCase();
    const esBorrador = estadoActual === "BORRADOR";
    const esRechazada = estadoActual === "RECHAZADA";
    const reenviarRechazada = esRechazada && accion !== "guardar_borrador";
    const guardarBorrador = (esBorrador || esRechazada) && (accion === "" || accion === "guardar_borrador");
    const enviarBorrador = esBorrador && accion === "enviar_borrador";

    if (Number(actividad.activa || 0) !== 1 && !guardarBorrador) {
      return json({ ok: false, error: "La actividad asociada estÃ¡ desactivada y no admite el envÃ­o de la solicitud." }, { status: 400 });
    }

    if (usaFranjas && (!Number.isInteger(franjaIdNueva) || franjaIdNueva <= 0)) {
      return json({ ok: false, error: "La franja horaria indicada no es vÃ¡lida." }, { status: 400 });
    }

    if (!usaFranjas && franjaIdNueva !== null) {
      return json({ ok: false, error: "Esta actividad no utiliza franjas horarias." }, { status: 400 });
    }

    if (!esBorrador && !esRechazada) {
      return json({ ok: false, error: "La solicitud no puede modificarse en su estado actual." }, { status: 400 });
    }

    const asistentesCargados = await contarAsistentes(env, reservaActual.id);
    const totalReenvioRechazada = Math.max(asistentesCargados, plazasSolicitadas);
    const centroComparacion = normalizarCentroComparacion(centro);

    let franjaNueva = null;
    let disponibilidadActual = null;
    let disponiblesSinFranja = null;
    if (usaFranjas) {
      franjaNueva = await obtenerFranja(env, franjaIdNueva);
      if (!franjaNueva) {
        return json({ ok: false, error: "La franja seleccionada no existe." }, { status: 404 });
      }

      if (Number(franjaNueva.actividad_id || 0) !== Number(reservaActual.actividad_id || 0)) {
        return json({ ok: false, error: "La franja seleccionada no pertenece a la actividad indicada." }, { status: 400 });
      }

      if (franjaTieneCapacidadLimitada(actividad, franjaNueva)) {
        disponibilidadActual = await obtenerDisponibilidadFranja(env, franjaIdNueva);
        if (!disponibilidadActual) {
          return json({ ok: false, error: "No se pudo calcular la disponibilidad actual de la franja." }, { status: 400 });
        }
      }
    } else if (Number(actividad.aforo_limitado || 0) === 1) {
      disponiblesSinFranja = Math.max(
        Number(actividad.aforo_maximo || 0) - await obtenerBloqueoActividadSinFranja(env, reservaActual.actividad_id, reservaActual.id),
        0
      );
    }

    const necesitaControlDuplicada = !guardarBorrador;
    if (necesitaControlDuplicada) {
      const duplicada = usaFranjas
        ? await existeSolicitudActivaMismoCentroFranjaExcluyendo(
          env,
          franjaIdNueva,
          centroComparacion,
          reservaActual.id
        )
        : await existeSolicitudActivaMismoCentroActividadSinFranjaExcluyendo(
          env,
          reservaActual.actividad_id,
          centroComparacion,
          reservaActual.id
        );

      if (duplicada) {
        return json(
          {
            ok: false,
            error: usaFranjas
              ? "Ya existe una solicitud activa para este centro en la franja seleccionada. Debe modificar la existente, no crear una segunda."
              : "Ya existe una solicitud activa para este centro en esta actividad. Debe modificar la existente, no crear una segunda."
          },
          { status: 409 }
        );
      }
    }

    if (usaFranjas && franjaTieneCapacidadLimitada(actividad, franjaNueva)) {
      let disponiblesEditables = Number(disponibilidadActual?.disponibles || 0);

      if (!esBorrador && Number(franjaIdNueva) === Number(reservaActual.franja_id)) {
        const prereservaVigente =
          !!reservaActual.prereserva_expira_en &&
          new Date(String(reservaActual.prereserva_expira_en).replace(" ", "T")) >= new Date();
        const bloqueoActualReserva = prereservaVigente
          ? Number(reservaActual.plazas_prereservadas || 0)
          : asistentesCargados;
        disponiblesEditables += bloqueoActualReserva;
      }

      const totalSolicitado = esBorrador
        ? plazasSolicitadas
        : esRechazada
          ? totalReenvioRechazada
          : asistentesCargados + plazasSolicitadas;

      if (totalSolicitado > disponiblesEditables) {
        return json(
          {
            ok: false,
            error: `No hay plazas suficientes en la franja seleccionada. Disponibles para esta operaciÃ³n: ${disponiblesEditables}. Solicitadas: ${totalSolicitado}.`
          },
          { status: 400 }
        );
      }
    } else if (Number(actividad.aforo_limitado || 0) === 1) {
      const disponiblesEditables = disponiblesSinFranja + (
        (!esBorrador && !esRechazada)
          ? Number(reservaActual.plazas_prereservadas || 0)
          : 0
      );
      const totalSolicitado = esBorrador
        ? plazasSolicitadas
        : esRechazada
          ? totalReenvioRechazada
          : asistentesCargados + plazasSolicitadas;
      if (totalSolicitado > disponiblesEditables) {
        return json(
          {
            ok: false,
            error: `No hay plazas suficientes en la actividad. Disponibles para esta operación: ${disponiblesEditables}. Solicitadas: ${totalSolicitado}.`
          },
          { status: 400 }
        );
      }
    }

    if (guardarBorrador) {
      const updateResult = await env.DB.prepare(`
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          personas = ?,
          plazas_prereservadas = ?,
          prereserva_expira_en = NULL,
          observaciones = ?,
          observaciones_admin = NULL,
          estado = 'BORRADOR',
          fecha_modificacion = datetime('now')
        WHERE id = ?
          AND UPPER(TRIM(COALESCE(estado, ''))) IN ('BORRADOR', 'RECHAZADA')
      `).bind(
        franjaIdNueva,
        centro,
        contacto,
        telefono,
        email,
        plazasSolicitadas,
        plazasSolicitadas,
        observaciones,
        reservaActual.id
      ).run();

      if ((updateResult?.meta?.changes || 0) === 0) {
        return json({ ok: false, error: "No se pudo guardar el borrador." }, { status: 500 });
      }

      return json({
        ok: true,
        estado: "BORRADOR",
        mensaje: "Borrador guardado correctamente.",
        franja: franjaNueva ? {
          id: franjaNueva.id,
          fecha: franjaNueva.fecha,
          hora_inicio: franjaNueva.hora_inicio,
          hora_fin: franjaNueva.hora_fin
        } : null
      });
    }

    if (enviarBorrador) {
      const minutosConsolidacion = calcularMinutosConsolidacion(plazasSolicitadas);
      const prereservaExpiraEn = await obtenerFechaExpiracionSQLite(env, minutosConsolidacion);
      if (!prereservaExpiraEn) {
        return json({ ok: false, error: "No se pudo calcular la expiraciÃ³n de la prereserva." }, { status: 500 });
      }

      const updateResult = await env.DB.prepare(`
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          personas = ?,
          plazas_prereservadas = ?,
          prereserva_expira_en = ?,
          observaciones = ?,
          observaciones_admin = NULL,
          estado = 'PENDIENTE',
          fecha_solicitud = datetime('now'),
          fecha_modificacion = datetime('now')
        WHERE id = ?
          AND UPPER(TRIM(COALESCE(estado, ''))) = 'BORRADOR'
      `).bind(
        franjaIdNueva,
        centro,
        contacto,
        telefono,
        email,
        plazasSolicitadas,
        plazasSolicitadas,
        prereservaExpiraEn,
        observaciones,
        reservaActual.id
      ).run();

      if ((updateResult?.meta?.changes || 0) === 0) {
        return json({ ok: false, error: "No se pudo enviar el borrador." }, { status: 500 });
      }

      await registrarEventoReserva(env, {
        reservaId: reservaActual.id,
        accion: "SOLICITUD_PRESENTADA",
        estadoOrigen: "BORRADOR",
        estadoDestino: "PENDIENTE",
        observaciones,
        actorUsuarioId: reservaActual.usuario_id,
        actorRol: "SOLICITANTE",
        actorNombre: contacto || centro || "Solicitante"
      });

      let notificacionAdmin = { ok: false, skipped: true, error: "" };
      let correoAdmin = { ok: false, skipped: true, error: "" };
      try {
        notificacionAdmin = await crearNotificacionNuevaSolicitudAdmin(env, {
          adminId: actividad.admin_id,
          actividadId: reservaActual.actividad_id,
          actividadNombre: actividad.actividad_nombre || "Actividad",
          centro,
          codigoReserva: reservaActual.codigo_reserva
        });
        correoAdmin = await enviarCorreoNuevaSolicitudAdmin(env, {
          ...actividad,
          ...reservaActual,
          centro,
          contacto,
          email,
          fecha: franjaNueva?.fecha || "",
          hora_inicio: franjaNueva?.hora_inicio || "",
          hora_fin: franjaNueva?.hora_fin || "",
          plazas_prereservadas: plazasSolicitadas
        }, "nueva");
        if (!correoAdmin.ok && !correoAdmin.skipped) {
          console.error("No se pudo enviar el correo al administrador tras enviar un borrador.", {
            reserva_id: Number(reservaActual?.id || 0),
            actividad_id: Number(reservaActual?.actividad_id || 0),
            admin_id: Number(actividad?.admin_id || 0),
            email_admin: actividad?.admin_email || "",
            error: correoAdmin.error || ""
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

      return json({
        ok: true,
        estado: "PENDIENTE",
        mensaje: "Solicitud enviada correctamente.",
        codigo_reserva: reservaActual.codigo_reserva,
        token_edicion: tokenEdicion,
        minutos_consolidacion: minutosConsolidacion,
        prereserva_expira_en: prereservaExpiraEn,
        notificacion_admin: {
          creada: !!notificacionAdmin.ok,
          error: notificacionAdmin.ok ? "" : (notificacionAdmin.error || "")
        },
        correo_admin: {
          enviado: !!correoAdmin.ok,
          error: correoAdmin.ok ? "" : (correoAdmin.error || "")
        }
      });
    }

    const totalBloqueadoNuevo = reenviarRechazada
      ? totalReenvioRechazada
      : asistentesCargados + plazasSolicitadas;

    if (reenviarRechazada) {
      const minutosConsolidacion = calcularMinutosConsolidacion(totalBloqueadoNuevo);
      const prereservaExpiraEn = totalBloqueadoNuevo > 0
        ? await obtenerFechaExpiracionSQLite(env, minutosConsolidacion)
        : null;

      if (totalBloqueadoNuevo > 0 && !prereservaExpiraEn) {
        return json({ ok: false, error: "No se pudo calcular la expiración de la prereserva." }, { status: 500 });
      }

      const updateResult = await env.DB.prepare(`
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          personas = ?,
          plazas_prereservadas = ?,
          prereserva_expira_en = ?,
          observaciones = ?,
          observaciones_admin = NULL,
          estado = 'PENDIENTE',
          fecha_solicitud = datetime('now'),
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `).bind(
        franjaIdNueva,
        centro,
        contacto,
        telefono,
        email,
        totalBloqueadoNuevo,
        totalBloqueadoNuevo,
        prereservaExpiraEn,
        observaciones,
        reservaActual.id
      ).run();

      if ((updateResult?.meta?.changes || 0) === 0) {
        return json({ ok: false, error: "No se pudo reenviar la solicitud." }, { status: 500 });
      }

      await registrarEventoReserva(env, {
        reservaId: reservaActual.id,
        accion: "SOLICITUD_REENVIADA",
        estadoOrigen: "RECHAZADA",
        estadoDestino: "PENDIENTE",
        observaciones,
        actorUsuarioId: reservaActual.usuario_id,
        actorRol: "SOLICITANTE",
        actorNombre: contacto || centro || "Solicitante"
      });

      let notificacionAdmin = { ok: false, skipped: true, error: "" };
      let correoAdmin = { ok: false, skipped: true, error: "" };
      try {
        notificacionAdmin = await crearNotificacionNuevaSolicitudAdmin(env, {
          adminId: actividad.admin_id,
          actividadId: reservaActual.actividad_id,
          actividadNombre: actividad.actividad_nombre || "Actividad",
          centro,
          codigoReserva: reservaActual.codigo_reserva
        });
        correoAdmin = await enviarCorreoNuevaSolicitudAdmin(env, {
          ...actividad,
          ...reservaActual,
          centro,
          contacto,
          email,
          fecha: franjaNueva?.fecha || "",
          hora_inicio: franjaNueva?.hora_inicio || "",
          hora_fin: franjaNueva?.hora_fin || "",
          plazas_prereservadas: totalBloqueadoNuevo
        }, "reenviada");
        if (!correoAdmin.ok && !correoAdmin.skipped) {
          console.error("No se pudo enviar el correo al administrador tras reenviar una solicitud rechazada.", {
            reserva_id: Number(reservaActual?.id || 0),
            actividad_id: Number(reservaActual?.actividad_id || 0),
            admin_id: Number(actividad?.admin_id || 0),
            email_admin: actividad?.admin_email || "",
            error: correoAdmin.error || ""
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

      const franjaFinal = usaFranjas && franjaIdNueva && franjaTieneCapacidadLimitada(actividad, franjaNueva)
        ? await obtenerDisponibilidadFranja(env, franjaIdNueva)
        : null;

      return json({
        ok: true,
        estado: "PENDIENTE",
        mensaje: "Solicitud reenviada correctamente y pendiente de nueva validación.",
        codigo_reserva: reservaActual.codigo_reserva,
        token_edicion: tokenEdicion,
        minutos_consolidacion: minutosConsolidacion,
        prereserva_expira_en: prereservaExpiraEn,
        plazas_asignadas: asistentesCargados,
        plazas_reservadas: plazasSolicitadas,
        plazas_bloqueadas_total: totalBloqueadoNuevo,
        franja: franjaFinal ? {
          id: franjaFinal.id,
          fecha: franjaFinal.fecha,
          hora_inicio: franjaFinal.hora_inicio,
          hora_fin: franjaFinal.hora_fin
        } : null,
        disponibles_despues: franjaFinal ? Number(franjaFinal.disponibles || 0) : null,
        notificacion_admin: {
          creada: !!notificacionAdmin.ok,
          error: notificacionAdmin.ok ? "" : (notificacionAdmin.error || "")
        },
        correo_admin: {
          enviado: !!correoAdmin.ok,
          error: correoAdmin.ok ? "" : (correoAdmin.error || "")
        }
      });
    }

    let sqlUpdate;
    let bindValues;

    if (plazasSolicitadas > 0) {
      sqlUpdate = `
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          personas = ?,
          plazas_prereservadas = ?,
          prereserva_expira_en = datetime('now', '+2 hours'),
          observaciones = ?,
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `;

      bindValues = [
        franjaIdNueva,
        centro,
        contacto,
        telefono,
        email,
        totalBloqueadoNuevo,
        totalBloqueadoNuevo,
        observaciones,
        reservaActual.id
      ];
    } else {
      sqlUpdate = `
        UPDATE reservas
        SET
          franja_id = ?,
          centro = ?,
          contacto = ?,
          telefono = ?,
          email = ?,
          personas = ?,
          plazas_prereservadas = ?,
          observaciones = ?,
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `;

      bindValues = [
        franjaIdNueva,
        centro,
        contacto,
        telefono,
        email,
        totalBloqueadoNuevo,
        totalBloqueadoNuevo,
        observaciones,
        reservaActual.id
      ];
    }

    const updateResult = await env.DB.prepare(sqlUpdate).bind(...bindValues).run();

    if ((updateResult?.meta?.changes || 0) === 0) {
      return json({ ok: false, error: "No se pudo actualizar la solicitud." }, { status: 500 });
    }

    const franjaFinal = usaFranjas && franjaIdNueva && franjaTieneCapacidadLimitada(actividad, franjaNueva)
      ? await obtenerDisponibilidadFranja(env, franjaIdNueva)
      : null;

    return json({
      ok: true,
      mensaje: "Solicitud actualizada correctamente.",
      plazas_asignadas: asistentesCargados,
      plazas_reservadas: plazasSolicitadas,
      plazas_bloqueadas_total: totalBloqueadoNuevo,
      franja: franjaFinal ? {
        id: franjaFinal.id,
        fecha: franjaFinal.fecha,
        hora_inicio: franjaFinal.hora_inicio,
        hora_fin: franjaFinal.hora_fin
      } : null,
      disponibles_despues: franjaFinal ? Number(franjaFinal.disponibles || 0) : null
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error interno al actualizar la solicitud.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}


