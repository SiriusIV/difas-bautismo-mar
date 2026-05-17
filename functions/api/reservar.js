import { getUserSession } from "./usuario/_auth.js";
import { asegurarColumnaAforoMaximo, obtenerBloqueoActividadSinFranja } from "./_actividades_aforo.js";
import { ejecutarMantenimientoReservas } from "./_reservas_mantenimiento.js";
import { crearNotificacion } from "./_notificaciones.js";
import { enviarEmail } from "./_email.js";
import { registrarEventoReserva } from "./_reservas_historial.js";

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

function generarCodigoReserva() {
  const ahora = new Date();
  const yyyy = ahora.getFullYear();
  const mm = String(ahora.getMonth() + 1).padStart(2, "0");
  const dd = String(ahora.getDate()).padStart(2, "0");
  const hh = String(ahora.getHours()).padStart(2, "0");
  const mi = String(ahora.getMinutes()).padStart(2, "0");
  const ss = String(ahora.getSeconds()).padStart(2, "0");
  const aleatorio = Math.floor(Math.random() * 9000) + 1000;
  return `R-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${aleatorio}`;
}

function generarToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function calcularMinutosConsolidacion(plazasReservadas) {
  const plazas = Number(plazasReservadas || 0);
  return 20 + (plazas * 3);
}

function accionEsGuardarBorrador(valor) {
  return limpiarTexto(valor).toLowerCase() === "guardar_borrador";
}

async function obtenerFechaExpiracionSQLite(env, minutos) {
  const row = await env.DB.prepare(`
    SELECT datetime('now', '+' || ? || ' minutes') AS expira
  `).bind(minutos).first();

  return row?.expira || null;
}


async function obtenerActividad(env, actividadId) {
  return await env.DB.prepare(`
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
}

async function crearNotificacionNuevaSolicitudAdmin(env, {
  adminId,
  actividadId,
  actividadNombre,
  centro,
  codigoReserva
} = {}) {
  const idAdmin = Number(adminId || 0);
  if (!(idAdmin > 0)) return { ok: false, skipped: true, error: "Administrador no válido." };

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
  const lugar = limpiarTexto(contexto?.lugar || "");
  const direccion = limpiarTexto(contexto?.direccion_postal || "");
  const urlMaps = construirUrlGoogleMaps(contexto);

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
  if (direccion) {
    lineas.push(`Dirección de referencia: ${direccion}.`);
  } else if (lugar) {
    lineas.push(`Lugar de referencia: ${lugar}.`);
  }
  if (urlMaps) {
    lineas.push(`Localización en Google Maps: ${urlMaps}`);
  }

  lineas.push("Revise la solicitud y continúe su tramitación desde el panel de reservas.");
  return lineas;
}

function construirCorreoNuevaSolicitudAdmin(contexto = {}) {
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const centro = limpiarTexto(contexto?.centro || "un centro");
  const contacto = limpiarTexto(contexto?.contacto || "");
  const correoContacto = limpiarTexto(contexto?.email || "");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const plazas = Number(contexto?.plazas_prereservadas || 0);
  const observaciones = limpiarTexto(contexto?.observaciones || "");
  const programacion = construirDescripcionProgramacion(contexto);
  const urlMaps = construirUrlGoogleMaps(contexto);
  const lineasContextuales = construirTextoContextualSolicitudAdmin(contexto);
  const asunto = `${actividad} · Nueva solicitud de actividad`;
  const mensaje = "Se ha registrado una nueva solicitud de actividad.";
  const bloqueDatosTexto = [
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Centro solicitante: ${centro}`,
    contacto ? `Contacto: ${contacto}` : "",
    correoContacto ? `Correo de contacto: ${correoContacto}` : "",
    plazas > 0 ? `Plazas solicitadas: ${plazas}` : "",
    programacion ? `Programación: ${programacion}` : ""
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
        <div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#1d4f91;margin-bottom:6px;">Nueva solicitud</div>
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

  return { asunto, texto, html };
}

async function enviarCorreoNuevaSolicitudAdmin(env, contexto = {}) {
  const destinatario = limpiarTexto(contexto?.admin_email || "");
  if (!destinatario) {
    return { ok: false, skipped: true, error: "El administrador no tiene correo de contacto." };
  }

  const correo = construirCorreoNuevaSolicitudAdmin(contexto);
  return await enviarEmail(env, {
    to: destinatario,
    subject: correo.asunto,
    text: correo.texto,
    html: correo.html
  });
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

async function obtenerBloqueoActualFranja(env, franjaId) {
  const sql = `
    SELECT
      COALESCE(SUM(
        CASE
          WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN
            CASE
              WHEN r.prereserva_expira_en IS NOT NULL
                   AND datetime('now') <= datetime(r.prereserva_expira_en)
                THEN MAX(
                  COALESCE(r.plazas_prereservadas, 0),
                  COALESCE((
                    SELECT COUNT(*)
                    FROM visitantes v
                    WHERE v.reserva_id = r.id
                  ), 0)
                )
              ELSE COALESCE((
                SELECT COUNT(*)
                FROM visitantes v
                WHERE v.reserva_id = r.id
              ), 0)
            END
          ELSE 0
        END
      ), 0) AS ocupadas
    FROM reservas r
    WHERE r.franja_id = ?
  `;

  const row = await env.DB.prepare(sql).bind(franjaId).first();
  return Number(row?.ocupadas || 0);
}

async function existeSolicitudActivaMismoCentroFranja(env, franjaId, centroComparacion) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado
    FROM reservas r
    WHERE r.franja_id = ?
      AND UPPER(TRIM(r.centro)) = ?
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
    .bind(franjaId, centroComparacion)
    .first();
}

function franjaTieneCapacidadLimitada(actividad, franja) {
  return Number(actividad?.aforo_limitado || 0) === 1 && franja?.capacidad != null;
}

async function existeSolicitudActivaMismoCentroActividadSinFranja(env, actividadId, centroComparacion) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado
    FROM reservas r
    WHERE r.actividad_id = ?
      AND r.franja_id IS NULL
      AND UPPER(TRIM(r.centro)) = ?
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
    .bind(actividadId, centroComparacion)
    .first();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    await asegurarColumnaAforoMaximo(env);
    await ejecutarMantenimientoReservas(env);
    const sessionUser = await getUserSession(request, env.SECRET_KEY);
    const usuarioId = sessionUser?.id || null;

    const data = await request.json();

    const actividadId = parseInt(data.actividad_id, 10);
    const centro = limpiarTexto(data.centro);
    const contacto = limpiarTexto(data.contacto);
    const telefono = limpiarTexto(data.telefono);
    const email = limpiarTexto(data.email);
    const observaciones = limpiarTexto(data.observaciones);
    const guardarComoBorrador = accionEsGuardarBorrador(data.accion);
    const franjaRaw = data.franja;
    const franjaId = franjaRaw == null || String(franjaRaw).trim() === ""
      ? null
      : parseInt(franjaRaw, 10);
    const plazasReservadas = parseInt(data.plazas_solicitadas, 10);

    if (!Number.isInteger(actividadId) || actividadId <= 0) {   
      return json(
        { ok: false, error: "La actividad indicada no es válida." },
        { status: 400 }
      );
    }

const actividad = await obtenerActividad(env, actividadId);

if (!actividad) {
  return json(
    { ok: false, error: "La actividad indicada no existe." },
    { status: 404 }
  );
}

if (Number(actividad.requiere_reserva || 0) !== 1) {
  return json(
    { ok: false, error: "Esta actividad no admite reservas." },
    { status: 400 }
  );
}
if (Number(actividad.activa || 0) !== 1) {
  return json(
    { ok: false, error: "Esta actividad estÃ¡ desactivada y no admite nuevas solicitudes." },
    { status: 400 }
  );
}
    const usaFranjas = Number(actividad.usa_franjas || 0) === 1;

    if (!centro || !contacto || !telefono || !email) {
      return json(
        { ok: false, error: "Faltan datos obligatorios del solicitante." },
        { status: 400 }
      );
    }

    if (!esEmailValido(email)) {
      return json(
        { ok: false, error: "El correo electrónico no tiene un formato válido." },
        { status: 400 }
      );
    }

    if (usaFranjas && (!Number.isInteger(franjaId) || franjaId <= 0)) {
      return json(
        { ok: false, error: "La franja horaria indicada no es válida." },
        { status: 400 }
      );
    }

    if (!Number.isInteger(plazasReservadas) || plazasReservadas <= 0) {
      return json(
        { ok: false, error: "Debe indicar un número válido de plazas a reservar." },
        { status: 400 }
      );
    }

    const centroComparacion = normalizarCentroComparacion(centro);
    let franja = null;
    let duplicada = null;
    let capacidad = null;
    let disponibles = null;

    if (usaFranjas) {
      franja = await obtenerFranja(env, franjaId);

      if (!franja) {
        return json(
          { ok: false, error: "La franja seleccionada no existe." },
          { status: 404 }
        );
      }

      if (Number(franja.actividad_id || 0) !== actividadId) {
        return json(
          { ok: false, error: "La franja seleccionada no pertenece a la actividad indicada." },
          { status: 400 }
        );
      }

      duplicada = await existeSolicitudActivaMismoCentroFranja(env, franjaId, centroComparacion);
      if (franjaTieneCapacidadLimitada(actividad, franja)) {
        const ocupadas = await obtenerBloqueoActualFranja(env, franjaId);
        capacidad = Number(franja.capacidad || 0);
        disponibles = Math.max(capacidad - ocupadas, 0);
      }
    } else {
      duplicada = await existeSolicitudActivaMismoCentroActividadSinFranja(env, actividadId, centroComparacion);
      if (Number(actividad.aforo_limitado || 0) === 1) {
        capacidad = Number(actividad.aforo_maximo || 0);
        const ocupadas = await obtenerBloqueoActividadSinFranja(env, actividadId);
        disponibles = Math.max(capacidad - ocupadas, 0);
      }
    }

    if (!guardarComoBorrador && duplicada) {
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

    if (
      ((usaFranjas && disponibles !== null) || (!usaFranjas && Number(actividad.aforo_limitado || 0) === 1))
      && plazasReservadas > disponibles
    ) {
      return json(
        {
          ok: false,
          error: usaFranjas
            ? `No hay plazas suficientes en la franja seleccionada. Disponibles: ${disponibles}. Solicitadas: ${plazasReservadas}.`
            : `No hay plazas suficientes en la actividad. Disponibles: ${disponibles}. Solicitadas: ${plazasReservadas}.`
        },
        { status: 400 }
      );
    }

    const codigoReserva = generarCodigoReserva();
    const tokenEdicion = generarToken();
    const minutosConsolidacion = calcularMinutosConsolidacion(plazasReservadas);
    const prereservaExpiraEn = guardarComoBorrador
      ? null
      : await obtenerFechaExpiracionSQLite(env, minutosConsolidacion);

    if (!guardarComoBorrador && !prereservaExpiraEn) {
      return json(
        { ok: false, error: "No se pudo calcular la expiración de la prereserva." },
        { status: 500 }
      );
    }

    const sqlInsert = `
      INSERT INTO reservas (
        franja_id,
        actividad_id,
        codigo_reserva,
        token_edicion,
        estado,
        centro,
        contacto,
        telefono,
        email,
        observaciones,
        plazas_prereservadas,
        prereserva_expira_en,
        fecha_solicitud,
        fecha_modificacion,
        usuario_id
      )
      VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        datetime('now'),
        datetime('now'),
        ?
      )
    `;

    const result = await env.DB.prepare(sqlInsert)
      .bind(
        franjaId,
        actividadId,
        codigoReserva,
        tokenEdicion,
        guardarComoBorrador ? "BORRADOR" : "PENDIENTE",
        centro,
        contacto,
        telefono,
        email,
        observaciones,
        plazasReservadas,
        prereservaExpiraEn,
        usuarioId
      )
      .run();

    if ((result?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo crear la solicitud." },
        { status: 500 }
      );
    }

    const reservaCreada = await env.DB.prepare(`
      SELECT
        id,
        codigo_reserva,
        token_edicion,
        estado,
        franja_id,
        actividad_id,
        plazas_prereservadas,
        prereserva_expira_en,
        observaciones,
        usuario_id
      FROM reservas
      WHERE token_edicion = ?
      LIMIT 1
    `).bind(tokenEdicion).first();

    if (!guardarComoBorrador) {
      await registrarEventoReserva(env, {
        reservaId: reservaCreada?.id,
        accion: "SOLICITUD_PRESENTADA",
        estadoOrigen: null,
        estadoDestino: "PENDIENTE",
        observaciones,
        actorUsuarioId: usuarioId,
        actorRol: "SOLICITANTE",
        actorNombre: contacto || centro || "Solicitante"
      });
    }

    let notificacionAdmin = { ok: false, skipped: true, error: "" };
    let correoAdmin = { ok: false, skipped: true, error: "" };
    if (!guardarComoBorrador) {
      try {
        notificacionAdmin = await crearNotificacionNuevaSolicitudAdmin(env, {
          adminId: actividad.admin_id,
          actividadId,
          actividadNombre: actividad.actividad_nombre || "Actividad",
          centro,
          codigoReserva: reservaCreada?.codigo_reserva || codigoReserva
        });
        correoAdmin = await enviarCorreoNuevaSolicitudAdmin(env, {
          ...actividad,
          ...reservaCreada,
          centro,
          contacto,
          email,
          fecha: franja?.fecha || "",
          hora_inicio: franja?.hora_inicio || "",
          hora_fin: franja?.hora_fin || ""
        });
        if (!correoAdmin.ok && !correoAdmin.skipped) {
          console.error("No se pudo enviar el correo al administrador tras crear una nueva solicitud.", {
            reserva_id: Number(reservaCreada?.id || 0),
            actividad_id: Number(actividadId || 0),
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
    }

    return json({
      ok: true,
      mensaje: guardarComoBorrador ? "Borrador guardado correctamente." : "Solicitud creada correctamente.",
      codigo_reserva: reservaCreada.codigo_reserva,
      token_edicion: reservaCreada.token_edicion,
      estado: reservaCreada.estado,
      franja: franja ? {
        id: franja.id,
        actividad_id: franja.actividad_id,
        fecha: franja.fecha,
        hora_inicio: franja.hora_inicio,
        hora_fin: franja.hora_fin,
        capacidad
      } : null,
      plazas_reservadas: plazasReservadas,
      plazas_disponibles_restantes: disponibles === null ? null : Math.max(disponibles - plazasReservadas, 0),
      minutos_consolidacion: guardarComoBorrador ? 0 : minutosConsolidacion,
      prereserva_expira_en: reservaCreada.prereserva_expira_en,
      usuario_id: reservaCreada.usuario_id,
      notificacion_admin: {
        creada: !!notificacionAdmin.ok,
        error: notificacionAdmin.ok ? "" : (notificacionAdmin.error || "")
      },
      correo_admin: {
        enviado: !!correoAdmin.ok,
        error: correoAdmin.ok ? "" : (correoAdmin.error || "")
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error interno al crear la solicitud.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
