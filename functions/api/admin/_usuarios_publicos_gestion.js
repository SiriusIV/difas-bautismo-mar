import { crearNotificacion } from "../_notificaciones.js";
import { enviarEmail } from "../_email.js";
import { registrarEventoReserva, borrarHistorialReservas } from "../_reservas_historial.js";

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

function dbPrimaria(env) {
  if (typeof env?.DB?.withSession === "function") {
    return env.DB.withSession("first-primary");
  }
  return env.DB;
}

async function borrarFilasUsuarioSiTablaExiste(env, tabla, columnasUsuario = [], usuarioId) {
  const id = Number(usuarioId || 0);
  for (const columna of columnasUsuario) {
    try {
      await env.DB.prepare(`
        DELETE FROM ${tabla}
        WHERE ${columna} = ?
      `).bind(id).run();
      return;
    } catch (error) {
      const detalle = String(error?.message || "").toLowerCase();
      if (detalle.includes("no such table")) return;
      if (detalle.includes("no such column")) continue;
      throw error;
    }
  }
}

async function limpiarDependenciasUsuario(env, usuarioId) {
  await borrarFilasUsuarioSiTablaExiste(env, "password_reset_tokens", ["user_id", "usuario_id"], usuarioId);
  await borrarFilasUsuarioSiTablaExiste(env, "notificaciones", ["usuario_id", "user_id"], usuarioId);
  await borrarFilasUsuarioSiTablaExiste(env, "reservas_avisos_usuario", ["usuario_id", "user_id"], usuarioId);
  await borrarFilasUsuarioSiTablaExiste(env, "usuario_documentacion_organizadores", ["centro_usuario_id", "usuario_id"], usuarioId);

  try {
    await env.DB.prepare(`
      DELETE FROM centro_admin_documentacion_archivos
      WHERE documentacion_id IN (
        SELECT id FROM centro_admin_documentacion WHERE centro_usuario_id = ?
      )
    `).bind(Number(usuarioId || 0)).run();
  } catch (error) {
    const detalle = String(error?.message || "").toLowerCase();
    if (!detalle.includes("no such table")) throw error;
  }

  await borrarFilasUsuarioSiTablaExiste(env, "centro_admin_documentacion", ["centro_usuario_id", "usuario_id"], usuarioId);
}

async function eliminarTodasLasReservasDelUsuario(env, usuarioId) {
  const db = dbPrimaria(env);
  const result = await db.prepare(`
    SELECT id
    FROM reservas
    WHERE usuario_id = ?
  `).bind(Number(usuarioId || 0)).all();

  const reservaIds = (result?.results || [])
    .map((row) => Number(row?.id || 0))
    .filter((id) => id > 0);

  if (!reservaIds.length) return 0;

  await borrarHistorialReservas(env, reservaIds);
  const placeholders = reservaIds.map(() => "?").join(", ");

  await db.prepare(`
    DELETE FROM visitantes
    WHERE reserva_id IN (${placeholders})
  `).bind(...reservaIds).run();

  const borradoReservas = await db.prepare(`
    DELETE FROM reservas
    WHERE id IN (${placeholders})
  `).bind(...reservaIds).run();

  return Number(borradoReservas?.meta?.changes || 0);
}

function nombreVisibleUsuarioPublico(usuario = {}) {
  return (
    limpiarTexto(usuario.centro) ||
    limpiarTexto(usuario.nombre) ||
    limpiarTexto(usuario.email) ||
    "usuario publico"
  );
}

function nombreVisibleAdmin(admin = {}) {
  return (
    limpiarTexto(admin.nombre_publico) ||
    limpiarTexto(admin.nombre) ||
    limpiarTexto(admin.email) ||
    "administrador"
  );
}

function deduplicarTextos(items = []) {
  const vistos = new Set();
  const salida = [];
  for (const item of items) {
    const texto = limpiarTexto(item);
    if (!texto) continue;
    const clave = texto.toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(texto);
  }
  return salida;
}

function describirReservaParaListado(reserva = {}) {
  const actividad = limpiarTexto(reserva.actividad_nombre || "Actividad");
  const codigo = limpiarTexto(reserva.codigo_reserva || "");
  return codigo ? `${actividad} (${codigo})` : actividad;
}

async function obtenerUsuarioPublico(env, usuarioId) {
  return await env.DB.prepare(`
    SELECT
      id,
      nombre,
      centro,
      localidad,
      email,
      telefono_contacto,
      responsable_legal,
      tipo_documento,
      documento_identificacion,
      activo,
      rol,
      fecha_alta
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(usuarioId).first();
}

async function obtenerReservasAfectablesUsuario(env, usuarioId) {
  const result = await dbPrimaria(env).prepare(`
    SELECT
      r.*,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      COALESCE(a.organizador_publico, 'Organizador') AS organizador_nombre,
      COALESCE(a.admin_id, 0) AS admin_id,
      COALESCE(ua.email, '') AS admin_email,
      COALESCE(ua.nombre_publico, ua.nombre, ua.email, 'Administrador') AS admin_nombre,
      COALESCE(f.fecha, '') AS fecha,
      COALESCE(f.hora_inicio, '') AS hora_inicio,
      COALESCE(f.hora_fin, '') AS hora_fin
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios ua
      ON ua.id = a.admin_id
    LEFT JOIN franjas f
      ON f.id = r.franja_id
    WHERE r.usuario_id = ?
      AND UPPER(TRIM(COALESCE(r.estado, ''))) IN ('BORRADOR', 'PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
    ORDER BY
      COALESCE(f.fecha, '') ASC,
      COALESCE(f.hora_inicio, '') ASC,
      r.id ASC
  `).bind(usuarioId).all();

  return result?.results || [];
}

function construirCorreoUsuarioPublico(usuario, accion, motivo, reservas = []) {
  const nombre = nombreVisibleUsuarioPublico(usuario);
  const esEliminacion = accion === "eliminar";
  const asunto = esEliminacion
    ? "Eliminacion de cuenta de usuario publico"
    : "Suspension temporal de cuenta de usuario publico";
  const cabecera = esEliminacion
    ? "Tu cuenta de usuario publico ha sido eliminada por el superadministrador."
    : "Tu cuenta de usuario publico ha sido suspendida temporalmente por el superadministrador.";
  const solicitudesProcesadas = deduplicarTextos(
    (reservas || [])
      .filter((reserva) => limpiarTexto(reserva.estado).toUpperCase() !== "BORRADOR")
      .map((reserva) => describirReservaParaListado(reserva))
  );
  const borradoresEliminados = deduplicarTextos(
    (reservas || [])
      .filter((reserva) => limpiarTexto(reserva.estado).toUpperCase() === "BORRADOR")
      .map((reserva) => describirReservaParaListado(reserva))
  );

  const texto = [
    `Hola ${nombre},`,
    "",
    cabecera,
    "",
    `Observaciones: ${motivo}`
  ];

  let html = `
    <p>Hola ${escapeHtml(nombre)},</p>
    <p>${escapeHtml(cabecera)}</p>
    <p><strong>Observaciones:</strong> ${escapeHtml(motivo)}</p>
  `;

  if (solicitudesProcesadas.length) {
    const textoProcesadas = esEliminacion
      ? "Como consecuencia de esta accion, las siguientes solicitudes tramitadas han sido eliminadas del sistema:"
      : "Como consecuencia de esta accion, las siguientes solicitudes tramitadas han quedado rechazadas:";
    texto.push(
      "",
      textoProcesadas
    );
    solicitudesProcesadas.forEach((item) => texto.push(`- ${item}`));
    html += `
      <p>${escapeHtml(textoProcesadas)}</p>
      <ul>${solicitudesProcesadas.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    `;
  }

  if (borradoresEliminados.length) {
    texto.push(
      "",
      "Ademas, los siguientes borradores asociados a actividades han quedado cancelados:"
    );
    borradoresEliminados.forEach((item) => texto.push(`- ${item}`));
    html += `
      <p>Ademas, los siguientes borradores asociados a actividades han quedado cancelados:</p>
      <ul>${borradoresEliminados.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    `;
  }

  texto.push(
    "",
    esEliminacion
      ? "A partir de este momento ya no podras acceder al sistema con esta cuenta."
      : "Mientras la cuenta permanezca suspendida no podras acceder al sistema."
  );

  html += `<p>${
    esEliminacion
      ? "A partir de este momento ya no podras acceder al sistema con esta cuenta."
      : "Mientras la cuenta permanezca suspendida no podras acceder al sistema."
  }</p>`;

  return {
    asunto,
    texto: texto.join("\n"),
    html
  };
}

function construirCorreoAdministradorAfectado(admin, usuario, accion, motivo, reservas = []) {
  const nombreAdmin = nombreVisibleAdmin(admin);
  const solicitante = nombreVisibleUsuarioPublico(usuario);
  const esEliminacion = accion === "eliminar";
  const asunto = esEliminacion
    ? "Cancelacion automatica de solicitudes por eliminacion de usuario publico"
    : "Cancelacion automatica de solicitudes por suspension de usuario publico";
  const cabecera = esEliminacion
    ? `Se ha eliminado la cuenta del solicitante ${solicitante}.`
    : `Se ha suspendido temporalmente la cuenta del solicitante ${solicitante}.`;
  const items = (reservas || []).map((reserva) => {
    const descripcion = describirReservaParaListado(reserva);
    const estado = limpiarTexto(reserva.estado || "").toUpperCase();
    const etiqueta = estado === "BORRADOR"
      ? "borrador eliminado"
      : (esEliminacion ? "solicitud eliminada" : "solicitud rechazada");
    return `${descripcion} - ${etiqueta}`;
  });

  const texto = [
    `Hola ${nombreAdmin},`,
    "",
    cabecera,
    "",
    `Solicitante afectado: ${solicitante}`,
    `Correo del solicitante: ${limpiarTexto(usuario.email || "-")}`,
    "",
    "Las siguientes solicitudes o borradores asociados a actividades de tu ambito han quedado cancelados:"
  ];

  items.forEach((item) => texto.push(`- ${item}`));
  texto.push("", `Observaciones del superadministrador: ${motivo}`);
  texto.push("", "Las plazas asociadas a esas solicitudes quedan liberadas y vuelven a estar disponibles segun la logica habitual de reservas.");

  const html = `
    <p>Hola ${escapeHtml(nombreAdmin)},</p>
    <p>${escapeHtml(cabecera)}</p>
    <p><strong>Solicitante afectado:</strong> ${escapeHtml(solicitante)}<br><strong>Correo del solicitante:</strong> ${escapeHtml(usuario.email || "-")}</p>
    <p>Las siguientes solicitudes o borradores asociados a actividades de tu ambito han quedado cancelados:</p>
    <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    <p><strong>Observaciones del superadministrador:</strong> ${escapeHtml(motivo)}</p>
    <p>Las plazas asociadas a esas solicitudes quedan liberadas y vuelven a estar disponibles segun la logica habitual de reservas.</p>
  `;

  return { asunto, texto: texto.join("\n"), html };
}

async function crearNotificacionAdministradorAfectado(env, adminId, usuario, accion, reservas = []) {
  if (!(Number(adminId) > 0)) return { ok: false, skipped: true };
  const solicitante = nombreVisibleUsuarioPublico(usuario);
  const esEliminacion = accion === "eliminar";
  const actividades = deduplicarTextos(
    (reservas || []).map((reserva) => {
      const actividad = limpiarTexto(reserva.actividad_nombre || "Actividad");
      const codigo = limpiarTexto(reserva.codigo_reserva || "");
      return codigo ? `${actividad} (${codigo})` : actividad;
    })
  );
  const totalSolicitudes = Array.isArray(reservas) ? reservas.length : 0;
  const resumenActividades = actividades.length
    ? ` Actividades afectadas: ${actividades.join(", ")}.`
    : "";
  return await crearNotificacion(env, {
    usuarioId: Number(adminId),
    rolDestino: "ADMIN",
    tipo: "RESERVA",
    titulo: esEliminacion ? "Solicitudes canceladas por eliminacion de usuario" : "Solicitudes canceladas por suspension de usuario",
    mensaje: `${totalSolicitudes} solicitud(es) de ${solicitante} han quedado canceladas automaticamente por ${esEliminacion ? "eliminacion" : "suspension"} de su cuenta.${resumenActividades}`,
    urlDestino: "/admin-reservas.html"
  });
}

async function procesarReservasUsuario(env, usuario, accion, motivo, actor = {}) {
  const db = dbPrimaria(env);
  const reservas = await obtenerReservasAfectablesUsuario(env, Number(usuario.id || 0));
  const resumen = {
    total_reservas_afectadas: reservas.length,
    reservas_rechazadas: 0,
    reservas_eliminadas: 0,
    borradores_eliminados: 0,
    actividades_afectadas: 0,
    administradores_notificados: 0,
    notificaciones_admin_creadas: 0,
    incidencias: []
  };

  if (!reservas.length) {
    return { resumen, reservas };
  }

  const actividadesSet = new Set();
  const reservasPorAdmin = new Map();

  for (const reserva of reservas) {
    const actividadId = Number(reserva.actividad_id || 0);
    if (actividadId > 0) actividadesSet.add(actividadId);
    const adminId = Number(reserva.admin_id || 0);
    const claveAdmin = adminId > 0 ? `id:${adminId}` : `mail:${limpiarTexto(reserva.admin_email).toLowerCase()}`;
    if (!reservasPorAdmin.has(claveAdmin)) {
      reservasPorAdmin.set(claveAdmin, {
        adminId,
        email: limpiarTexto(reserva.admin_email),
        nombre: limpiarTexto(reserva.admin_nombre),
        reservas: []
      });
    }
    reservasPorAdmin.get(claveAdmin).reservas.push(reserva);

    try {
      const estadoOrigen = limpiarTexto(reserva.estado).toUpperCase();
      if (estadoOrigen === "BORRADOR") {
        await borrarHistorialReservas(env, [Number(reserva.id || 0)]);
        await db.prepare(`
          DELETE FROM visitantes
          WHERE reserva_id = ?
        `).bind(Number(reserva.id || 0)).run();

        const borrado = await db.prepare(`
          DELETE FROM reservas
          WHERE id = ?
            AND UPPER(TRIM(COALESCE(estado, ''))) = 'BORRADOR'
        `).bind(Number(reserva.id || 0)).run();

        if (Number(borrado?.meta?.changes || 0) > 0) {
          resumen.borradores_eliminados += 1;
        } else {
          resumen.incidencias.push(`Borrador ${Number(reserva.id || 0)}: no se pudo eliminar.`);
        }
        continue;
      }

      if (accion === "eliminar") {
        await registrarEventoReserva(env, {
          reservaId: Number(reserva.id || 0),
          accion: "ELIMINACION_SOLICITANTE_SUPERADMIN",
          estadoOrigen,
          estadoDestino: "ELIMINADA",
          observaciones: motivo,
          actorUsuarioId: actor.actorUsuarioId,
          actorRol: actor.actorRol,
          actorNombre: actor.actorNombre
        });
        await borrarHistorialReservas(env, [Number(reserva.id || 0)]);
        await db.prepare(`
          DELETE FROM visitantes
          WHERE reserva_id = ?
        `).bind(Number(reserva.id || 0)).run();
        const borrado = await db.prepare(`
          DELETE FROM reservas
          WHERE id = ?
            AND UPPER(TRIM(COALESCE(estado, ''))) IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA')
        `).bind(Number(reserva.id || 0)).run();

        if (Number(borrado?.meta?.changes || 0) > 0) {
          resumen.reservas_eliminadas += 1;
        } else {
          resumen.incidencias.push(`Reserva ${Number(reserva.id || 0)}: no se pudo eliminar.`);
        }
        continue;
      }

      const update = await db.prepare(`
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
          accion: "SUSPENSION_SOLICITANTE_SUPERADMIN",
          estadoOrigen,
          estadoDestino: "RECHAZADA",
          observaciones: motivo,
          actorUsuarioId: actor.actorUsuarioId,
          actorRol: actor.actorRol,
          actorNombre: actor.actorNombre
        });
      } else {
        resumen.incidencias.push(`Reserva ${Number(reserva.id || 0)}: no se pudo actualizar a rechazada.`);
      }
    } catch (error) {
      resumen.incidencias.push(`Reserva ${Number(reserva.id || 0)}: ${error?.message || String(error || "")}`);
    }
  }

  resumen.actividades_afectadas = actividadesSet.size;

  for (const grupo of reservasPorAdmin.values()) {
    const adminEmail = limpiarTexto(grupo.email).toLowerCase();
    if (adminEmail) {
      const correo = construirCorreoAdministradorAfectado(
        { id: grupo.adminId, email: grupo.email, nombre_publico: grupo.nombre, nombre: grupo.nombre },
        usuario,
        accion,
        motivo,
        grupo.reservas
      );
      const envio = await enviarEmail(env, {
        to: adminEmail,
        subject: correo.asunto,
        text: correo.texto,
        html: correo.html
      });
      if (envio?.ok) {
        resumen.administradores_notificados += 1;
      } else if (!envio?.skipped) {
        resumen.incidencias.push(`Correo administrador ${adminEmail}: ${envio?.error || "error desconocido"}`);
      }
    }

    try {
      const notificacion = await crearNotificacionAdministradorAfectado(
        env,
        Number(grupo.adminId || 0),
        usuario,
        accion,
        grupo.reservas
      );
      if (notificacion?.ok) {
        resumen.notificaciones_admin_creadas += 1;
      }
    } catch (error) {
      resumen.incidencias.push(`Notificacion administrador ${grupo.adminId || 0}: ${error?.message || String(error || "")}`);
    }
  }

  return { resumen, reservas };
}

export async function actualizarEstadoUsuarioPublico(env, usuarioId, activo, actor = {}) {
  const usuario = await obtenerUsuarioPublico(env, usuarioId);
  if (!usuario || String(usuario.rol || "").toUpperCase() !== "SOLICITANTE") {
    throw new Error("Usuario publico no encontrado.");
  }

  const activar = Number(activo) === 1;
  const motivo = limpiarTexto(actor?.motivo || "");
  if (!activar && !motivo) {
    throw new Error("Debes indicar observaciones para suspender temporalmente la cuenta.");
  }

  const db = dbPrimaria(env);
  await db.prepare(`
    UPDATE usuarios
    SET activo = ?
    WHERE id = ?
      AND rol = 'SOLICITANTE'
  `).bind(activar ? 1 : 0, Number(usuarioId || 0)).run();

  const resumen = {
    usuario_id: Number(usuarioId || 0),
    usuario_activo: activar ? 1 : 0,
    total_reservas_afectadas: 0,
    reservas_rechazadas: 0,
    reservas_eliminadas: 0,
    borradores_eliminados: 0,
    actividades_afectadas: 0,
    administradores_notificados: 0,
    notificaciones_admin_creadas: 0,
    correo_usuario_enviado: 0,
    incidencias: []
  };

  if (activar) {
    return resumen;
  }

  const impacto = await procesarReservasUsuario(env, usuario, "suspender", motivo, actor);
  Object.assign(resumen, {
    total_reservas_afectadas: impacto.resumen.total_reservas_afectadas,
    reservas_rechazadas: impacto.resumen.reservas_rechazadas,
    reservas_eliminadas: impacto.resumen.reservas_eliminadas,
    borradores_eliminados: impacto.resumen.borradores_eliminados,
    actividades_afectadas: impacto.resumen.actividades_afectadas,
    administradores_notificados: impacto.resumen.administradores_notificados,
    notificaciones_admin_creadas: impacto.resumen.notificaciones_admin_creadas
  });
  resumen.incidencias.push(...impacto.resumen.incidencias);

  const destinatario = limpiarTexto(usuario.email).toLowerCase();
  if (destinatario) {
    const correo = construirCorreoUsuarioPublico(usuario, "suspender", motivo, impacto.reservas);
    const envio = await enviarEmail(env, {
      to: destinatario,
      subject: correo.asunto,
      text: correo.texto,
      html: correo.html
    });
    if (envio?.ok) {
      resumen.correo_usuario_enviado = 1;
    } else if (!envio?.skipped) {
      resumen.incidencias.push(`Correo usuario ${destinatario}: ${envio?.error || "error desconocido"}`);
    }
  }

  return resumen;
}

export async function eliminarUsuarioPublico(env, usuarioId, actor = {}) {
  const usuario = await obtenerUsuarioPublico(env, usuarioId);
  if (!usuario || String(usuario.rol || "").toUpperCase() !== "SOLICITANTE") {
    throw new Error("Usuario publico no encontrado.");
  }

  const motivo = limpiarTexto(actor?.motivo || "");
  if (!motivo) {
    throw new Error("Debes indicar observaciones para eliminar la cuenta del usuario publico.");
  }

  const impacto = await procesarReservasUsuario(env, usuario, "eliminar", motivo, actor);
  const resumen = {
    usuario_id: Number(usuarioId || 0),
    total_reservas_afectadas: impacto.resumen.total_reservas_afectadas,
    reservas_rechazadas: impacto.resumen.reservas_rechazadas,
    reservas_eliminadas: impacto.resumen.reservas_eliminadas,
    borradores_eliminados: impacto.resumen.borradores_eliminados,
    actividades_afectadas: impacto.resumen.actividades_afectadas,
    administradores_notificados: impacto.resumen.administradores_notificados,
    notificaciones_admin_creadas: impacto.resumen.notificaciones_admin_creadas,
    correo_usuario_enviado: 0,
    incidencias: [...impacto.resumen.incidencias]
  };

  const destinatario = limpiarTexto(usuario.email).toLowerCase();
  if (destinatario) {
    const correo = construirCorreoUsuarioPublico(usuario, "eliminar", motivo, impacto.reservas);
    const envio = await enviarEmail(env, {
      to: destinatario,
      subject: correo.asunto,
      text: correo.texto,
      html: correo.html
    });
    if (envio?.ok) {
      resumen.correo_usuario_enviado = 1;
    } else if (!envio?.skipped) {
      resumen.incidencias.push(`Correo usuario ${destinatario}: ${envio?.error || "error desconocido"}`);
    }
  }

  const reservasEliminadasFinal = await eliminarTodasLasReservasDelUsuario(env, usuarioId);
  resumen.reservas_eliminadas += reservasEliminadasFinal;

  await limpiarDependenciasUsuario(env, usuarioId);

  await env.DB.prepare(`
    DELETE FROM usuarios
    WHERE id = ?
      AND rol = 'SOLICITANTE'
  `).bind(Number(usuarioId || 0)).run();

  return resumen;
}
