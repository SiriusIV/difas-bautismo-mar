import { crearNotificacion } from "../_notificaciones.js";
import { enviarEmail } from "../_email.js";
import { registrarEventoReserva } from "../_reservas_historial.js";
import { rechazarReservasPorAnulacionActividad } from "./actividades-eliminar.js";

export const MOTIVO_DESACTIVACION_ADMIN = "Actividad desactivada automáticamente por inactividad del administrador responsable.";
export const MOTIVO_ELIMINACION_ADMIN = "Actividad suspendida por eliminación del administrador responsable.";

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

function normalizarListaTexto(valor) {
  if (Array.isArray(valor)) {
    return valor.map((item) => limpiarTexto(item)).filter(Boolean);
  }
  const texto = limpiarTexto(valor);
  if (!texto) return [];
  if (texto.startsWith("[")) {
    try {
      const parseado = JSON.parse(texto);
      if (Array.isArray(parseado)) {
        return parseado.map((item) => limpiarTexto(item)).filter(Boolean);
      }
    } catch (_) {
      // sigue con fallback textual
    }
  }
  return texto
    .split(/\r?\n+/)
    .map((item) => limpiarTexto(item))
    .filter(Boolean);
}

function dbPrimaria(env) {
  if (typeof env?.DB?.withSession === "function") {
    return env.DB.withSession("first-primary");
  }
  return env.DB;
}

function actividadSigueVigente(actividad) {
  const tipo = limpiarTexto(actividad?.tipo).toUpperCase();
  if (tipo === "PERMANENTE") return true;
  if (tipo === "PENDIENTE") return true;

  const fechaFin = limpiarTexto(actividad?.fecha_fin);
  if (!fechaFin) return true;

  const hoy = new Date();
  const isoHoy = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
  return fechaFin >= isoHoy;
}

function actividadPublicadaYVigente(actividad) {
  return Number(actividad?.activa || 0) === 1 &&
    Number(actividad?.visible_portal || 0) === 1 &&
    actividadSigueVigente(actividad);
}

async function asegurarColumnaUsuarioAdmin(db, nombre, definicion) {
  try {
    await db.prepare(`ALTER TABLE usuarios ADD COLUMN ${nombre} ${definicion}`).run();
  } catch (error) {
    const detalle = String(error?.message || "").toLowerCase();
    if (
      detalle.includes("duplicate column name") ||
      detalle.includes("duplicate") ||
      detalle.includes("already exists")
    ) {
      return;
    }
    throw error;
  }
}

async function obtenerAdministrador(env, adminId) {
  return await env.DB.prepare(`
    SELECT
      id,
      nombre,
      nombre_publico,
      email,
      centro,
      localidad,
      telefono_contacto,
      responsable_legal,
      cargo_puesto,
      tipo_documento,
      documento_identificacion,
      activo,
      rol,
      fecha_alta
    FROM usuarios
    WHERE id = ?
    LIMIT 1
  `).bind(adminId).first();
}

export async function listarAdministradores(env) {
  await asegurarColumnaUsuarioAdmin(env.DB, "cargo_puesto", "TEXT");
  await asegurarColumnaUsuarioAdmin(env.DB, "nombre_publico", "TEXT");

  const actividades = await env.DB.prepare(`
    SELECT *
    FROM actividades
    WHERE admin_id IS NOT NULL
    ORDER BY id ASC
  `).all();

  const actividadesPorAdmin = new Map();
  for (const actividad of (actividades.results || [])) {
    const adminId = Number(actividad.admin_id || 0);
    if (!actividadesPorAdmin.has(adminId)) {
      actividadesPorAdmin.set(adminId, []);
    }
    actividadesPorAdmin.get(adminId).push({
      actividad_id: Number(actividad.id || 0),
      actividad_nombre: actividad.titulo_publico || actividad.nombre || "Actividad",
      nombre: actividad.nombre || "",
      titulo_publico: actividad.titulo_publico || "",
      subtitulo_publico: actividad.subtitulo_publico || "",
      organizador_publico: actividad.organizador_publico || "",
      organizador_web_externa_url: actividad.organizador_web_externa_url || "",
      organizador_web_externa_activa: Number(actividad.organizador_web_externa_activa ?? 1) === 1 ? 1 : 0,
      lugar: actividad.lugar || "",
      provincia: actividad.provincia || "",
      tipo: actividad.tipo || "",
      fecha_inicio: actividad.fecha_inicio || "",
      fecha_fin: actividad.fecha_fin || "",
      descripcion_corta: actividad.descripcion_corta || "",
      descripcion_larga: actividad.descripcion_larga || "",
      imagen_url: actividad.imagen_url || "",
      latitud: actividad.latitud ?? "",
      longitud: actividad.longitud ?? "",
      direccion_postal: actividad.direccion_postal || "",
      usa_franjas: Number(actividad.usa_franjas || 0) === 1 ? 1 : 0,
      requiere_reserva: Number(actividad.requiere_reserva || 0) === 1 ? 1 : 0,
      aforo_limitado: Number(actividad.aforo_limitado || 0) === 1 ? 1 : 0,
      plazas_totales: Number(actividad.plazas_totales || 0),
      requisitos_particulares: normalizarListaTexto(actividad.requisitos_particulares),
      activa: Number(actividad.activa || 0) === 1 ? 1 : 0,
      visible_portal: Number(actividad.visible_portal || 0) === 1 ? 1 : 0,
      publicada_vigente: actividadPublicadaYVigente(actividad) ? 1 : 0
    });
  }

  const rows = await env.DB.prepare(`
    SELECT *
    FROM usuarios
    WHERE rol = 'ADMIN'
    ORDER BY UPPER(COALESCE(NULLIF(TRIM(nombre), ''), email)) ASC
  `).all();

  return (rows.results || []).map((row) => ({
    id: Number(row.id || 0),
    nombre: row.nombre || "",
    nombre_publico: row.nombre_publico || "",
    email: row.email || "",
    centro: row.centro || "",
    localidad: row.localidad || "",
    telefono_contacto: row.telefono_contacto || "",
    responsable_legal: row.responsable_legal || "",
    cargo_puesto: row.cargo_puesto || "",
    tipo_documento: row.tipo_documento || "",
    documento_identificacion: row.documento_identificacion || "",
    activo: Number(row.activo || 0) === 1 ? 1 : 0,
    fecha_alta: row.fecha_alta || "",
    actividades: actividadesPorAdmin.get(Number(row.id || 0)) || [],
    actividades_publicadas: (actividadesPorAdmin.get(Number(row.id || 0)) || []).filter((item) => Number(item.publicada_vigente || 0) === 1).length
  }));
}

function construirCorreoBloqueoAdministrador(admin, motivo) {
  const nombre = limpiarTexto(admin?.nombre || "administrador");
  const texto = [
    `Hola ${nombre},`,
    "",
    "Tu sesión de administrador ha sido bloqueada temporalmente por el superadministrador.",
    "",
    `Observaciones: ${motivo}`,
    "",
    "Mientras la cuenta permanezca inactiva no podrás acceder al panel."
  ].join("\n");

  const html = `
    <p>Hola ${escapeHtml(nombre)},</p>
    <p>Tu sesión de administrador ha sido bloqueada temporalmente por el superadministrador.</p>
    <p><strong>Observaciones:</strong> ${escapeHtml(motivo)}</p>
    <p>Mientras la cuenta permanezca inactiva no podrás acceder al panel.</p>
  `;

  return {
    asunto: "Bloqueo temporal de sesión de administrador",
    texto,
    html
  };
}

async function obtenerActividadesAdministrador(env, adminId) {
  const rows = await env.DB.prepare(`
    SELECT *
    FROM actividades
    WHERE admin_id = ?
    ORDER BY id ASC
  `).bind(adminId).all();

  return rows.results || [];
}

async function borrarActividadFisicamente(env, actividadId) {
  await env.DB.prepare(`
    DELETE FROM visitantes
    WHERE reserva_id IN (
      SELECT id
      FROM reservas
      WHERE actividad_id = ?
    )
  `).bind(actividadId).run();

  await env.DB.prepare(`
    DELETE FROM reservas
    WHERE actividad_id = ?
  `).bind(actividadId).run();

  await env.DB.prepare(`
    DELETE FROM franjas
    WHERE actividad_id = ?
  `).bind(actividadId).run();

  try {
    await env.DB.prepare(`
      DELETE FROM actividad_requisitos
      WHERE actividad_id = ?
    `).bind(actividadId).run();
  } catch (_) {
    // tabla opcional
  }

  try {
    await env.DB.prepare(`
      DELETE FROM actividad_documentacion
      WHERE actividad_id = ?
    `).bind(actividadId).run();
  } catch (_) {
    // tabla opcional
  }

  await env.DB.prepare(`
    DELETE FROM actividades
    WHERE id = ?
  `).bind(actividadId).run();
}

async function obtenerReservasRechazadasPorDesactivacion(env, actividadId) {
  const rows = await env.DB.prepare(`
    SELECT
      r.id,
      r.usuario_id,
      r.codigo_reserva,
      r.contacto,
      COALESCE(NULLIF(TRIM(r.email), ''), NULLIF(TRIM(us.email), '')) AS email,
      r.estado,
      COALESCE(a.organizador_publico, 'Organizador') AS organizador_nombre,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios us
      ON us.id = r.usuario_id
    WHERE r.actividad_id = ?
      AND UPPER(TRIM(COALESCE(r.estado, ''))) = 'RECHAZADA'
      AND TRIM(COALESCE(r.observaciones_admin, '')) = ?
    ORDER BY r.id ASC
  `).bind(actividadId, MOTIVO_DESACTIVACION_ADMIN).all();

  return rows.results || [];
}

function construirCorreoActividadReactivada(reserva) {
  const actividad = limpiarTexto(reserva?.actividad_nombre || "la actividad");
  const codigo = limpiarTexto(reserva?.codigo_reserva || "");
  const organizador = limpiarTexto(reserva?.organizador_nombre || "el organizador");
  const contacto = limpiarTexto(reserva?.contacto || "");
  const saludo = contacto ? `Hola ${contacto},` : "Hola,";
  const mensaje = `La actividad ${actividad}${codigo ? ` asociada a tu solicitud (${codigo})` : ""} ha sido reactivada por ${organizador}. Tu solicitud vuelve a quedar suspendida para que puedas revisarla desde tu panel.`;

  const texto = [
    saludo,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Organiza: ${organizador}`,
    "",
    "Puedes consultar el estado actualizado desde tu panel de usuario."
  ].filter(Boolean).join("\n");

  const html = `
    <p>${escapeHtml(saludo)}</p>
    <p>${escapeHtml(mensaje)}</p>
    <p><strong>Actividad:</strong> ${escapeHtml(actividad)}</p>
    ${codigo ? `<p><strong>Código de solicitud:</strong> ${escapeHtml(codigo)}</p>` : ""}
    <p><strong>Organiza:</strong> ${escapeHtml(organizador)}</p>
    <p>Puedes consultar el estado actualizado desde tu panel de usuario.</p>
  `;

  return {
    asunto: "[Reservas] Actividad reactivada",
    texto,
    html
  };
}

async function notificarReservaReactivadaPorAdministrador(env, reserva, actor = {}) {
  const usuarioId = Number(reserva?.usuario_id || 0);
  if (usuarioId > 0) {
    try {
      await crearNotificacion(env, {
        usuarioId,
        rolDestino: "SOLICITANTE",
        tipo: "RESERVA",
        titulo: "Actividad reactivada",
        mensaje: `La actividad ${limpiarTexto(reserva?.actividad_nombre || "la actividad")}${limpiarTexto(reserva?.codigo_reserva) ? ` asociada a tu solicitud (${limpiarTexto(reserva.codigo_reserva)})` : ""} ha sido reactivada. Tu solicitud vuelve a quedar suspendida para que puedas revisarla desde tu panel.`,
        urlDestino: "/usuario-panel.html"
      });
    } catch (_) {
      // No bloquear por fallo de notificación interna.
    }
  }

  const destinatario = limpiarTexto(reserva?.email || "");
  if (destinatario) {
    const correo = construirCorreoActividadReactivada(reserva);
    try {
      await enviarEmail(env, {
        to: destinatario,
        subject: correo.asunto,
        text: correo.texto,
        html: correo.html
      });
    } catch (_) {
      // No bloquear por fallo de correo.
    }
  }

  await registrarEventoReserva(env, {
    reservaId: reserva.id,
    accion: "REACTIVACION_ADMINISTRADOR",
    estadoOrigen: "RECHAZADA",
    estadoDestino: "SUSPENDIDA",
    observaciones: "Solicitud reactivada tras la reactivación del administrador responsable.",
    actorUsuarioId: actor.actorUsuarioId,
    actorRol: actor.actorRol,
    actorNombre: actor.actorNombre
  });
}

function actividadEsReactivable(actividad) {
  const borradorTecnico = Number(actividad?.borrador_tecnico || 0) === 1;
  if (borradorTecnico) return false;

  const tipo = limpiarTexto(actividad?.tipo).toUpperCase();
  if (tipo === "PERMANENTE") return true;

  return actividadSigueVigente(actividad);
}

export async function actualizarEstadoAdministrador(env, adminId, activo, actor = {}) {
  await asegurarColumnaUsuarioAdmin(env.DB, "cargo_puesto", "TEXT");
  await asegurarColumnaUsuarioAdmin(env.DB, "nombre_publico", "TEXT");
  const admin = await obtenerAdministrador(env, adminId);
  if (!admin || String(admin.rol || "").toUpperCase() !== "ADMIN") {
    throw new Error("Administrador no encontrado.");
  }

  const db = dbPrimaria(env);
  const actividades = await obtenerActividadesAdministrador(env, adminId);
  const activar = Number(activo) === 1;
  const motivo = limpiarTexto(actor?.motivo || "");

  if (!activar && !motivo) {
    throw new Error("Debes indicar observaciones para bloquear temporalmente la sesión.");
  }

  await db.prepare(`
    UPDATE usuarios
    SET activo = ?
    WHERE id = ?
      AND rol = 'ADMIN'
  `).bind(activar ? 1 : 0, adminId).run();

  const resumen = {
    administrador_id: Number(adminId),
    administrador_activo: activar ? 1 : 0,
    actividades_totales: actividades.length,
    actividades_actualizadas: 0,
    actividades_reactivadas: 0,
    reservas_afectadas: 0,
    correos_enviados: 0
  };

  if (!activar) {
    const destinatario = limpiarTexto(admin.email);
    if (destinatario) {
      const correo = construirCorreoBloqueoAdministrador(admin, motivo);
      await enviarEmail(env, {
        to: destinatario,
        subject: correo.asunto,
        text: correo.texto,
        html: correo.html
      });
    }

    for (const actividad of actividades) {
      if (Number(actividad.activa || 0) !== 1 && Number(actividad.visible_portal || 0) !== 1) {
        continue;
      }

      await db.prepare(`
        UPDATE actividades
        SET activa = 0,
            visible_portal = 0
        WHERE id = ?
      `).bind(Number(actividad.id)).run();

      resumen.actividades_actualizadas += 1;

      const rechazo = await rechazarReservasPorAnulacionActividad(
        env,
        Number(actividad.id),
        MOTIVO_DESACTIVACION_ADMIN,
        actor
      );
      resumen.reservas_afectadas += Number(rechazo.actualizadas || 0);
      resumen.correos_enviados += Number(rechazo.correos_enviados || 0);
    }

    return resumen;
  }

  for (const actividad of actividades) {
    if (!actividadEsReactivable(actividad)) {
      continue;
    }

    if (Number(actividad.activa || 0) !== 1 || Number(actividad.visible_portal || 0) !== 1) {
      await db.prepare(`
        UPDATE actividades
        SET activa = 1,
            visible_portal = 1
        WHERE id = ?
      `).bind(Number(actividad.id)).run();
      resumen.actividades_reactivadas += 1;
    }

    const reservas = await obtenerReservasRechazadasPorDesactivacion(env, Number(actividad.id));
    for (const reserva of reservas) {
      await db.prepare(`
        UPDATE reservas
        SET estado = 'SUSPENDIDA',
            observaciones_admin = '',
            fecha_modificacion = datetime('now')
        WHERE id = ?
          AND UPPER(TRIM(COALESCE(estado, ''))) = 'RECHAZADA'
      `).bind(Number(reserva.id)).run();

      await notificarReservaReactivadaPorAdministrador(env, reserva, actor);
      resumen.reservas_afectadas += 1;
      resumen.correos_enviados += limpiarTexto(reserva.email) ? 1 : 0;
    }
  }

  return resumen;
}

export async function eliminarAdministrador(env, adminId, actor = {}) {
  await asegurarColumnaUsuarioAdmin(env.DB, "nombre_publico", "TEXT");
  const admin = await obtenerAdministrador(env, adminId);
  if (!admin || String(admin.rol || "").toUpperCase() !== "ADMIN") {
    throw new Error("Administrador no encontrado.");
  }

  const actividades = await obtenerActividadesAdministrador(env, adminId);
  const resumen = {
    administrador_id: Number(adminId),
    actividades_eliminadas: 0,
    reservas_afectadas: 0,
    correos_enviados: 0
  };

  for (const actividad of actividades) {
    const rechazo = await rechazarReservasPorAnulacionActividad(
      env,
      Number(actividad.id),
      MOTIVO_ELIMINACION_ADMIN,
      actor
    );
    resumen.reservas_afectadas += Number(rechazo.actualizadas || 0);
    resumen.correos_enviados += Number(rechazo.correos_enviados || 0);

    await borrarActividadFisicamente(env, Number(actividad.id));
    resumen.actividades_eliminadas += 1;
  }

  await env.DB.prepare(`
    DELETE FROM usuarios
    WHERE id = ?
      AND rol = 'ADMIN'
  `).bind(adminId).run();

  return resumen;
}
