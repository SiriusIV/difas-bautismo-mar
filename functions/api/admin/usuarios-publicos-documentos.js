import { getAdminSession } from "./_auth.js";
import { resolverResponsableDocumental } from "../_documentacion_responsable.js";

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
  if (!valor) return "No remitido";
  if (valor === "VALIDADO") return "Validado";
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

    const adminId = Number(session.usuario_id || 0);
    const resolucion = await resolverResponsableDocumental(env, adminId);
    if (!resolucion?.responsable?.id) {
      return json({ ok: false, error: "No se pudo resolver el gestor documental activo." }, { status: 409 });
    }

    const responsableId = Number(resolucion.responsable.id || 0);
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
          modo: resolucion.modo || "AUTOGESTION",
          nombre: resolucion.responsable.nombre || "",
          nombre_publico: resolucion.responsable.nombre_publico || ""
        },
        total: 0,
        documentos: []
      });
    }

    const expediente = await env.DB.prepare(`
      SELECT id
      FROM centro_admin_documentacion
      WHERE centro_usuario_id = ?
        AND admin_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).bind(usuarioId, adminId).first();

    const archivosMap = new Map();
    if (expediente?.id) {
      const archivosRes = await env.DB.prepare(`
        SELECT
          nombre_documento,
          archivo_url,
          estado,
          version_documental,
          fecha_subida,
          id
        FROM centro_admin_documentacion_archivos
        WHERE documentacion_id = ?
          AND activo = 1
        ORDER BY datetime(COALESCE(fecha_subida, '1970-01-01 00:00:00')) DESC, id DESC
      `).bind(Number(expediente.id || 0)).all();

      for (const row of (archivosRes?.results || [])) {
        const clave = claveNombreDocumento(row.nombre_documento);
        if (!clave || archivosMap.has(clave)) continue;
        archivosMap.set(clave, {
          nombre_documento: limpiarTexto(row.nombre_documento),
          archivo_url: limpiarTexto(row.archivo_url),
          estado_bruto: limpiarTexto(row.estado).toUpperCase(),
          version_documental: Number(row.version_documental || 0),
          fecha_subida: limpiarTexto(row.fecha_subida)
        });
      }
    }

    const documentos = docsBase.map((doc) => {
      const archivo = archivosMap.get(claveNombreDocumento(doc.nombre));
      const versionDoc = Number(doc.version_documental || 0);
      const versionEntrega = Number(archivo?.version_documental || 0);
      const fechaMarco = parsearFechaComparable(doc.fecha_actualizacion);
      const fechaEntrega = parsearFechaComparable(archivo?.fecha_subida);

      let estado = archivo?.estado_bruto || "";
      if (archivo) {
        if (versionEntrega !== versionDoc) {
          estado = "NO_ACTUALIZADO";
        } else if (fechaMarco && fechaEntrega && fechaEntrega < fechaMarco) {
          estado = "NO_ACTUALIZADO";
        }
      }

      return {
        nombre_documento: doc.nombre,
        version_documental: versionDoc,
        expediente_id: Number(expediente?.id || 0),
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
        id: responsableId,
        modo: resolucion.modo || "AUTOGESTION",
        nombre: resolucion.responsable.nombre || "",
        nombre_publico: resolucion.responsable.nombre_publico || ""
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
