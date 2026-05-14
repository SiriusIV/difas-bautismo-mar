import { requireAdminSession, getAdminSession } from "./_auth.js";
import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";
import { checkAdminActividad } from "./_permisos.js";
import { crearNotificacion } from "../_notificaciones.js";
import { enviarEmail } from "../_email.js";
import { registrarEventoReserva } from "../_reservas_historial.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function normalizarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarFecha(valor) {
  return normalizarTexto(valor);
}

function normalizarHora(valor) {
  return normalizarTexto(valor);
}

function parsearCapacidad(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === "") return null;
  const n = parseInt(valor, 10);
  return Number.isInteger(n) ? n : NaN;
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsearFlag(valor, defecto = 0) {
  if (valor === true || valor === 1 || valor === "1") return 1;
  if (valor === false || valor === 0 || valor === "0") return 0;
  return defecto;
}

function haFinalizadoFranja(row, ahora = new Date()) {
  if (!row?.fecha || !row?.hora_fin) return false;
  const fechaHoraFin = new Date(`${row.fecha}T${row.hora_fin}`);
  if (Number.isNaN(fechaHoraFin.getTime())) return false;
  return fechaHoraFin.getTime() < ahora.getTime();
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function descripcionFranja(row = {}) {
  if (Number(row.es_recurrente || 0) === 1) {
    return `${normalizarTexto(row.patron_recurrencia)} · ${normalizarTexto(row.hora_inicio)}-${normalizarTexto(row.hora_fin)}`.trim();
  }
  return `${normalizarTexto(row.fecha)} · ${normalizarTexto(row.hora_inicio)}-${normalizarTexto(row.hora_fin)}`.trim();
}

function franjaHaCambiado(existente = {}, siguiente = {}) {
  return (
    normalizarTexto(existente.fecha) !== normalizarTexto(siguiente.fecha) ||
    normalizarTexto(existente.hora_inicio) !== normalizarTexto(siguiente.hora_inicio) ||
    normalizarTexto(existente.hora_fin) !== normalizarTexto(siguiente.hora_fin) ||
    String(Number(existente.capacidad ?? "")) !== String(Number(siguiente.capacidad ?? "")) ||
    Number(existente.es_recurrente || 0) !== Number(siguiente.es_recurrente || 0) ||
    normalizarTexto(existente.patron_recurrencia) !== normalizarTexto(siguiente.patron_recurrencia)
  );
}

async function obtenerReservasAfectadasFranja(env, franjaId) {
  const result = await env.DB.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.codigo_reserva,
      r.contacto,
      r.email,
      r.estado,
      COALESCE(a.organizador_publico, 'Organizador') AS organizador_nombre,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    WHERE r.franja_id = ?
      AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA', 'RECHAZADA')
    ORDER BY r.id ASC
  `).bind(franjaId).all();

  return result?.results || [];
}

async function aplicarCambiosYNotificarFranja(env, reservas = [], franjaAnterior = {}, franjaNueva = {}, actor = {}) {
  const resumen = {
    total: reservas.length,
    suspendidas: 0,
    notificaciones_creadas: 0,
    correos_enviados: 0,
    incidencias: []
  };

  for (const reserva of reservas) {
    try {
      const descripcionAnterior = descripcionFranja(franjaAnterior);
      const descripcionNueva = descripcionFranja(franjaNueva);
      const actividad = normalizarTexto(reserva.actividad_nombre || "la actividad");
      const codigo = normalizarTexto(reserva.codigo_reserva || "");
      const contacto = normalizarTexto(reserva.contacto || "");
      const organizador = normalizarTexto(reserva.organizador_nombre || "el organizador");
      const estadoActual = normalizarTexto(reserva.estado).toUpperCase();
      let mensajeFinal = "";
      const mensaje = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Revisa la nueva programación y confirma que sigue encajando con tu solicitud.`;

      mensajeFinal = mensaje;
      if (estadoActual === "PENDIENTE" || estadoActual === "CONFIRMADA") {
        const update = await env.DB.prepare(`
          UPDATE reservas
          SET estado = 'SUSPENDIDA',
              fecha_modificacion = datetime('now')
          WHERE id = ?
            AND UPPER(TRIM(COALESCE(estado, ''))) IN ('PENDIENTE', 'CONFIRMADA')
        `).bind(reserva.id).run();

        if ((update?.meta?.changes || 0) > 0) {
          resumen.suspendidas += 1;
          await registrarEventoReserva(env, {
            reservaId: reserva.id,
            accion: "CAMBIO_FRANJA",
            estadoOrigen: estadoActual,
            estadoDestino: "SUSPENDIDA",
            observaciones: `Programación modificada: ${descripcionAnterior} -> ${descripcionNueva}`,
            actorUsuarioId: actor.actorUsuarioId,
            actorRol: actor.actorRol,
            actorNombre: actor.actorNombre
          });
        }

        mensajeFinal = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Tu solicitud ha pasado a estado suspendida hasta que revises la nueva programación.`;
      } else if (estadoActual === "SUSPENDIDA") {
        await registrarEventoReserva(env, {
          reservaId: reserva.id,
          accion: "CAMBIO_FRANJA",
          estadoOrigen: "SUSPENDIDA",
          estadoDestino: "SUSPENDIDA",
          observaciones: `Programación modificada: ${descripcionAnterior} -> ${descripcionNueva}`,
          actorUsuarioId: actor.actorUsuarioId,
          actorRol: actor.actorRol,
          actorNombre: actor.actorNombre
        });
        mensajeFinal = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Tu solicitud continúa suspendida y debes revisar la nueva programación.`;
      } else if (estadoActual === "RECHAZADA") {
        await registrarEventoReserva(env, {
          reservaId: reserva.id,
          accion: "CAMBIO_FRANJA",
          estadoOrigen: "RECHAZADA",
          estadoDestino: "RECHAZADA",
          observaciones: `Programación modificada: ${descripcionAnterior} -> ${descripcionNueva}`,
          actorUsuarioId: actor.actorUsuarioId,
          actorRol: actor.actorRol,
          actorNombre: actor.actorNombre
        });
        mensajeFinal = `La franja horaria de tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido actualizada. Tu solicitud continúa rechazada, pero te avisamos para que conozcas el cambio.`;
      }

      const notificacion = await crearNotificacion(env, {
        usuarioId: Number(reserva.usuario_id || 0),
        rolDestino: "SOLICITANTE",
        tipo: "RESERVA",
        titulo: "Cambio en la franja horaria",
        mensaje: mensajeFinal,
        urlDestino: "/usuario-panel.html"
      });

      if (notificacion?.ok) {
        resumen.notificaciones_creadas += 1;
      }

      const destinatario = normalizarTexto(reserva.email || "");
      if (destinatario) {
        const saludo = contacto ? `Hola ${contacto},` : "Hola,";
        const text = [
          saludo,
          "",
          mensajeFinal,
          "",
          `Franja anterior: ${descripcionAnterior}`,
          `Franja actualizada: ${descripcionNueva}`,
          `Organiza: ${organizador}`,
          "",
          "Puedes revisar el cambio desde tu panel de usuario y decidir como proceder con tu solicitud."
        ].join("\n");

        const html = `
          <p>${escaparHtml(saludo)}</p>
          <p>${escaparHtml(mensajeFinal)}</p>
          <p><strong>Franja anterior:</strong> ${escaparHtml(descripcionAnterior)}</p>
          <p><strong>Franja actualizada:</strong> ${escaparHtml(descripcionNueva)}</p>
          <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
          <p>Puedes revisar el cambio desde tu panel de usuario y decidir como proceder con tu solicitud.</p>
        `;

        const correo = await enviarEmail(env, {
          to: destinatario,
          subject: "[Reservas] Cambio en la franja horaria de tu solicitud",
          text,
          html
        });

        if (correo?.ok) {
          resumen.correos_enviados += 1;
        } else if (!correo?.skipped) {
          resumen.incidencias.push(`Correo reserva ${reserva.id}: ${correo?.error || "error desconocido"}`);
        }
      }
    } catch (error) {
      resumen.incidencias.push(`Reserva ${reserva.id}: ${error?.message || String(error || "")}`);
    }
  }

  return resumen;
}

function validarDatosFranja({
  fecha,
  hora_inicio,
  hora_fin,
  capacidad,
  es_recurrente,
  patron_recurrencia,
  aforo_limitado
}) {
  if (!hora_inicio || !hora_fin) {
    return "Faltan las horas de la franja.";
  }

  if (!/^\d{2}:\d{2}$/.test(hora_inicio) || !/^\d{2}:\d{2}$/.test(hora_fin)) {
    return "Las horas deben tener formato HH:MM.";
  }

  if (hora_inicio >= hora_fin) {
    return "La hora de inicio debe ser anterior a la hora de fin.";
  }

  if (Number(es_recurrente) === 1) {
    if (!patron_recurrencia) {
      return "Debe indicar un patrón de recurrencia.";
    }
  } else {
    if (!fecha) {
      return "La fecha es obligatoria.";
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return "La fecha debe tener formato YYYY-MM-DD.";
    }
  }

  if (Number(aforo_limitado) === 1) {
    if (!(capacidad > 0)) {
      return "La capacidad debe ser un entero mayor que 0.";
    }
  }

  return null;
}

async function obtenerActividad(env, actividad_id) {
  return await env.DB.prepare(`
    SELECT
      id,
      nombre,
      tipo,
      fecha_inicio,
      fecha_fin,
      aforo_limitado,
      borrador_tecnico
    FROM actividades
    WHERE id = ?
    LIMIT 1
  `)
    .bind(actividad_id)
    .first();
}

function resolverAforoLimitadoActual(data, actividad) {
  return parsearFlag(data?.aforo_limitado, Number(actividad?.aforo_limitado || 0));
}

function validarFechaDentroDeActividad(actividad, fecha, es_recurrente) {
  if (!actividad) {
    return "La actividad indicada no existe.";
  }

  if (Number(es_recurrente) === 1) {
    return null;
  }

  if (Number(actividad.borrador_tecnico) === 1) {
    return null;
  }
  
  if (actividad.tipo === "PERMANENTE") {
    return null;
  }

  if (!actividad.fecha_inicio || !actividad.fecha_fin) {
    return "La actividad temporal no tiene definido correctamente su intervalo de fechas.";
  }

  if (fecha < actividad.fecha_inicio || fecha > actividad.fecha_fin) {
    return `La fecha de la franja debe estar dentro del intervalo de la actividad (${actividad.fecha_inicio} a ${actividad.fecha_fin}).`;
  }

  return null;
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

async function obtenerResumenFranjas(env, actividad_id) {
  const actividad = await obtenerActividad(env, actividad_id);
  const aforoLimitado = Number(actividad?.aforo_limitado || 0);

  const sql = `
    SELECT
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.actividad_id,
      f.es_recurrente,
      f.patron_recurrencia,
      COUNT(CASE WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN r.id END) AS numero_reservas,
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
    FROM franjas f
    LEFT JOIN reservas r
      ON f.id = r.franja_id
    WHERE f.actividad_id = ?
    GROUP BY
      f.id,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      f.capacidad,
      f.actividad_id,
      f.es_recurrente,
      f.patron_recurrencia
    ORDER BY
      CASE WHEN f.es_recurrente = 1 THEN 1 ELSE 0 END,
      f.fecha,
      f.patron_recurrencia,
      f.hora_inicio,
      f.hora_fin
  `;

  const result = await env.DB.prepare(sql).bind(actividad_id).all();
  const rows = result.results || [];

  let franjas = rows.map(row => {
    const capacidad = row.capacidad === null || row.capacidad === undefined ? null : Number(row.capacidad || 0);
    const ocupadas = aforoLimitado ? Number(row.ocupadas || 0) : 0;

    return {
      ...row,
      es_recurrente: Number(row.es_recurrente || 0),
      capacidad,
      ocupadas,
      disponibles: aforoLimitado && capacidad !== null ? Math.max(capacidad - ocupadas, 0) : null,
      numero_reservas: aforoLimitado ? Number(row.numero_reservas || 0) : 0
    };
  });

  const ahora = new Date();
  franjas = franjas.filter((franja) => !haFinalizadoFranja(franja, ahora));

  return franjas;
}

async function obtenerFranjaPorId(env, id) {
  return await env.DB.prepare(`
    SELECT
      id,
      actividad_id,
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
      es_recurrente,
      patron_recurrencia
    FROM franjas
    WHERE id = ?
    LIMIT 1
  `)
    .bind(id)
    .first();
}

export async function onRequestGet(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    await ejecutarMantenimientoReservas(env);
    const session = await getAdminSession(request, env);
    const url = new URL(request.url);
    const actividad_id = parsearIdPositivo(url.searchParams.get("actividad_id"));

    if (!actividad_id) {
      return json({ ok: false, error: "actividad_id es obligatorio." }, { status: 400 });
    }

    await checkAdminActividad(env, session.usuario_id, actividad_id);

    const franjas = await obtenerResumenFranjas(env, actividad_id);

    return json({
      ok: true,
      total: franjas.length,
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al obtener las franjas.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestPost(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    const data = await request.json();

    const actividad_id = parsearIdPositivo(data.actividad_id);
    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHora(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);
    const es_recurrente = parsearFlag(data.es_recurrente, 0);
    const patron_recurrencia = normalizarTexto(data.patron_recurrencia);

    if (!actividad_id) {
      return json({ ok: false, error: "actividad_id es obligatorio." }, { status: 400 });
    }

    await checkAdminActividad(env, session.usuario_id, actividad_id);

    const actividad = await obtenerActividad(env, actividad_id);

    if (!actividad) {
      return json({ ok: false, error: "Actividad no válida." }, { status: 400 });
    }
    
    const aforo_limitado = Number(actividad?.aforo_limitado || 0);

    const errorValidacion = validarDatosFranja({
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
      es_recurrente,
      patron_recurrencia,
      aforo_limitado
    });

    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, { status: 400 });
    }

    const errorFecha = validarFechaDentroDeActividad(actividad, fecha, es_recurrente);

    if (errorFecha) {
      return json({ ok: false, error: errorFecha }, { status: 400 });
    }

    let duplicada;

    if (es_recurrente === 1) {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND es_recurrente = 1
          AND patron_recurrencia = ?
          AND hora_inicio = ?
          AND hora_fin = ?
        LIMIT 1
      `)
        .bind(actividad_id, patron_recurrencia, hora_inicio, hora_fin)
        .first();
    } else {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND COALESCE(es_recurrente, 0) = 0
          AND fecha = ?
          AND hora_inicio = ?
          AND hora_fin = ?
        LIMIT 1
      `)
        .bind(actividad_id, fecha, hora_inicio, hora_fin)
        .first();
    }

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe una franja con esos datos para esta actividad."
        },
        { status: 409 }
      );
    }

    const insertResult = await env.DB.prepare(`
      INSERT INTO franjas (
        fecha,
        hora_inicio,
        hora_fin,
        capacidad,
        actividad_id,
        es_recurrente,
        patron_recurrencia
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        es_recurrente === 1 ? null : fecha,
        hora_inicio,
        hora_fin,
        aforo_limitado === 1 ? capacidad : null,
        actividad_id,
        es_recurrente,
        es_recurrente === 1 ? patron_recurrencia : null
      )
      .run();

    if ((insertResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo crear la franja." },
        { status: 500 }
      );
    }

    const franjas = await obtenerResumenFranjas(env, actividad_id);

    return json({
      ok: true,
      mensaje: "Franja creada correctamente.",
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al crear la franja.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestPut(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    const data = await request.json();

    const id = parsearIdPositivo(data.id);
    const fecha = normalizarFecha(data.fecha);
    const hora_inicio = normalizarHora(data.hora_inicio);
    const hora_fin = normalizarHora(data.hora_fin);
    const capacidad = parsearCapacidad(data.capacidad);
    const es_recurrente = parsearFlag(data.es_recurrente, 0);
    const patron_recurrencia = normalizarTexto(data.patron_recurrencia);
    const confirmarAfectacion = data.confirmar_afectacion === true || data.confirmar_afectacion === 1 || data.confirmar_afectacion === "1";

    if (!id) {
      return json({ ok: false, error: "ID de franja no válido." }, { status: 400 });
    }

    const existente = await obtenerFranjaPorId(env, id);

    if (!existente) {
      return json(
        { ok: false, error: "La franja indicada no existe." },
        { status: 404 }
      );
    }

    await checkAdminActividad(env, session.usuario_id, existente.actividad_id);

    const actividad = await obtenerActividad(env, existente.actividad_id);
    const aforo_limitado = resolverAforoLimitadoActual(data, actividad);
    const siguienteFranja = {
      fecha: es_recurrente === 1 ? null : fecha,
      hora_inicio,
      hora_fin,
      capacidad: aforo_limitado === 1 ? capacidad : null,
      es_recurrente,
      patron_recurrencia: es_recurrente === 1 ? patron_recurrencia : null
    };

    const errorValidacion = validarDatosFranja({
      fecha,
      hora_inicio,
      hora_fin,
      capacidad,
      es_recurrente,
      patron_recurrencia,
      aforo_limitado
    });

    if (errorValidacion) {
      return json({ ok: false, error: errorValidacion }, { status: 400 });
    }

    const errorFecha = validarFechaDentroDeActividad(actividad, fecha, es_recurrente);

    if (errorFecha) {
      return json({ ok: false, error: errorFecha }, { status: 400 });
    }

    let duplicada;

    if (es_recurrente === 1) {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND es_recurrente = 1
          AND patron_recurrencia = ?
          AND hora_inicio = ?
          AND hora_fin = ?
          AND id <> ?
        LIMIT 1
      `)
        .bind(existente.actividad_id, patron_recurrencia, hora_inicio, hora_fin, id)
        .first();
    } else {
      duplicada = await env.DB.prepare(`
        SELECT id
        FROM franjas
        WHERE actividad_id = ?
          AND COALESCE(es_recurrente, 0) = 0
          AND fecha = ?
          AND hora_inicio = ?
          AND hora_fin = ?
          AND id <> ?
        LIMIT 1
      `)
        .bind(existente.actividad_id, fecha, hora_inicio, hora_fin, id)
        .first();
    }

    if (duplicada) {
      return json(
        {
          ok: false,
          error: "Ya existe otra franja con esos datos para esta actividad."
        },
        { status: 409 }
      );
    }

    if (aforo_limitado === 1) {
      const ocupadas = await obtenerBloqueoActualFranja(env, id);

      if (capacidad < ocupadas) {
        return json(
          {
            ok: false,
            error: `La capacidad no puede ser inferior a las plazas ya bloqueadas (${ocupadas}).`
          },
          { status: 400 }
        );
      }
    }

    const hayCambioReal = franjaHaCambiado(existente, siguienteFranja);
    const reservasAfectadas = hayCambioReal ? await obtenerReservasAfectadasFranja(env, id) : [];
    if (hayCambioReal && reservasAfectadas.length > 0 && !confirmarAfectacion) {
      return json({
        ok: false,
        requiere_confirmacion_afectacion: true,
        total_afectadas: reservasAfectadas.length,
        mensaje: reservasAfectadas.length === 1
          ? "Existe 1 solicitud vinculada a esta franja. Si continúas, se notificará al solicitante y, si estaba pendiente o confirmada, pasará a suspendida."
          : `Existen ${reservasAfectadas.length} solicitudes vinculadas a esta franja. Si continúas, se notificará a los solicitantes y las que estuvieran pendientes o confirmadas pasarán a suspendida.`
      }, { status: 409 });
    }

    const updateResult = await env.DB.prepare(`
      UPDATE franjas
      SET
        fecha = ?,
        hora_inicio = ?,
        hora_fin = ?,
        capacidad = ?,
        es_recurrente = ?,
        patron_recurrencia = ?
      WHERE id = ?
    `)
      .bind(
        es_recurrente === 1 ? null : fecha,
        hora_inicio,
        hora_fin,
        aforo_limitado === 1 ? capacidad : null,
        es_recurrente,
        es_recurrente === 1 ? patron_recurrencia : null,
        id
      )
      .run();

    if ((updateResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo actualizar la franja." },
        { status: 500 }
      );
    }

    let resumenAfectacion = null;
    if (hayCambioReal && reservasAfectadas.length > 0) {
      resumenAfectacion = await aplicarCambiosYNotificarFranja(
        env,
        reservasAfectadas,
        existente,
        siguienteFranja,
        {
          actorUsuarioId: session.usuario_id,
          actorRol: "ADMIN"
        }
      );
    }

    const franjas = await obtenerResumenFranjas(env, existente.actividad_id);

    return json({
      ok: true,
      mensaje: "Franja actualizada correctamente.",
      resumen_afectacion: resumenAfectacion,
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al actualizar la franja.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}

export async function onRequestDelete(context) {
  const authError = await requireAdminSession(context);
  if (authError) return authError;

  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    const data = await request.json();
    const id = parsearIdPositivo(data.id);

    if (!id) {
      return json({ ok: false, error: "ID de franja no válido." }, { status: 400 });
    }

    const existente = await obtenerFranjaPorId(env, id);

    if (!existente) {
      return json(
        { ok: false, error: "La franja indicada no existe." },
        { status: 404 }
      );
    }

    await checkAdminActividad(env, session.usuario_id, existente.actividad_id);

    const actividad = await obtenerActividad(env, existente.actividad_id);
    const aforo_limitado = resolverAforoLimitadoActual(data, actividad);

if (Number(actividad.borrador_tecnico) !== 1) {

  // 1. Confirmadas FUTURAS → BLOQUEO DURO
  const confirmadasFuturas = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM reservas r
    JOIN franjas f ON f.id = r.franja_id
    WHERE r.franja_id = ?
      AND r.estado = 'CONFIRMADA'
      AND (
        f.fecha IS NULL OR
        datetime(f.fecha || ' ' || f.hora_inicio) >= datetime('now')
      )
  `).bind(id).first();

  if (Number(confirmadasFuturas?.total || 0) > 0) {
    return json({
      ok: false,
      bloquear: true,
      error: "No se puede eliminar la franja porque tiene reservas confirmadas futuras."
    }, { status: 400 });
  }

  // 2. Pendientes → PERMITIR CON AVISO
  const pendientes = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM reservas
    WHERE franja_id = ?
      AND estado = 'PENDIENTE'
  `).bind(id).first();

  if (Number(pendientes?.total || 0) > 0 && !data.confirmar) {
    return json({
      ok: false,
      requiere_confirmacion: true,
      mensaje: "Existen solicitudes pendientes. Si continúas, serán rechazadas."
    }, { status: 409 });
  }
}
    const deleteResult = await env.DB.prepare(`
      DELETE FROM franjas
      WHERE id = ?
    `)
      .bind(id)
      .run();

    if ((deleteResult?.meta?.changes || 0) === 0) {
      return json(
        { ok: false, error: "No se pudo eliminar la franja." },
        { status: 500 }
      );
    }

    const franjas = await obtenerResumenFranjas(env, existente.actividad_id);

    return json({
      ok: true,
      mensaje: "Franja eliminada correctamente.",
      franjas
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al eliminar la franja.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
