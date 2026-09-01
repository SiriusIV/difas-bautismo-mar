import { registrarEventoReserva } from "./_reservas_historial.js";
import { asegurarColumnaAforoMaximo, obtenerBloqueoActividadSinFranja } from "./_actividades_aforo.js";
import { asegurarColumnaRechazoBloqueado, asegurarColumnaRechazoEliminaEn } from "./_reservas_rechazo_plazo.js";
import { crearNotificacion } from "./_notificaciones.js";
import { enviarEmail, nombreVisibleAdmin } from "./_email.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    ...init
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim().replace(/\s+/g, " ");
}

function escaparHtml(valor) {
  return String(valor || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizarDocumentoIdentidad(valor) {
  return String(valor || "").trim().toUpperCase().replace(/[\s-]/g, "");
}

function documentoIdentidadValido(valor) {
  const normalizado = normalizarDocumentoIdentidad(valor);
  if (!normalizado) return true;
  return /^[0-9]{8}[A-Z]$/.test(normalizado) || /^[XYZ][0-9]{7}[A-Z]$/.test(normalizado);
}

function emailValido(valor) {
  const normalizado = limpiarTexto(valor);
  if (!normalizado) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizado);
}

function normalizarClaveNombre(valor) {
  return limpiarTexto(valor).toLowerCase();
}

function tieneDatosAmpliatorios(visitante) {
  return !!limpiarTexto(visitante?.observaciones);
}

function firmaDatosAmpliatorios(visitante) {
  return JSON.stringify({
    observaciones: limpiarTexto(visitante?.observaciones)
  });
}

function normalizarPerfilAsistente(valor) {
  const v = String(valor || "").trim().toUpperCase();
  if (!v) return "";
  if (v === "ALUMNO") return "ALUMNO";
  if (v === "RESPONSABLE_GRUPO") return "RESPONSABLE_GRUPO";
  if (v === "GENERAL") return "GENERAL";
  if (v === "PROFESOR") return "RESPONSABLE_GRUPO";
  return "";
}

function normalizarCategoriaEdad(valor) {
  const v = String(valor || "").trim().toUpperCase();
  if (!v) return "";
  if (v === "DE_3_A_5") return "DE_3_A_5";
  if (v === "DE_6_A_9" || v === "DE_6_A_10" || v === "MENOR_10") return "DE_6_A_9";
  if (v === "DE_10_A_14" || v === "DE_10_A_15") return "DE_10_A_14";
  if (v === "DE_15_A_18" || v === "MAYOR_DE_15") return "DE_15_A_18";
  if (v === "MAYOR_DE_18") return "MAYOR_DE_18";
  return "";
}

function normalizarNivelEnsenanza(valor) {
  const v = String(valor || "").trim().toUpperCase();
  if (!v) return "";
  if (v === "NO_CORRESPONDE") return "NO_CORRESPONDE";
  if (v === "PREESCOLAR") return "PREESCOLAR";
  if (v === "INFANTIL") return "INFANTIL";
  if (v === "PRIMARIA") return "PRIMARIA";
  if (v === "SECUNDARIA") return "SECUNDARIA";
  if (v === "BACHILLER_FP") return "BACHILLER_FP";
  if (v === "ESTUDIOS_SUPERIORES") return "ESTUDIOS_SUPERIORES";
  return "";
}

async function asegurarEsquemaVisitantes(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS visitantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reserva_id INTEGER NOT NULL,
      nombre_completo TEXT NOT NULL,
      tipo_asistente TEXT,
      perfil_asistente TEXT,
      nivel_ensenanza TEXT,
      categoria_edad TEXT,
      nacionalidad TEXT,
      dni TEXT,
      email TEXT,
      doble_nacionalidad INTEGER NOT NULL DEFAULT 0,
      segunda_nacionalidad TEXT,
      nacionalidad_no_consta INTEGER NOT NULL DEFAULT 0,
      observaciones TEXT,
      observaciones_revision_estado TEXT
    )
  `).run();

  const columnas = await listarColumnasVisitantes(env);
  const alterPendientes = [];
  if (!columnas.includes("perfil_asistente")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN perfil_asistente TEXT`);
  }
  if (!columnas.includes("nivel_ensenanza")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN nivel_ensenanza TEXT`);
  }
  if (!columnas.includes("nacionalidad")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN nacionalidad TEXT`);
  }
  if (!columnas.includes("dni")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN dni TEXT`);
  }
  if (!columnas.includes("email")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN email TEXT`);
  }
  if (!columnas.includes("doble_nacionalidad")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN doble_nacionalidad INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columnas.includes("segunda_nacionalidad")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN segunda_nacionalidad TEXT`);
  }
  if (!columnas.includes("nacionalidad_no_consta")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN nacionalidad_no_consta INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columnas.includes("observaciones")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN observaciones TEXT`);
  }
  if (!columnas.includes("observaciones_revision_estado")) {
    alterPendientes.push(`ALTER TABLE visitantes ADD COLUMN observaciones_revision_estado TEXT`);
  }
  for (const sentencia of alterPendientes) {
    await env.DB.prepare(sentencia).run();
  }
}

async function obtenerReservaPorToken(env, tokenEdicion) {
  const sql = `
    SELECT
      r.id,
      r.codigo_reserva,
      r.estado,
      COALESCE(r.rechazo_bloqueado, 0) AS rechazo_bloqueado,
      COALESCE(r.rechazo_elimina_en, '') AS rechazo_elimina_en,
      r.franja_id,
      r.actividad_id,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      r.usuario_id,
      r.centro,
      r.contacto,
      COALESCE(a.titulo_publico, a.nombre, 'Actividad') AS actividad_nombre,
      a.admin_id,
      u.email AS admin_email,
      u.nombre AS admin_nombre,
      u.nombre_publico AS admin_nombre_publico,
      u.localidad AS admin_localidad,
      COALESCE(a.usa_franjas, 1) AS usa_franjas,
      COALESCE(a.aforo_limitado, 0) AS aforo_limitado,
      COALESCE(a.aforo_maximo, 0) AS aforo_maximo
    FROM reservas r
    LEFT JOIN actividades a
      ON a.id = r.actividad_id
    LEFT JOIN usuarios u
      ON u.id = a.admin_id
    WHERE r.token_edicion = ?
    LIMIT 1
  `;

  const db = env.DB.withSession("first-primary");
  return await db.prepare(sql).bind(tokenEdicion).first();
}

async function obtenerCapacidadFranja(env, franjaId) {
  const row = await env.DB.prepare(`
    SELECT id, capacidad
    FROM franjas
    WHERE id = ?
    LIMIT 1
  `).bind(franjaId).first();

  return row || null;
}

async function listarColumnasVisitantes(env) {
  const result = await env.DB.prepare(`PRAGMA table_info(visitantes)`).all();
  return (result.results || []).map((c) => String(c.name || ""));
}

async function borrarVisitantesDeReserva(env, reservaId) {
  return await env.DB.prepare(`
    DELETE FROM visitantes
    WHERE reserva_id = ?
  `).bind(reservaId).run();
}

async function obtenerVisitantesPrevios(env, reservaId, columnasVisitantes) {
  const seleccionar = [
    "nombre_completo",
    columnasVisitantes.includes("nacionalidad") ? "COALESCE(nacionalidad, '') AS nacionalidad" : "'' AS nacionalidad",
    columnasVisitantes.includes("dni") ? "COALESCE(dni, '') AS dni" : "'' AS dni",
    columnasVisitantes.includes("email") ? "COALESCE(email, '') AS email" : "'' AS email",
    columnasVisitantes.includes("doble_nacionalidad") ? "COALESCE(doble_nacionalidad, 0) AS doble_nacionalidad" : "0 AS doble_nacionalidad",
    columnasVisitantes.includes("segunda_nacionalidad") ? "COALESCE(segunda_nacionalidad, '') AS segunda_nacionalidad" : "'' AS segunda_nacionalidad",
    columnasVisitantes.includes("observaciones") ? "COALESCE(observaciones, '') AS observaciones" : "'' AS observaciones",
    columnasVisitantes.includes("observaciones_revision_estado") ? "COALESCE(observaciones_revision_estado, '') AS observaciones_revision_estado" : "'' AS observaciones_revision_estado"
  ];
  const result = await env.DB.prepare(`
    SELECT ${seleccionar.join(", ")}
    FROM visitantes
    WHERE reserva_id = ?
  `).bind(reservaId).all();
  return result.results || [];
}

async function insertarVisitante(env, reservaId, visitante, columnasVisitantes) {
  const columnas = ["reserva_id", "nombre_completo"];
  const bind = [reservaId, visitante.nombre_completo];

  if (columnasVisitantes.includes("tipo_asistente")) {
    columnas.push("tipo_asistente");
    bind.push(visitante.perfil_asistente === "ALUMNO" ? "ALUMNO" : "PROFESOR");
  }
  if (columnasVisitantes.includes("perfil_asistente")) {
    columnas.push("perfil_asistente");
    bind.push(visitante.perfil_asistente);
  }
  if (columnasVisitantes.includes("nivel_ensenanza")) {
    columnas.push("nivel_ensenanza");
    bind.push(visitante.nivel_ensenanza);
  }
  if (columnasVisitantes.includes("nacionalidad")) {
    columnas.push("nacionalidad");
    bind.push(visitante.nacionalidad);
  }
  if (columnasVisitantes.includes("dni")) {
    columnas.push("dni");
    bind.push(visitante.dni);
  }
  if (columnasVisitantes.includes("email")) {
    columnas.push("email");
    bind.push(visitante.email);
  }
  if (columnasVisitantes.includes("doble_nacionalidad")) {
    columnas.push("doble_nacionalidad");
    bind.push(visitante.doble_nacionalidad ? 1 : 0);
  }
  if (columnasVisitantes.includes("segunda_nacionalidad")) {
    columnas.push("segunda_nacionalidad");
    bind.push(visitante.segunda_nacionalidad);
  }
  if (columnasVisitantes.includes("nacionalidad_no_consta")) {
    columnas.push("nacionalidad_no_consta");
    bind.push(0);
  }
  if (columnasVisitantes.includes("observaciones")) {
    columnas.push("observaciones");
    bind.push(visitante.observaciones);
  }
  if (columnasVisitantes.includes("observaciones_revision_estado")) {
    columnas.push("observaciones_revision_estado");
    bind.push(visitante.observaciones_revision_estado || "");
  }

  columnas.push("categoria_edad");
  bind.push(visitante.categoria_edad);

  const placeholders = columnas.map(() => "?").join(", ");
  const sql = `INSERT INTO visitantes (${columnas.join(", ")}) VALUES (${placeholders})`;
  return await env.DB.prepare(sql).bind(...bind).run();
}

async function actualizarReservaTrasGuardar(env, reservaId) {
  return await env.DB.prepare(`
    UPDATE reservas
    SET fecha_modificacion = datetime('now')
    WHERE id = ?
  `).bind(reservaId).run();
}

function construirCorreoRevisionAsistentesAdmin(reserva = {}, totalObservaciones = 0, baseUrl = "") {
  const adminNombre = nombreVisibleAdmin({
    nombre_publico: reserva.admin_nombre_publico,
    nombre: reserva.admin_nombre,
    localidad: reserva.admin_localidad
  });
  const actividad = limpiarTexto(reserva.actividad_nombre || "la actividad");
  const centro = limpiarTexto(reserva.centro || "un solicitante");
  const contacto = limpiarTexto(reserva.contacto || "");
  const codigo = limpiarTexto(reserva.codigo_reserva || "");
  const total = Number(totalObservaciones || 0);
  const urlPanel = limpiarTexto(baseUrl)
    ? `${baseUrl.replace(/\/+$/, "")}/portal.html?next=${encodeURIComponent(`/admin-reservas.html?actividad_id=${encodeURIComponent(String(reserva.actividad_id || ""))}`)}`
    : "";
  const asunto = `[Reservas] Solicitud en proceso por observaciones de asistentes`;
  const mensaje = `Una solicitud previamente confirmada vuelve a estar en proceso porque se han incorporado o modificado observaciones de asistentes.`;

  const texto = [
    `Hola ${adminNombre},`,
    "",
    mensaje,
    "",
    `Actividad: ${actividad}`,
    codigo ? `Código de solicitud: ${codigo}` : "",
    `Solicitante: ${centro}`,
    contacto ? `Contacto: ${contacto}` : "",
    total > 0 ? `Asistentes con observaciones pendientes de revisión: ${total}` : "",
    "",
    "Revisa la solicitud desde el panel de reservas para confirmar si procede aceptarla de nuevo o rechazarla.",
    urlPanel ? `Panel de reservas: ${urlPanel}` : ""
  ].filter(Boolean).join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;color:#22313f;line-height:1.45;">
      <p>Hola ${escaparHtml(adminNombre)},</p>
      <p>${escaparHtml(mensaje)}</p>
      <p><strong>Actividad:</strong> ${escaparHtml(actividad)}</p>
      ${codigo ? `<p><strong>Código de solicitud:</strong> ${escaparHtml(codigo)}</p>` : ""}
      <p><strong>Solicitante:</strong> ${escaparHtml(centro)}</p>
      ${contacto ? `<p><strong>Contacto:</strong> ${escaparHtml(contacto)}</p>` : ""}
      ${total > 0 ? `<p><strong>Asistentes con observaciones pendientes:</strong> ${total}</p>` : ""}
      <p>Revisa la solicitud desde el panel de reservas para confirmar si procede aceptarla de nuevo o rechazarla.</p>
      ${urlPanel ? `<p><a href="${escaparHtml(urlPanel)}" style="display:inline-block;padding:9px 14px;border-radius:999px;background:#0b5ed7;color:#fff;text-decoration:none;font-weight:700;">Abrir panel de reservas</a></p>` : ""}
    </div>
  `;

  return { asunto, texto, html };
}

async function notificarRevisionAsistentesAdmin(env, reserva = {}, totalObservaciones = 0, baseUrl = "") {
  const adminId = Number(reserva.admin_id || 0);
  const actividadId = Number(reserva.actividad_id || 0);
  const actividad = limpiarTexto(reserva.actividad_nombre || "una actividad");
  const centro = limpiarTexto(reserva.centro || "Un solicitante");
  const codigo = limpiarTexto(reserva.codigo_reserva || "");
  const resultado = {
    notificacion: { ok: false, skipped: true, error: "" },
    correo: { ok: false, skipped: true, error: "" }
  };

  if (adminId > 0) {
    resultado.notificacion = await crearNotificacion(env, {
      usuarioId: adminId,
      rolDestino: "ADMIN",
      tipo: "RESERVA",
      titulo: "Solicitud en proceso por observaciones",
      mensaje: `${centro} ha actualizado asistentes con observaciones en ${actividad}${codigo ? ` (${codigo})` : ""}.`,
      urlDestino: actividadId > 0
        ? `/admin-reservas.html?actividad_id=${encodeURIComponent(String(actividadId))}`
        : "/admin-reservas.html",
      dedupeSegundos: 300
    }).catch((error) => ({ ok: false, skipped: true, error: error?.message || String(error || "") }));
  }

  const adminEmail = limpiarTexto(reserva.admin_email || "");
  if (adminEmail) {
    const correo = construirCorreoRevisionAsistentesAdmin(reserva, totalObservaciones, baseUrl);
    resultado.correo = await enviarEmail(env, {
      to: adminEmail,
      subject: correo.asunto,
      text: correo.texto,
      html: correo.html,
      dedupe: true,
      dedupeSegundos: 300
    }).catch((error) => ({ ok: false, skipped: true, error: error?.message || String(error || "") }));
  }

  return resultado;
}

function calcularBloqueoReserva(row) {
  const asistentes = Number(row.asistentes_cargados || 0);
  const prereservadas = Number(row.plazas_prereservadas || 0);
  const estado = String(row.estado || "").toUpperCase();
  const rechazoSubsanableVigente =
    estado === "RECHAZADA" &&
    Number(row.rechazo_bloqueado || 0) !== 1 &&
    !!row.rechazo_elimina_en &&
    new Date(String(row.rechazo_elimina_en).replace(" ", "T")) >= new Date();

  if (rechazoSubsanableVigente) {
    return Math.max(prereservadas, asistentes);
  }

  if (!["PENDIENTE", "EN_REVISION", "PROVISIONAL", "CONFIRMADA", "SUSPENDIDA"].includes(estado)) {
    return 0;
  }

  if (row.prereserva_expira_en) {
    const exp = new Date(String(row.prereserva_expira_en).replace(" ", "T"));
    if (!Number.isNaN(exp.getTime()) && exp >= new Date()) {
      return Math.max(prereservadas, asistentes);
    }
  }

  return asistentes;
}

async function obtenerBloqueoDeOtrasReservas(env, franjaId, reservaIdActual) {
  const sql = `
    SELECT
      r.id,
      r.estado,
      COALESCE(r.rechazo_bloqueado, 0) AS rechazo_bloqueado,
      COALESCE(r.rechazo_elimina_en, '') AS rechazo_elimina_en,
      r.plazas_prereservadas,
      r.prereserva_expira_en,
      COALESCE((
        SELECT COUNT(*)
        FROM visitantes v
        WHERE v.reserva_id = r.id
      ), 0) AS asistentes_cargados
    FROM reservas r
    WHERE r.franja_id = ?
      AND r.id <> ?
  `;

  const result = await env.DB.prepare(sql).bind(franjaId, reservaIdActual).all();
  const rows = result.results || [];
  return rows.reduce((acc, row) => acc + calcularBloqueoReserva(row), 0);
}

function reservaUsaAforoLimitado(reserva = {}) {
  return Number(reserva.aforo_limitado || 0) === 1;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    await asegurarColumnaAforoMaximo(env);
    await asegurarColumnaRechazoEliminaEn(env);
    await asegurarColumnaRechazoBloqueado(env);
    const data = await request.json();

    const tokenEdicion = limpiarTexto(data.token_edicion);
    const visitantesEntrada = Array.isArray(data.visitantes) ? data.visitantes : [];
    const confirmarSinAsistentes = data.confirmar_sin_asistentes === true;

    if (!tokenEdicion) {
      return json(
        { ok: false, error: "Falta el token de edición." },
        { status: 400 }
      );
    }

    const reserva = await obtenerReservaPorToken(env, tokenEdicion);
    if (!reserva) {
      return json(
        { ok: false, error: "No existe ninguna solicitud con ese token." },
        { status: 404 }
      );
    }

    const estadoReserva = String(reserva.estado || "").toUpperCase();
    const rechazoSubsanable = estadoReserva === "RECHAZADA" && Number(reserva.rechazo_bloqueado || 0) !== 1;
    if (!rechazoSubsanable && !["BORRADOR", "PENDIENTE", "EN_REVISION", "PROVISIONAL", "SUSPENDIDA", "CONFIRMADA"].includes(estadoReserva)) {
      return json(
        { ok: false, error: "La solicitud no permite gestionar asistentes en su estado actual." },
        { status: 400 }
      );
    }

    const visitantesNormalizados = visitantesEntrada
      .map((v, index) => ({
        fila: index + 1,
        nombre_completo: limpiarTexto(v.nombre_completo),
        perfil_asistente: normalizarPerfilAsistente(v.perfil_asistente ?? v.tipo_asistente),
        nivel_ensenanza: normalizarNivelEnsenanza(v.nivel_ensenanza),
        categoria_edad: normalizarCategoriaEdad(v.categoria_edad),
        nacionalidad: limpiarTexto(v.nacionalidad),
        dni: normalizarDocumentoIdentidad(v.dni),
        email: limpiarTexto(v.email),
        doble_nacionalidad: v.doble_nacionalidad === true || v.doble_nacionalidad === 1 || v.doble_nacionalidad === "1" ? 1 : 0,
        segunda_nacionalidad: v.doble_nacionalidad === true || v.doble_nacionalidad === 1 || v.doble_nacionalidad === "1" ? limpiarTexto(v.segunda_nacionalidad) : "",
        nacionalidad_no_consta: 0,
        observaciones: limpiarTexto(v.observaciones)
      }))
      .filter((v) => v.nombre_completo !== "");

    for (const visitante of visitantesNormalizados) {
      if (!visitante.nombre_completo || !visitante.perfil_asistente || !visitante.nivel_ensenanza || !visitante.categoria_edad) {
        return json(
          { ok: false, error: `La fila ${visitante.fila} de asistentes no está completa.` },
          { status: 400 }
        );
      }
      if (!documentoIdentidadValido(visitante.dni)) {
        return json(
          { ok: false, error: `La fila ${visitante.fila} contiene un DNI/NIE con formato no válido.` },
          { status: 400 }
        );
      }
      if (!emailValido(visitante.email)) {
        return json(
          { ok: false, error: `La fila ${visitante.fila} contiene un correo electrónico con formato no válido.` },
          { status: 400 }
        );
      }
      if (visitante.doble_nacionalidad && !visitante.segunda_nacionalidad) {
        return json(
          { ok: false, error: `La fila ${visitante.fila} indica doble nacionalidad pero no incluye la segunda nacionalidad.` },
          { status: 400 }
        );
      }
    }

    let capacidadFranja = null;
    let ocupadasPorOtros = 0;
    let maximoPermitidoParaEstaReserva = null;

    if (Number(reserva.franja_id || 0) > 0) {
      const franja = await obtenerCapacidadFranja(env, reserva.franja_id);
      if (!franja) {
        return json(
          { ok: false, error: "La franja asociada a la solicitud no existe." },
          { status: 404 }
        );
      }

      if (reservaUsaAforoLimitado(reserva) && franja.capacidad != null) {
        capacidadFranja = Number(franja.capacidad || 0);
        ocupadasPorOtros = await obtenerBloqueoDeOtrasReservas(env, reserva.franja_id, reserva.id);
        maximoPermitidoParaEstaReserva = Math.max(capacidadFranja - ocupadasPorOtros, 0);
      }
    } else if (reservaUsaAforoLimitado(reserva)) {
      capacidadFranja = Number(reserva.aforo_maximo || 0);
      ocupadasPorOtros = await obtenerBloqueoActividadSinFranja(env, reserva.actividad_id, reserva.id);
      maximoPermitidoParaEstaReserva = Math.max(capacidadFranja - ocupadasPorOtros, 0);
    }

    const totalDeseado = visitantesNormalizados.length;
    if (totalDeseado === 0 && !confirmarSinAsistentes) {
      return json(
        { ok: false, error: "No se han recibido asistentes para guardar. Si desea dejar la solicitud sin asistentes, confirme la acción desde el aviso correspondiente." },
        { status: 400 }
      );
    }

    if (maximoPermitidoParaEstaReserva !== null && totalDeseado > maximoPermitidoParaEstaReserva) {
      return json(
        {
          ok: false,
          error: Number(reserva.franja_id || 0) > 0
            ? `No hay plazas suficientes en la franja. Máximo asignable ahora para esta solicitud: ${maximoPermitidoParaEstaReserva}. Se intentan guardar ${totalDeseado}.`
            : `No hay plazas suficientes en la actividad. Máximo asignable ahora para esta solicitud: ${maximoPermitidoParaEstaReserva}. Se intentan guardar ${totalDeseado}.`
        },
        { status: 400 }
      );
    }

    await asegurarEsquemaVisitantes(env);
    const columnasVisitantes = await listarColumnasVisitantes(env);
    const visitantesPrevios = await obtenerVisitantesPrevios(env, reserva.id, columnasVisitantes);
    const revisionesPrevias = new Map();
    visitantesPrevios.forEach((visitante) => {
      revisionesPrevias.set(normalizarClaveNombre(visitante.nombre_completo), {
        firma: firmaDatosAmpliatorios(visitante),
        estado: limpiarTexto(visitante.observaciones_revision_estado).toUpperCase()
      });
    });
    let requiereRevisionOrganizador = false;
    visitantesNormalizados.forEach((visitante) => {
      if (!tieneDatosAmpliatorios(visitante)) {
        visitante.observaciones_revision_estado = "";
        return;
      }
      const previa = revisionesPrevias.get(normalizarClaveNombre(visitante.nombre_completo));
      const firmaActual = firmaDatosAmpliatorios(visitante);
      if (previa && previa.firma === firmaActual && ["IGNORADA", "RELEVANTE"].includes(previa.estado)) {
        visitante.observaciones_revision_estado = previa.estado;
      } else {
        visitante.observaciones_revision_estado = "";
        requiereRevisionOrganizador = true;
      }
    });
    await borrarVisitantesDeReserva(env, reserva.id);

    for (const visitante of visitantesNormalizados) {
      await insertarVisitante(env, reserva.id, visitante, columnasVisitantes);
    }

    let estadoDestino = reserva.estado;
    let avisoRevisionAsistentesAdmin = { notificacion: { ok: false, skipped: true }, correo: { ok: false, skipped: true } };
    if (normalizarEstadoReserva(reserva.estado) === "CONFIRMADA" && requiereRevisionOrganizador) {
      await env.DB.prepare(`
        UPDATE reservas
        SET estado = 'PENDIENTE',
            fecha_modificacion = datetime('now')
        WHERE id = ?
      `).bind(reserva.id).run();
      estadoDestino = "PENDIENTE";
      avisoRevisionAsistentesAdmin = await notificarRevisionAsistentesAdmin(
        env,
        reserva,
        visitantesNormalizados.filter((visitante) => limpiarTexto(visitante.observaciones)).length,
        new URL(request.url).origin
      );
    }

    await actualizarReservaTrasGuardar(env, reserva.id);
    await registrarEventoReserva(env, {
      reservaId: reserva.id,
      accion: "ASISTENTES_ACTUALIZADOS",
      estadoOrigen: reserva.estado,
      estadoDestino,
      observaciones: estadoDestino === "PENDIENTE" && normalizarEstadoReserva(reserva.estado) === "CONFIRMADA"
        ? `Total asistentes: ${totalDeseado}. La solicitud vuelve a estar en proceso por observaciones de asistentes pendientes de revisión.`
        : `Total asistentes: ${totalDeseado}`,
      actorUsuarioId: reserva.usuario_id,
      actorRol: "SOLICITANTE",
      actorNombre: reserva.contacto || reserva.centro || "Solicitante"
    });

    const alumnos = visitantesNormalizados.filter((v) => v.perfil_asistente === "ALUMNO").length;
    const responsablesGrupo = visitantesNormalizados.filter((v) => v.perfil_asistente === "RESPONSABLE_GRUPO").length;
    const generales = visitantesNormalizados.filter((v) => v.perfil_asistente === "GENERAL").length;
    const de3a5 = visitantesNormalizados.filter((v) => v.categoria_edad === "DE_3_A_5").length;
    const de6a9 = visitantesNormalizados.filter((v) => v.categoria_edad === "DE_6_A_9").length;
    const de10a14 = visitantesNormalizados.filter((v) => v.categoria_edad === "DE_10_A_14").length;
    const de15a18 = visitantesNormalizados.filter((v) => v.categoria_edad === "DE_15_A_18").length;
    const mayores18 = visitantesNormalizados.filter((v) => v.categoria_edad === "MAYOR_DE_18").length;

    return json({
      ok: true,
      mensaje: totalDeseado === 0
        ? "Asistentes eliminados correctamente."
        : "Asistentes guardados correctamente.",
      codigo_reserva: reserva.codigo_reserva,
      capacidad_franja: capacidadFranja,
      ocupadas_por_otros: ocupadasPorOtros,
      maximo_permitido_para_esta_reserva: maximoPermitidoParaEstaReserva,
      plazas_prereservadas_historicas: Number(reserva.plazas_prereservadas || 0),
      plazas_asignadas: totalDeseado,
      alumnos,
      responsables_grupo: responsablesGrupo,
      generales,
      profesores: responsablesGrupo,
      de_3_a_5: de3a5,
      de_6_a_9: de6a9,
      de_10_a_14: de10a14,
      de_15_a_18: de15a18,
      mayor_de_18: mayores18,
      aviso_revision_asistentes_admin: avisoRevisionAsistentesAdmin
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error interno al guardar los asistentes.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
