import { getAdminSession } from "./_auth.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    ...init
  });
}

function parsearIdPositivo(valor) {
  const n = Number.parseInt(String(valor || ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function claveNombreDocumento(valor) {
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
  if (valor === "RECHAZADO") return "Rechazado";
  if (valor === "NO_ACTUALIZADO") return "Desactualizado";
  if (valor === "EN_REVISION" || valor === "EN REVISIÓN") return "En revisión";
  return valor;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    const url = new URL(request.url);
    const usuarioId = parsearIdPositivo(url.searchParams.get("usuario_id"));
    if (!usuarioId) {
      return json({ ok: false, error: "Debes indicar un usuario válido." }, { status: 400 });
    }

    const usuario = await env.DB.prepare(`
      SELECT id, rol, nombre, centro, email
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(usuarioId).first();

    if (!usuario || limpiarTexto(usuario.rol).toUpperCase() !== "SOLICITANTE") {
      return json({ ok: false, error: "Usuario público no válido." }, { status: 404 });
    }

    const responsableId = Number(session.usuario_id || 0);
    const responsable = await env.DB.prepare(`
      SELECT id, nombre, nombre_publico
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(responsableId).first();
    const docsBaseRes = await env.DB.prepare(`
      SELECT
        nombre,
        version_documental,
        fecha_actualizacion
      FROM admin_documentos_comunes
      WHERE admin_id = ?
        AND activo = 1
      ORDER BY orden ASC, id ASC
    `).bind(responsableId).all();

    const docsBase = (docsBaseRes?.results || []).map((row) => ({
      nombre: limpiarTexto(row.nombre),
      version_documental: Number(row.version_documental || 0),
      fecha_actualizacion: limpiarTexto(row.fecha_actualizacion)
    })).filter((row) => row.nombre);

    if (!docsBase.length) {
      return json({
        ok: true,
        usuario: {
          id: Number(usuario.id || 0),
          nombre: usuario.nombre || "",
          centro: usuario.centro || "",
          email: usuario.email || ""
        },
        gestor_documental: {
          id: responsableId,
          modo: "PROPIO",
          nombre: responsable?.nombre || "",
          nombre_publico: responsable?.nombre_publico || ""
        },
        total: 0,
        documentos: []
      });
    }

    const docsBaseMap = new Map(docsBase.map((doc) => [claveNombreDocumento(doc.nombre), doc]));
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
      WHERE cad.centro_usuario_id = ?
        AND cad.admin_id = ?
      ORDER BY datetime(COALESCE(a.fecha_subida, '1970-01-01 00:00:00')) DESC, a.id DESC
    `).bind(usuarioId, responsableId).all();

    const documentos = [];
    const docsConEntrega = new Set();
    for (const row of (archivosRes?.results || [])) {
      const doc = docsBaseMap.get(claveNombreDocumento(row.nombre_documento));
      if (!doc) continue;
      docsConEntrega.add(claveNombreDocumento(doc.nombre));
      const versionDoc = Number(doc.version_documental || 0);
      const versionEntrega = Number(row.version_documental || 0);
      const fechaMarco = parsearFechaComparable(doc.fecha_actualizacion);
      const fechaEntrega = parsearFechaComparable(row.fecha_subida);

      let estado = limpiarTexto(row.estado).toUpperCase();
      if (versionEntrega !== versionDoc) {
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
        version_documental: versionDoc,
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
      if (docsConEntrega.has(claveNombreDocumento(doc.nombre))) continue;
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
        id: responsableId,
        modo: "PROPIO",
        nombre: responsable?.nombre || "",
        nombre_publico: responsable?.nombre_publico || ""
      },
      permisos: {
        puede_editar_documentacion: true
      },
      total: documentos.length,
      documentos
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo cargar la documentación del usuario.",
        detalle: error?.message || String(error || "")
      },
      { status: 500 }
    );
  }
}
