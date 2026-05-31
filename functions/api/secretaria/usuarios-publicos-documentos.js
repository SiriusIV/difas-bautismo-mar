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
  if (!valor) return "No remitido";
  if (valor === "VALIDADO" || valor === "VALIDADA") return "Validado";
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

    const archivosRes = await env.DB.prepare(`
      SELECT
        a.documentacion_id,
        a.nombre_documento,
        a.archivo_url,
        a.estado,
        a.version_documental,
        a.fecha_subida,
        a.id
      FROM usuarios admin
      INNER JOIN centro_admin_documentacion cad
        ON cad.admin_id = admin.id
      INNER JOIN centro_admin_documentacion_archivos a
        ON a.documentacion_id = cad.id
      WHERE admin.rol = 'ADMIN'
        AND COALESCE(admin.modulo_secretaria, 0) = 0
        AND admin.secretaria_usuario_id = ?
        AND cad.centro_usuario_id = ?
        AND a.activo = 1
      ORDER BY datetime(COALESCE(a.fecha_subida, '1970-01-01 00:00:00')) DESC, a.id DESC
    `).bind(session.usuario_id, usuarioId).all();

    const archivosMap = new Map();
    for (const row of (archivosRes?.results || [])) {
      const clave = claveNombre(row.nombre_documento);
      if (!clave || archivosMap.has(clave)) continue;
      archivosMap.set(clave, {
        id: Number(row.id || 0),
        documentacion_id: Number(row.documentacion_id || 0),
        archivo_url: limpiarTexto(row.archivo_url),
        estado_bruto: limpiarTexto(row.estado).toUpperCase(),
        version_documental: Number(row.version_documental || 0),
        fecha_subida: limpiarTexto(row.fecha_subida)
      });
    }

    const documentos = docsBase.map((doc) => {
      const archivo = archivosMap.get(claveNombre(doc.nombre));
      const fechaMarco = parsearFechaComparable(doc.fecha_actualizacion);
      const fechaEntrega = parsearFechaComparable(archivo?.fecha_subida);
      let estado = archivo?.estado_bruto || "";
      if (archivo) {
        if (Number(archivo.version_documental || 0) !== Number(doc.version_documental || 0)) {
          estado = "NO_ACTUALIZADO";
        } else if (fechaMarco && fechaEntrega && fechaEntrega < fechaMarco) {
          estado = "NO_ACTUALIZADO";
        }
      }
      return {
        nombre_documento: doc.nombre,
        version_documental: Number(doc.version_documental || 0),
        expediente_id: Number(archivo?.documentacion_id || 0),
        archivo_id: Number(archivo?.id || 0),
        archivo_url: archivo?.archivo_url || "",
        estado_bruto: estado || "",
        estado: estado ? etiquetarEstado(estado) : "No remitido",
        fecha_subida: archivo?.fecha_subida || ""
      };
    });

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
