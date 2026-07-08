import { obtenerCatalogoDocumentosActivosAdmin, resolverDocumentosExigiblesActividad } from "./_actividad_documentacion.js";
import { asegurarColumnasContextoDocumental } from "./_documentacion_contextual.js";
import { obtenerCatalogoDocumentalVinculadoAdmin } from "./_documentacion_propietarios.js";
import { enviarEmail, nombreVisibleAdmin } from "./_email.js";
import { crearNotificacion } from "./_notificaciones.js";

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

function normalizarClaveDocumento(valor) {
  return limpiarTexto(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function normalizarEstadoDocumento(estado) {
  const valor = limpiarTexto(estado)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  if (["VALIDADA", "APROBADA", "APROBADO"].includes(valor)) return "VALIDADO";
  if (valor === "EN REVISION") return "EN_REVISION";
  return valor || "EN_REVISION";
}

function parsearFechaComparable(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return null;
  const fecha = new Date(texto.replace(" ", "T"));
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function calcularEstadoDocumento(doc, entrega) {
  if (!entrega) return "NO_ENVIADO";
  if (Number(entrega.version_documental || 0) !== Number(doc.version_documental || 0)) {
    return "NO_ACTUALIZADO";
  }
  const fechaMarco = parsearFechaComparable(doc.fecha_actualizacion);
  const fechaEntrega = parsearFechaComparable(entrega.fecha_subida);
  if (fechaMarco && fechaEntrega && fechaEntrega < fechaMarco) {
    return "NO_ACTUALIZADO";
  }
  return normalizarEstadoDocumento(entrega.estado);
}

function documentosCumplidos(documentosExigibles = [], archivosPorNombre = new Map()) {
  return (documentosExigibles || []).every((doc) => {
    const propietario = Number(doc?.propietario_id || doc?.admin_id || 0);
    const clave = normalizarClaveDocumento(doc.nombre);
    const entrega = archivosPorNombre.get(`${propietario}::${clave}`) || archivosPorNombre.get(clave) || null;
    return calcularEstadoDocumento(doc, entrega) === "VALIDADO";
  });
}

function construirEmailTexto({ actividad, admin }) {
  return [
    "La documentación preceptiva de una actividad ha sido actualizada.",
    "",
    `Actividad disponible para su solicitud: ${actividad.nombre}`,
    `Organizador: ${nombreVisibleAdmin(admin)}`,
    "",
    "Con la documentación que ya tienes presentada y aprobada, ahora puedes solicitar esta actividad.",
    "",
    "IMPORTANTE: Debe volver a realizar la solicitud de la actividad en la que se va a participar.",
    "",
    "Puedes acceder a la plataforma para realizar la solicitud."
  ].join("\n");
}

function construirEmailHtml({ actividad, admin }) {
  return `
    <p>La documentación preceptiva de una actividad ha sido actualizada.</p>
    <div style="margin:14px 0;padding:14px 16px;border-radius:8px;border:1px solid #cfe1f5;background:#f3f8ff;color:#173b62;">
      <p style="margin:0 0 10px;"><strong>Actividad disponible para su solicitud</strong></p>
      <table style="border-collapse:collapse;width:100%;max-width:760px;background:#ffffff;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#edf4fb;">Actividad</th>
            <th style="text-align:left;padding:8px 10px;border:1px solid #d8e0e8;background:#edf4fb;">Organizador</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(actividad.nombre)}</td>
            <td style="padding:8px 10px;border:1px solid #d8e0e8;">${escaparHtml(nombreVisibleAdmin(admin))}</td>
          </tr>
        </tbody>
      </table>
      <p style="margin:12px 0 0;">Con la documentación que ya tienes presentada y aprobada, ahora puedes solicitar esta actividad.</p>
      <div style="margin:12px 0 0;padding:10px 12px;border-radius:8px;border:1px solid #f0d28a;background:#fff6df;color:#7a4c00;">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-right:8px;border-radius:999px;background:#f5b400;color:#1f1f1f;font-weight:700;">!</span>
        <strong>Debe volver a realizar la solicitud de la actividad en la que se va a participar.</strong>
      </div>
    </div>
    <p>Puedes acceder a la plataforma para realizar la solicitud.</p>
  `;
}

async function obtenerActividadNotificable(env, actividadId, adminId) {
  return await env.DB.prepare(`
    SELECT
      a.id,
      a.admin_id,
      COALESCE(NULLIF(TRIM(a.titulo_publico), ''), NULLIF(TRIM(a.nombre), ''), 'Actividad') AS nombre,
      COALESCE(a.activa, 0) AS activa,
      COALESCE(a.visible_portal, 0) AS visible_portal,
      COALESCE(a.requiere_reserva, 0) AS requiere_reserva,
      u.id AS admin_usuario_id,
      u.nombre AS admin_nombre,
      u.nombre_publico AS admin_nombre_publico,
      u.localidad AS admin_localidad
    FROM actividades a
    INNER JOIN usuarios u ON u.id = a.admin_id
    WHERE a.id = ?
      AND a.admin_id = ?
      AND COALESCE(a.activa, 0) = 1
      AND COALESCE(a.visible_portal, 0) = 1
      AND COALESCE(a.requiere_reserva, 0) = 1
      AND (
        a.fecha_fin IS NULL
        OR date(a.fecha_fin) >= date('now')
      )
    LIMIT 1
  `).bind(actividadId, adminId).first();
}

function obtenerPropietariosDocumentos(documentos = [], adminIdFallback = 0) {
  const ids = new Set();
  for (const doc of documentos || []) {
    const propietario = Number(doc?.propietario_id || doc?.admin_id || adminIdFallback || 0);
    if (propietario > 0) ids.add(propietario);
  }
  return Array.from(ids);
}

async function obtenerExpedientesConArchivos(env, actividadId, documentos = [], adminIdFallback = 0) {
  await asegurarColumnasContextoDocumental(env);
  const propietarios = obtenerPropietariosDocumentos(documentos, adminIdFallback);
  if (!propietarios.length || !(Number(actividadId || 0) > 0)) {
    return { expedientes: [], archivosPorExpediente: new Map() };
  }
  const placeholders = propietarios.map(() => "?").join(", ");
  const expedientesRows = await env.DB.prepare(`
    SELECT
      cad.id,
      cad.admin_id,
      cad.centro_usuario_id,
      u.centro,
      u.email
    FROM centro_admin_documentacion cad
    INNER JOIN usuarios u ON u.id = cad.centro_usuario_id
    WHERE cad.admin_id IN (${placeholders})
      AND cad.actividad_id = ?
      AND cad.reserva_id IS NULL
      AND u.rol = 'SOLICITANTE'
      AND COALESCE(u.activo, 1) = 1
  `).bind(...propietarios, Number(actividadId || 0)).all();

  const expedientesBase = (expedientesRows?.results || [])
    .map((row) => ({
      id: Number(row.id || 0),
      admin_id: Number(row.admin_id || 0),
      centro_usuario_id: Number(row.centro_usuario_id || 0),
      centro: limpiarTexto(row.centro || "Usuario público"),
      email: limpiarTexto(row.email || "")
    }))
    .filter((row) => row.id > 0 && row.admin_id > 0 && row.centro_usuario_id > 0 && row.email);

  const expedientesPorUsuario = new Map();
  const archivosPorExpediente = new Map();
  for (const expediente of expedientesBase) {
    if (!expedientesPorUsuario.has(expediente.centro_usuario_id)) {
      expedientesPorUsuario.set(expediente.centro_usuario_id, {
        ...expediente,
        ids_expedientes: []
      });
    }
    const expedienteUsuario = expedientesPorUsuario.get(expediente.centro_usuario_id);
    expedienteUsuario.ids_expedientes.push(expediente.id);
    if (!archivosPorExpediente.has(expedienteUsuario.id)) {
      archivosPorExpediente.set(expedienteUsuario.id, new Map());
    }
    const mapaArchivosUsuario = archivosPorExpediente.get(expedienteUsuario.id);
    const archivosRows = await env.DB.prepare(`
      SELECT nombre_documento, version_documental, estado, fecha_subida
      FROM centro_admin_documentacion_archivos
      WHERE documentacion_id = ?
        AND activo = 1
    `).bind(expediente.id).all();
    for (const archivo of archivosRows?.results || []) {
      const clave = normalizarClaveDocumento(archivo.nombre_documento);
      mapaArchivosUsuario.set(clave, archivo);
      mapaArchivosUsuario.set(`${expediente.admin_id}::${clave}`, archivo);
    }
  }

  return { expedientes: Array.from(expedientesPorUsuario.values()), archivosPorExpediente };
}

async function obtenerUsuariosConReservaVivaActividad(env, actividadId) {
  const rows = await env.DB.prepare(`
    SELECT DISTINCT usuario_id
    FROM reservas
    WHERE actividad_id = ?
      AND estado NOT IN ('RECHAZADA', 'CANCELADA', 'ANULADA')
  `).bind(actividadId).all();

  return new Set(
    (rows?.results || [])
      .map((row) => Number(row.usuario_id || 0))
      .filter((id) => id > 0)
  );
}

export async function notificarNuevosSolicitantesHabilitadosPorDocumentacionActividad(env, {
  actividadId,
  adminId,
  configuracionAnterior,
  configuracionNueva,
  baseUrl = ""
} = {}) {
  const actividadNumerica = Number(actividadId || 0);
  const adminNumerico = Number(adminId || 0);
  if (!(actividadNumerica > 0) || !(adminNumerico > 0)) {
    return { ok: false, error: "Faltan identificadores de actividad o administrador." };
  }

  const actividadRow = await obtenerActividadNotificable(env, actividadNumerica, adminNumerico);
  if (!actividadRow) {
    return { ok: true, skipped: true, motivo: "Actividad no notificable.", notificados: 0 };
  }

  const catalogo = await obtenerCatalogoDocumentalVinculadoAdmin(
    env,
    adminNumerico,
    await obtenerCatalogoDocumentosActivosAdmin(env, adminNumerico)
  );
  const docsAnteriores = resolverDocumentosExigiblesActividad(catalogo, configuracionAnterior);
  const docsNuevos = resolverDocumentosExigiblesActividad(catalogo, configuracionNueva);
  if (docsAnteriores.length === docsNuevos.length) {
    const firmaAnterior = docsAnteriores.map((doc) => Number(doc.id || 0) > 0 ? `ID:${Number(doc.id || 0)}` : normalizarClaveDocumento(doc.nombre)).sort().join("|");
    const firmaNueva = docsNuevos.map((doc) => Number(doc.id || 0) > 0 ? `ID:${Number(doc.id || 0)}` : normalizarClaveDocumento(doc.nombre)).sort().join("|");
    if (firmaAnterior === firmaNueva) {
      return { ok: true, skipped: true, motivo: "No hay cambio efectivo de documentos exigibles.", notificados: 0 };
    }
  }

  const [{ expedientes, archivosPorExpediente }, usuariosConReservaViva] = await Promise.all([
    obtenerExpedientesConArchivos(env, actividadNumerica, docsNuevos, adminNumerico),
    obtenerUsuariosConReservaVivaActividad(env, actividadNumerica)
  ]);
  const admin = {
    id: Number(actividadRow.admin_usuario_id || actividadRow.admin_id || 0),
    nombre: actividadRow.admin_nombre || "",
    nombre_publico: actividadRow.admin_nombre_publico || "",
    localidad: actividadRow.admin_localidad || ""
  };
  const actividad = {
    id: Number(actividadRow.id || 0),
    nombre: limpiarTexto(actividadRow.nombre || "Actividad")
  };

  let notificados = 0;
  let omitidos = 0;
  const errores = [];

  for (const expediente of expedientes) {
    if (usuariosConReservaViva.has(expediente.centro_usuario_id)) {
      omitidos += 1;
      continue;
    }

    const archivosMap = archivosPorExpediente.get(expediente.id) || new Map();
    const cumpliaAntes = documentosCumplidos(docsAnteriores, archivosMap);
    const cumpleAhora = documentosCumplidos(docsNuevos, archivosMap);
    if (cumpliaAntes || !cumpleAhora) {
      omitidos += 1;
      continue;
    }

    const asunto = `[Documentación] Actividad disponible para solicitud - ${actividad.nombre}`;
    const payload = { actividad, admin };
    const correo = await enviarEmail(env, {
      to: expediente.email,
      subject: asunto,
      text: construirEmailTexto(payload),
      html: construirEmailHtml(payload),
      dedupe: true,
      dedupeSegundos: 900
    });
    if (correo.ok || correo.skipped) {
      notificados += correo.ok ? 1 : 0;
      await crearNotificacion(env, {
        usuarioId: expediente.centro_usuario_id,
        rolDestino: "SOLICITANTE",
        tipo: "DOCUMENTACION",
        titulo: "Actividad disponible para solicitud",
        mensaje: `Con tu documentación aprobada ya puedes solicitar ${actividad.nombre}.`,
        urlDestino: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/portal.html` : "/portal.html",
        dedupeSegundos: 900
      });
    } else {
      errores.push({
        centro_usuario_id: expediente.centro_usuario_id,
        email: expediente.email,
        error: correo.error || ""
      });
    }
  }

  return {
    ok: errores.length === 0,
    actividad_id: actividad.id,
    admin_id: adminNumerico,
    notificados,
    omitidos,
    errores
  };
}
