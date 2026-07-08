import { getSecretariaSession } from "./_documental.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function parsearIdPositivo(valor) {
  const n = Number.parseInt(String(valor || ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function claveNombre(valor) {
  return limpiarTexto(valor).toLowerCase();
}

function parsearFechaComparable(valor) {
  const texto = limpiarTexto(valor);
  if (!texto) return null;
  const fecha = new Date(texto.replace(" ", "T"));
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function etiquetarEstado(estado) {
  const valor = limpiarTexto(estado).toUpperCase();
  if (!valor) return "No presentado";
  if (valor === "VALIDADO" || valor === "VALIDADA") return "Aprobado";
  if (valor === "RECHAZADO" || valor === "RECHAZADA") return "Rechazado";
  if (valor === "NO_ACTUALIZADO") return "Desactualizado";
  if (valor === "EN_REVISION" || valor === "EN REVISIÓN") return "En revisión";
  return valor;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const session = await getSecretariaSession(request, env);
    if (!session || session.rol !== "SECRETARIA") {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const url = new URL(request.url);
    const usuarioId = parsearIdPositivo(url.searchParams.get("usuario_id"));
    if (!usuarioId) {
      return json({ ok: false, error: "Debes indicar un usuario válido." }, 400);
    }

    const usuario = await env.DB.prepare(`
      SELECT id, rol, nombre, centro, email
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(usuarioId).first();
    if (!usuario || limpiarTexto(usuario.rol).toUpperCase() !== "SOLICITANTE") {
      return json({ ok: false, error: "Usuario público no válido." }, 404);
    }

    const docsBaseRes = await env.DB.prepare(`
      SELECT nombre, version_documental, fecha_actualizacion
      FROM admin_documentos_comunes
      WHERE admin_id = ?
        AND activo = 1
      ORDER BY orden ASC, id ASC
    `).bind(session.usuario_id).all();

    const docsBase = (docsBaseRes?.results || []).map((row) => ({
      nombre: limpiarTexto(row.nombre),
      version_documental: Number(row.version_documental || 0),
      fecha_actualizacion: limpiarTexto(row.fecha_actualizacion)
    })).filter((row) => row.nombre);

    const docsBaseMap = new Map(docsBase.map((doc) => [claveNombre(doc.nombre), doc]));
    const archivosRes = await env.DB.prepare(`
      SELECT
        cad.id AS documentacion_id,
        cad.actividad_id,
        cad.reserva_id,
        COALESCE(act.titulo_publico, act.nombre, '') AS actividad_nombre,
        COALESCE(r.codigo_reserva, '') AS codigo_reserva,
        COALESCE(f.fecha, act.fecha_inicio, '') AS fecha_actividad,
        COALESCE(f.hora_inicio, '') AS hora_inicio,
        COALESCE(f.hora_fin, '') AS hora_fin,
        a.nombre_documento,
        a.archivo_url,
        a.estado,
        a.version_documental,
        a.fecha_subida,
        a.id
      FROM centro_admin_documentacion cad
      INNER JOIN centro_admin_documentacion_archivos a
        ON a.documentacion_id = cad.id
       AND a.activo = 1
      LEFT JOIN actividades act
        ON act.id = cad.actividad_id
      LEFT JOIN reservas r
        ON r.id = cad.reserva_id
      LEFT JOIN franjas f
        ON f.id = r.franja_id
      WHERE cad.admin_id = ?
        AND cad.centro_usuario_id = ?
      ORDER BY datetime(COALESCE(a.fecha_subida, '1970-01-01 00:00:00')) DESC, a.id DESC
    `).bind(session.usuario_id, usuarioId).all();

    const documentos = [];
    const docsConEntrega = new Set();
    for (const row of (archivosRes?.results || [])) {
      const doc = docsBaseMap.get(claveNombre(row.nombre_documento));
      if (!doc) continue;
      docsConEntrega.add(claveNombre(doc.nombre));
      const fechaMarco = parsearFechaComparable(doc.fecha_actualizacion);
      const fechaEntrega = parsearFechaComparable(row.fecha_subida);
      let estado = limpiarTexto(row.estado).toUpperCase();
      if (Number(row.version_documental || 0) !== Number(doc.version_documental || 0)) {
        estado = "NO_ACTUALIZADO";
      } else if (fechaMarco && fechaEntrega && fechaEntrega < fechaMarco) {
        estado = "NO_ACTUALIZADO";
      }

      const contextoPartes = [
        limpiarTexto(row.actividad_nombre),
        limpiarTexto(row.fecha_actividad),
        [limpiarTexto(row.hora_inicio), limpiarTexto(row.hora_fin)].filter(Boolean).join(" - "),
        limpiarTexto(row.codigo_reserva)
      ].filter(Boolean);

      documentos.push({
        nombre_documento: doc.nombre,
        version_documental: Number(doc.version_documental || 0),
        expediente_id: Number(row.documentacion_id || 0),
        archivo_id: Number(row.id || 0),
        archivo_url: limpiarTexto(row.archivo_url),
        estado_bruto: estado || "",
        estado: estado ? etiquetarEstado(estado) : "No presentado",
        fecha_subida: limpiarTexto(row.fecha_subida),
        actividad_id: Number(row.actividad_id || 0),
        reserva_id: Number(row.reserva_id || 0),
        contexto: contextoPartes.join(" · ")
      });
    }

    for (const doc of docsBase) {
      if (docsConEntrega.has(claveNombre(doc.nombre))) continue;
      documentos.push({
        nombre_documento: doc.nombre,
        version_documental: Number(doc.version_documental || 0),
        expediente_id: 0,
        archivo_id: 0,
        archivo_url: "",
        estado_bruto: "",
        estado: "No presentado",
        fecha_subida: "",
        actividad_id: 0,
        reserva_id: 0,
        contexto: ""
      });
    }

    return json({
      ok: true,
      usuario: {
        id: Number(usuario.id || 0),
        nombre: usuario.nombre || "",
        centro: usuario.centro || "",
        email: usuario.email || ""
      },
      gestor_documental: {
        id: Number(session.usuario_id || 0),
        modo: "SECRETARIA_EXTERNA",
        nombre: "",
        nombre_publico: ""
      },
      permisos: {
        puede_editar_documentacion: true
      },
      total: documentos.length,
      documentos
    });
  } catch (error) {
    return json({ ok: false, error: "No se pudo cargar la documentación del usuario.", detalle: error?.message || String(error) }, 500);
  }
}
