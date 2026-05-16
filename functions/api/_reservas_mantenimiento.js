import { crearNotificacion } from "./_notificaciones.js";
import { enviarEmail, nombreVisibleAdmin } from "./_email.js";
import { asegurarTablaHistorialReservas, borrarHistorialReservas, registrarEventoReserva } from "./_reservas_historial.js";

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

function estadoIncluidoEnHistorico(estado) {
  return ["CONFIRMADA"].includes(String(estado || "").toUpperCase());
}

function formatearProgramacionReserva(row = {}) {
  const fecha = limpiarTexto(row?.fecha || row?.fecha_inicio || "");
  const horaInicio = limpiarTexto(row?.hora_inicio || "");
  const horaFin = limpiarTexto(row?.hora_fin || "");
  if (fecha && horaInicio && horaFin) return `${fecha} · ${horaInicio} - ${horaFin}`;
  if (fecha) return fecha;
  return "Sin programación horaria";
}

function construirCorreoAdminEliminacionPorCaducidad(contexto = {}) {
  const adminNombre = nombreVisibleAdmin({
    nombre_publico: contexto?.admin_nombre_publico,
    nombre: contexto?.admin_nombre,
    localidad: contexto?.admin_localidad
  });
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const centro = limpiarTexto(contexto?.centro || "un centro");
  const contacto = limpiarTexto(contexto?.contacto || "");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const programacion = formatearProgramacionReserva(contexto);
  const asunto = "[Reservas] Solicitud eliminada por caducidad";
  const mensaje = `${centro} no llegó a asignar plazas en ${actividad}${codigo ? ` (${codigo})` : ""}. La solicitud ha sido eliminada automáticamente al caducar la prereserva.`;

  const texto = [
    `Hola ${adminNombre},`,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Centro solicitante: ${centro}`,
    contacto ? `Persona de contacto: ${contacto}` : "",
    `Programación: ${programacion}`,
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
    <p><strong>Programación:</strong> ${escaparHtml(programacion)}</p>
    <p>Puedes revisar el estado actualizado desde tu panel de reservas.</p>
  `;

  return { asunto, texto, html };
}

function construirCorreoSolicitanteEliminacionPorCaducidad(contexto = {}) {
  const contacto = limpiarTexto(contexto?.contacto || "");
  const saludo = contacto ? `Hola ${contacto},` : "Hola,";
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const organizador = nombreVisibleAdmin({
    nombre_publico: contexto?.admin_nombre_publico,
    nombre: contexto?.admin_nombre,
    localidad: contexto?.admin_localidad
  });
  const programacion = formatearProgramacionReserva(contexto);
  const asunto = "[Reservas] Solicitud eliminada por caducidad";
  const mensaje = `Tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha sido eliminada automáticamente porque la prereserva caducó sin que se asignara ninguna plaza.`;

  const texto = [
    saludo,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Organiza: ${organizador}`,
    `Programación: ${programacion}`,
    "",
    "Si sigues interesado, puedes tramitar una nueva solicitud desde la plataforma."
  ].filter(Boolean).join("\n");

  const html = `
    <p>${escaparHtml(saludo)}</p>
    <p>${escaparHtml(mensaje)}</p>
    <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
    ${codigo ? `<p><strong>Código de solicitud:</strong> ${escaparHtml(codigo)}</p>` : ""}
    <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
    <p><strong>Programación:</strong> ${escaparHtml(programacion)}</p>
    <p>Si sigues interesado, puedes tramitar una nueva solicitud desde la plataforma.</p>
  `;

  return { asunto, texto, html };
}

function construirCorreoSolicitanteCaducidadParcial(contexto = {}) {
  const contacto = limpiarTexto(contexto?.contacto || "");
  const saludo = contacto ? `Hola ${contacto},` : "Hola,";
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const organizador = nombreVisibleAdmin({
    nombre_publico: contexto?.admin_nombre_publico,
    nombre: contexto?.admin_nombre,
    localidad: contexto?.admin_localidad
  });
  const programacion = formatearProgramacionReserva(contexto);
  const asignadas = Number(contexto?.asistentes_total || 0);
  const reservadasOriginales = Number(contexto?.plazas_prereservadas || 0);
  const liberadas = Math.max(reservadasOriginales - asignadas, 0);
  const asunto = "[Reservas] Prereserva caducada y solicitud mantenida";
  const mensaje = `Tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha agotado el tiempo de prereserva. Se mantienen ${asignadas} plaza(s) ya asignada(s) y ${liberadas} plaza(s) no asignada(s) han vuelto a quedar disponibles.`;
  const aclaracion = "No necesitas crear una nueva solicitud complementaria. Si la actividad sigue teniendo plazas disponibles, puedes editar esta misma solicitud y añadir directamente, en tiempo real, nuevas plazas nominales sobre la reserva existente.";

  const texto = [
    saludo,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Organiza: ${organizador}`,
    `Programación: ${programacion}`,
    "",
    aclaracion
  ].filter(Boolean).join("\n");

  const html = `
    <p>${escaparHtml(saludo)}</p>
    <p>${escaparHtml(mensaje)}</p>
    <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
    ${codigo ? `<p><strong>Código de solicitud:</strong> ${escaparHtml(codigo)}</p>` : ""}
    <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
    <p><strong>Programación:</strong> ${escaparHtml(programacion)}</p>
    <p>${escaparHtml(aclaracion)}</p>
  `;

  return { asunto, texto, html };
}

function construirCorreoAdminCaducidadSuspension(contexto = {}) {
  const adminNombre = nombreVisibleAdmin({
    nombre_publico: contexto?.admin_nombre_publico,
    nombre: contexto?.admin_nombre,
    localidad: contexto?.admin_localidad
  });
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const centro = limpiarTexto(contexto?.centro || "un centro");
  const contacto = limpiarTexto(contexto?.contacto || "");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const programacion = formatearProgramacionReserva(contexto);
  const asunto = "[Reservas] Solicitud rechazada por caducidad documental";
  const mensaje = `${centro} no regularizó a tiempo la documentación pendiente para ${actividad}${codigo ? ` (${codigo})` : ""}. La solicitud suspendida ha pasado automáticamente a rechazada.`;

  const texto = [
    `Hola ${adminNombre},`,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Centro solicitante: ${centro}`,
    contacto ? `Persona de contacto: ${contacto}` : "",
    `Programación: ${programacion}`,
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
    <p><strong>Programación:</strong> ${escaparHtml(programacion)}</p>
    <p>Puedes revisar el estado actualizado desde tu panel de reservas.</p>
  `;

  return { asunto, texto, html };
}

function construirCorreoSolicitanteCaducidadSuspension(contexto = {}) {
  const contacto = limpiarTexto(contexto?.contacto || "");
  const saludo = contacto ? `Hola ${contacto},` : "Hola,";
  const actividad = limpiarTexto(contexto?.actividad_nombre || "la actividad");
  const codigo = limpiarTexto(contexto?.codigo_reserva || "");
  const organizador = nombreVisibleAdmin({
    nombre_publico: contexto?.admin_nombre_publico,
    nombre: contexto?.admin_nombre,
    localidad: contexto?.admin_localidad
  });
  const programacion = formatearProgramacionReserva(contexto);
  const asunto = "[Reservas] Solicitud rechazada por caducidad";
  const mensaje = `Tu solicitud para ${actividad}${codigo ? ` (${codigo})` : ""} ha pasado automáticamente a rechazada porque la documentación pendiente no se regularizó antes de la fecha de la actividad.`;

  const texto = [
    saludo,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Organiza: ${organizador}`,
    `Programación: ${programacion}`,
    "",
    "Puedes revisar el detalle desde tu panel de usuario."
  ].filter(Boolean).join("\n");

  const html = `
    <p>${escaparHtml(saludo)}</p>
    <p>${escaparHtml(mensaje)}</p>
    <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
    ${codigo ? `<p><strong>Código de solicitud:</strong> ${escaparHtml(codigo)}</p>` : ""}
    <p><strong>Organiza:</strong> ${escaparHtml(organizador)}</p>
    <p><strong>Programación:</strong> ${escaparHtml(programacion)}</p>
    <p>Puedes revisar el detalle desde tu panel de usuario.</p>
  `;

  return { asunto, texto, html };
}

async function crearAvisosCaducidadSuspension(env, reserva = {}) {
  const actividadId = Number(reserva.actividad_id || 0);
  const adminId = Number(reserva.admin_id || 0);
  const usuarioId = Number(reserva.usuario_id || 0);
  const adminEmail = limpiarTexto(reserva.admin_email || "");
  const solicitanteEmail = limpiarTexto(reserva.email || "");
  const tareas = [];

  if (adminId > 0) {
    tareas.push(
      crearNotificacion(env, {
        usuarioId: adminId,
        rolDestino: "ADMIN",
        tipo: "RESERVA",
        titulo: "Solicitud rechazada por caducidad",
        mensaje: `${limpiarTexto(reserva.centro || "Un centro")} no regularizó a tiempo la documentación pendiente para ${limpiarTexto(reserva.actividad_nombre || "la actividad")}${limpiarTexto(reserva.codigo_reserva) ? ` (${limpiarTexto(reserva.codigo_reserva)})` : ""}. La solicitud ha pasado a rechazada automáticamente.`,
        urlDestino: actividadId > 0
          ? `/admin-reservas.html?actividad_id=${encodeURIComponent(String(actividadId))}`
          : "/admin-reservas.html"
      }).catch(() => ({ ok: false }))
    );
  }

  if (usuarioId > 0) {
    tareas.push(
      crearNotificacion(env, {
        usuarioId,
        rolDestino: "SOLICITANTE",
        tipo: "RESERVA",
        titulo: "Solicitud rechazada por caducidad",
        mensaje: `Tu solicitud para ${limpiarTexto(reserva.actividad_nombre || "la actividad")}${limpiarTexto(reserva.codigo_reserva) ? ` (${limpiarTexto(reserva.codigo_reserva)})` : ""} ha pasado automáticamente a rechazada al no regularizarse a tiempo la documentación pendiente.`,
        urlDestino: "/usuario-panel.html"
      }).catch(() => ({ ok: false }))
    );
  }

  if (adminEmail) {
    const correoAdmin = construirCorreoAdminCaducidadSuspension(reserva);
    tareas.push(
      enviarEmail(env, {
        to: adminEmail,
        subject: correoAdmin.asunto,
        text: correoAdmin.texto,
        html: correoAdmin.html
      }).catch(() => ({ ok: false }))
    );
  }

  if (solicitanteEmail) {
    const correoSolicitante = construirCorreoSolicitanteCaducidadSuspension(reserva);
    tareas.push(
      enviarEmail(env, {
        to: solicitanteEmail,
        subject: correoSolicitante.asunto,
        text: correoSolicitante.texto,
        html: correoSolicitante.html
      }).catch(() => ({ ok: false }))
    );
  }

  if (!tareas.length) return;
  await Promise.all(tareas);
}

async function asegurarTablaHistorico(env) {
  const db = env.DB.withSession("first-primary");
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS reservas_estadisticas_historico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reserva_id INTEGER NOT NULL UNIQUE,
      actividad_id INTEGER,
      actividad_nombre TEXT,
      admin_id INTEGER,
      admin_nombre TEXT,
      fecha_referencia TEXT,
      anio INTEGER,
      estado_final TEXT,
      asistentes_total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function rechazarReservasSuspendidasVencidas(env) {
  const db = env.DB.withSession("first-primary");
  const rows = await db.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.actividad_id,
      r.codigo_reserva,
      r.centro,
      r.contacto,
      COALESCE(NULLIF(TRIM(r.email), ''), NULLIF(TRIM(us_solicitante.email), '')) AS email,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      a.admin_id,
      u.email AS admin_email,
      u.nombre AS admin_nombre,
      u.nombre_publico AS admin_nombre_publico,
      u.localidad AS admin_localidad,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      a.fecha_inicio
    FROM reservas r
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios u
      ON u.id = a.admin_id
    LEFT JOIN usuarios us_solicitante
      ON us_solicitante.id = r.usuario_id
    WHERE UPPER(TRIM(COALESCE(r.estado, ''))) = 'SUSPENDIDA'
      AND datetime(
        COALESCE(
          CASE
            WHEN f.fecha IS NOT NULL AND f.hora_inicio IS NOT NULL
              THEN f.fecha || ' ' || f.hora_inicio
            ELSE NULL
          END,
          CASE
            WHEN a.fecha_inicio IS NOT NULL
              THEN a.fecha_inicio || ' 00:00:00'
            ELSE NULL
          END
        )
      ) <= datetime('now')
  `).all();

  const reservas = rows?.results || [];
  if (!reservas.length) return 0;

  for (const reserva of reservas) {
    const id = Number(reserva.id || 0);
    if (!(id > 0)) continue;
    const update = await db.prepare(`
      UPDATE reservas
      SET estado = 'RECHAZADA',
          fecha_modificacion = datetime('now')
      WHERE id = ?
    `).bind(id).run();

    if (Number(update?.meta?.changes || 0) > 0) {
      await registrarEventoReserva(env, {
        reservaId: id,
        accion: "CADUCIDAD_SUSPENSION",
        estadoOrigen: "SUSPENDIDA",
        estadoDestino: "RECHAZADA",
        observaciones: "La solicitud suspendida ha vencido sin regularización antes de la actividad.",
        actorRol: "SISTEMA",
        actorNombre: "Sistema"
      });
      await crearAvisosCaducidadSuspension(env, reserva);
    }
  }
  return reservas.length;
}

async function obtenerReservasPrereservaExpirada(env) {
  const db = env.DB.withSession("first-primary");
  const rows = await db.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.actividad_id,
      r.estado,
      r.codigo_reserva,
      r.centro,
      r.contacto,
      COALESCE(NULLIF(TRIM(r.email), ''), NULLIF(TRIM(us_solicitante.email), '')) AS email,
      r.personas,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      a.admin_id,
      u.email AS admin_email,
      u.nombre AS admin_nombre,
      u.nombre_publico AS admin_nombre_publico,
      u.localidad AS admin_localidad,
      f.fecha,
      f.hora_inicio,
      f.hora_fin,
      a.fecha_inicio,
      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_total
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios u
      ON u.id = a.admin_id
    LEFT JOIN usuarios us_solicitante
      ON us_solicitante.id = r.usuario_id
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.prereserva_expira_en IS NOT NULL
      AND datetime(r.prereserva_expira_en) < datetime('now')
      AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
      AND COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) < COALESCE(r.plazas_prereservadas, 0)
  `).all();

  return rows?.results || [];
}

async function crearAvisosEliminacionReservaCaducada(env, reserva = {}) {
  const actividadId = Number(reserva.actividad_id || 0);
  const adminId = Number(reserva.admin_id || 0);
  const usuarioId = Number(reserva.usuario_id || 0);
  const adminEmail = limpiarTexto(reserva.admin_email || "");
  const solicitanteEmail = limpiarTexto(reserva.email || "");

  const tareas = [];

  if (adminId > 0) {
    tareas.push(
      crearNotificacion(env, {
        usuarioId: adminId,
        rolDestino: "ADMIN",
        tipo: "RESERVA",
        titulo: "Solicitud eliminada por caducidad",
        mensaje: `${limpiarTexto(reserva.centro || "Un centro")} no llegó a asignar plazas en ${limpiarTexto(reserva.actividad_nombre || "una actividad")}${limpiarTexto(reserva.codigo_reserva) ? ` (${limpiarTexto(reserva.codigo_reserva)})` : ""}. La solicitud ha sido eliminada automáticamente.`,
        urlDestino: actividadId > 0
          ? `/admin-reservas.html?actividad_id=${encodeURIComponent(String(actividadId))}`
          : "/admin-reservas.html"
      }).catch(() => ({ ok: false }))
    );
  }

  if (usuarioId > 0) {
    tareas.push(
      crearNotificacion(env, {
        usuarioId,
        rolDestino: "SOLICITANTE",
        tipo: "RESERVA",
        titulo: "Solicitud eliminada por caducidad",
        mensaje: `Tu solicitud para ${limpiarTexto(reserva.actividad_nombre || "la actividad")}${limpiarTexto(reserva.codigo_reserva) ? ` (${limpiarTexto(reserva.codigo_reserva)})` : ""} ha sido eliminada automáticamente al caducar sin plazas asignadas.`,
        urlDestino: "/usuario-panel.html"
      }).catch(() => ({ ok: false }))
    );
  }

  if (adminEmail) {
    const correoAdmin = construirCorreoAdminEliminacionPorCaducidad(reserva);
    tareas.push(
      enviarEmail(env, {
        to: adminEmail,
        subject: correoAdmin.asunto,
        text: correoAdmin.texto,
        html: correoAdmin.html
      }).catch(() => ({ ok: false }))
    );
  }

  if (solicitanteEmail) {
    const correoSolicitante = construirCorreoSolicitanteEliminacionPorCaducidad(reserva);
    tareas.push(
      enviarEmail(env, {
        to: solicitanteEmail,
        subject: correoSolicitante.asunto,
        text: correoSolicitante.texto,
        html: correoSolicitante.html
      }).catch(() => ({ ok: false }))
    );
  }

  if (!tareas.length) return;
  await Promise.all(tareas);
}

async function crearAvisosCaducidadParcialSolicitante(env, reserva = {}) {
  const usuarioId = Number(reserva.usuario_id || 0);
  const solicitanteEmail = limpiarTexto(reserva.email || "");
  const tareas = [];

  if (usuarioId > 0) {
    tareas.push(
      crearNotificacion(env, {
        usuarioId,
        rolDestino: "SOLICITANTE",
        tipo: "RESERVA",
        titulo: "Prereserva caducada parcialmente",
        mensaje: `Tu solicitud para ${limpiarTexto(reserva.actividad_nombre || "la actividad")}${limpiarTexto(reserva.codigo_reserva) ? ` (${limpiarTexto(reserva.codigo_reserva)})` : ""} mantiene las plazas ya asignadas y libera automáticamente las no asignadas. Puedes seguir ampliándola sobre esta misma solicitud si aún quedan plazas disponibles.`,
        urlDestino: "/usuario-panel.html"
      }).catch(() => ({ ok: false }))
    );
  }

  if (solicitanteEmail) {
    const correoSolicitante = construirCorreoSolicitanteCaducidadParcial(reserva);
    tareas.push(
      enviarEmail(env, {
        to: solicitanteEmail,
        subject: correoSolicitante.asunto,
        text: correoSolicitante.texto,
        html: correoSolicitante.html
      }).catch(() => ({ ok: false }))
    );
  }

  if (!tareas.length) return;
  await Promise.all(tareas);
}

async function normalizarPrereservasExpiradas(env) {
  const db = env.DB.withSession("first-primary");
  const reservas = await obtenerReservasPrereservaExpirada(env);
  if (!reservas.length) {
    return {
      consolidadas_con_asignados: 0,
      eliminadas_sin_asignados: 0
    };
  }

  let consolidadas = 0;
  let eliminadas = 0;

  for (const reserva of reservas) {
    const asistentesTotal = Number(reserva.asistentes_total || 0);

    if (asistentesTotal > 0) {
      const updateResult = await db.prepare(`
        UPDATE reservas
        SET
          personas = ?,
          plazas_prereservadas = ?,
          fecha_modificacion = datetime('now')
        WHERE id = ?
      `).bind(
        asistentesTotal,
        asistentesTotal,
        Number(reserva.id || 0)
      ).run();

      if (Number(updateResult?.meta?.changes || 0) > 0) {
        consolidadas += 1;
        await registrarEventoReserva(env, {
          reservaId: Number(reserva.id || 0),
          accion: "CADUCIDAD_PRERESERVA_PARCIAL",
          estadoOrigen: reserva.estado,
          estadoDestino: reserva.estado,
          observaciones: `Ha finalizado el tiempo para asignación de plazas pre-reservadas. Plazas reservadas ${Number(reserva.plazas_prereservadas || 0)}`,
          actorRol: "SISTEMA",
          actorNombre: "Sistema"
        });
        await crearAvisosCaducidadParcialSolicitante(env, {
          ...reserva,
          asistentes_total: asistentesTotal
        });
      }
      continue;
    }

    await db.prepare(`
      DELETE FROM visitantes
      WHERE reserva_id = ?
    `).bind(Number(reserva.id || 0)).run();

    await borrarHistorialReservas(env, [Number(reserva.id || 0)]);

    const deleteResult = await db.prepare(`
      DELETE FROM reservas
      WHERE id = ?
    `).bind(Number(reserva.id || 0)).run();

    if (Number(deleteResult?.meta?.changes || 0) > 0) {
      eliminadas += 1;
      await crearAvisosEliminacionReservaCaducada(env, reserva);
    }
  }

  return {
    consolidadas_con_asignados: consolidadas,
    eliminadas_sin_asignados: eliminadas
  };
}

async function obtenerReservasFinalizadas(env) {
  const db = env.DB.withSession("first-primary");
  const rows = await db.prepare(`
    SELECT
      r.id,
      r.estado,
      r.actividad_id,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      a.admin_id,
      COALESCE(u.nombre_publico, u.nombre, u.email, 'Administrador') AS admin_nombre,
      COALESCE(f.fecha, a.fecha_fin) AS fecha_referencia,
      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_total
    FROM reservas r
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios u
      ON u.id = a.admin_id
    WHERE datetime(
      COALESCE(
        CASE
          WHEN f.fecha IS NOT NULL AND f.hora_fin IS NOT NULL
            THEN f.fecha || ' ' || f.hora_fin
          ELSE NULL
        END,
        CASE
          WHEN a.fecha_fin IS NOT NULL
            THEN a.fecha_fin || ' 23:59:59'
          ELSE NULL
        END
      )
    ) <= datetime('now')
  `).all();

  return rows?.results || [];
}

async function guardarHistorico(env, reservas) {
  const db = env.DB.withSession("first-primary");
  const candidatas = (reservas || []).filter((row) => estadoIncluidoEnHistorico(row.estado));
  if (!candidatas.length) return 0;

  const sentencias = candidatas.map((row) => db.prepare(`
    INSERT OR IGNORE INTO reservas_estadisticas_historico (
      reserva_id,
      actividad_id,
      actividad_nombre,
      admin_id,
      admin_nombre,
      fecha_referencia,
      anio,
      estado_final,
      asistentes_total
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    Number(row.id || 0),
    Number(row.actividad_id || 0) || null,
    limpiarTexto(row.actividad_nombre) || "Actividad",
    Number(row.admin_id || 0) || null,
    limpiarTexto(row.admin_nombre) || "Administrador",
    limpiarTexto(row.fecha_referencia) || null,
    row.fecha_referencia ? Number(String(row.fecha_referencia).slice(0, 4)) || null : null,
    limpiarTexto(row.estado).toUpperCase(),
    Number(row.asistentes_total || 0)
  ));

  await db.batch(sentencias);
  return candidatas.length;
}

async function borrarReservasFinalizadas(env, reservas) {
  const db = env.DB.withSession("first-primary");
  const ids = (reservas || []).map((row) => Number(row.id || 0)).filter(Boolean);
  if (!ids.length) return 0;

  await borrarHistorialReservas(env, ids);

  const sentenciasVisitantes = ids.map((id) => db.prepare(`
    DELETE FROM visitantes
    WHERE reserva_id = ?
  `).bind(id));
  await db.batch(sentenciasVisitantes);

  const sentenciasReservas = ids.map((id) => db.prepare(`
    DELETE FROM reservas
    WHERE id = ?
  `).bind(id));
  await db.batch(sentenciasReservas);

  return ids.length;
}

async function borrarFranjasDeActividadesVencidas(env) {
  const db = env.DB.withSession("first-primary");
  const result = await db.prepare(`
    DELETE FROM franjas
    WHERE actividad_id IN (
      SELECT id
      FROM actividades
      WHERE UPPER(TRIM(COALESCE(tipo, ''))) = 'TEMPORAL'
        AND fecha_fin IS NOT NULL
        AND date(fecha_fin) < date('now')
    )
  `).run();

  return Number(result?.meta?.changes || 0);
}

async function obtenerReservasResidualesLegacy(env) {
  const db = env.DB.withSession("first-primary");
  const rows = await db.prepare(`
    SELECT
      r.id
    FROM reservas r
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    WHERE r.actividad_id IS NULL
       OR a.id IS NULL
       OR (
         COALESCE(a.usa_franjas, 1) = 1
         AND (
           r.franja_id IS NULL
           OR f.id IS NULL
           OR TRIM(COALESCE(f.fecha, '')) = ''
           OR TRIM(COALESCE(f.hora_inicio, '')) = ''
           OR TRIM(COALESCE(f.hora_fin, '')) = ''
         )
       )
  `).all();

  return rows?.results || [];
}

async function borrarReservasResidualesLegacy(env, reservas) {
  const db = env.DB.withSession("first-primary");
  const ids = (reservas || []).map((row) => Number(row.id || 0)).filter(Boolean);
  if (!ids.length) return 0;

  await borrarHistorialReservas(env, ids);

  const sentenciasVisitantes = ids.map((id) => db.prepare(`
    DELETE FROM visitantes
    WHERE reserva_id = ?
  `).bind(id));
  await db.batch(sentenciasVisitantes);

  const sentenciasReservas = ids.map((id) => db.prepare(`
    DELETE FROM reservas
    WHERE id = ?
  `).bind(id));
  await db.batch(sentenciasReservas);

  return ids.length;
}

export async function ejecutarMantenimientoReservas(env) {
  await asegurarTablaHistorico(env);
  await asegurarTablaHistorialReservas(env);
  const rechazadasAutomaticamente = await rechazarReservasSuspendidasVencidas(env);
  const prereservasExpiradas = await normalizarPrereservasExpiradas(env);
  const residualesLegacy = await obtenerReservasResidualesLegacy(env);
  const residualesEliminadas = await borrarReservasResidualesLegacy(env, residualesLegacy);
  const finalizadas = await obtenerReservasFinalizadas(env);
  const archivadas = await guardarHistorico(env, finalizadas);
  const eliminadas = await borrarReservasFinalizadas(env, finalizadas);
  const franjasEliminadas = await borrarFranjasDeActividadesVencidas(env);

  return {
    ok: true,
    rechazadas_automaticamente: rechazadasAutomaticamente,
    prereservas_consolidadas_con_asignados: prereservasExpiradas.consolidadas_con_asignados,
    prereservas_eliminadas_sin_asignados: prereservasExpiradas.eliminadas_sin_asignados,
    residuos_legacy_eliminados: residualesEliminadas,
    archivadas,
    eliminadas,
    franjas_eliminadas_por_fin_actividad: franjasEliminadas
  };
}
