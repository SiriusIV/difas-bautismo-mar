import { getAdminSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function limpiarTexto(valor) {
  return String(valor || "").trim();
}

function parsearIdPositivo(valor) {
  const n = parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizarDescripcion(valor) {
  const texto = limpiarTexto(valor);
  return texto === "" ? null : texto;
}

function normalizarDocumento(documento, indice) {
  const nombre = limpiarTexto(documento?.nombre);
  const descripcion = normalizarDescripcion(documento?.descripcion);
  const archivo_url = limpiarTexto(documento?.archivo_url);
  const orden = Number.isInteger(documento?.orden)
    ? documento.orden
    : parseInt(documento?.orden, 10);

  if (!nombre) {
    return { error: `El nombre del documento ${indice + 1} es obligatorio.` };
  }

  if (!archivo_url) {
    return { error: `El archivo del documento ${indice + 1} es obligatorio.` };
  }

  return {
    nombre,
    descripcion,
    archivo_url,
    orden: Number.isInteger(orden) ? orden : indice
  };
}

async function obtenerAdminObjetivo(session, bodyAdminId) {
  if (session.rol === "SUPERADMIN") {
    const adminId = parsearIdPositivo(bodyAdminId);
    return adminId || session.usuario_id;
  }

  return session.usuario_id;
}

async function obtenerVersionActual(env, adminId) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(MAX(version_documental), 0) AS version_actual
    FROM admin_documentos_comunes
    WHERE admin_id = ?
  `).bind(adminId).first();

  return Number(row?.version_actual || 0);
}

async function leerDocumentosAdmin(env, adminId, soloActivos = false) {
  const rows = await env.DB.prepare(`
    SELECT
      id,
      admin_id,
      nombre,
      descripcion,
      archivo_url,
      orden,
      activo,
      version_documental,
      fecha_actualizacion
    FROM admin_documentos_comunes
    WHERE admin_id = ?
      ${soloActivos ? "AND activo = 1" : ""}
    ORDER BY activo DESC, orden ASC, id ASC
  `).bind(adminId).all();

  return rows?.results || [];
}

function firmaDocumentos(documentos) {
  return JSON.stringify(
    documentos.map((doc) => ({
      nombre: doc.nombre,
      descripcion: doc.descripcion || null,
      archivo_url: doc.archivo_url,
      orden: Number(doc.orden || 0)
    }))
  );
}

function claveDocumento(doc) {
  return limpiarTexto(doc?.nombre).toUpperCase();
}

function esMismoContenidoDocumento(actual, nuevo) {
  return (
    limpiarTexto(actual?.nombre) === limpiarTexto(nuevo?.nombre) &&
    normalizarDescripcion(actual?.descripcion) === normalizarDescripcion(nuevo?.descripcion) &&
    limpiarTexto(actual?.archivo_url) === limpiarTexto(nuevo?.archivo_url)
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const url = new URL(request.url);
    const adminId = await obtenerAdminObjetivo(session, url.searchParams.get("admin_id"));
    const version_actual = await obtenerVersionActual(env, adminId);
    const documentos = await leerDocumentosAdmin(env, adminId, false);

    return json({
      ok: true,
      admin_id: adminId,
      version_actual: version_actual > 0 ? version_actual : 1,
      documentos
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al obtener los documentos comunes.",
        detalle: error.message
      },
      500
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const body = await request.json();
    const adminId = await obtenerAdminObjetivo(session, body?.admin_id);
    const documentosEntrada = Array.isArray(body?.documentos) ? body.documentos : null;

    if (!documentosEntrada) {
      return json(
        { ok: false, error: "Debe indicar una lista válida de documentos." },
        400
      );
    }

    const documentosNormalizados = [];
    for (let i = 0; i < documentosEntrada.length; i++) {
      const normalizado = normalizarDocumento(documentosEntrada[i], i);
      if (normalizado.error) {
        return json({ ok: false, error: normalizado.error }, 400);
      }
      documentosNormalizados.push(normalizado);
    }

    documentosNormalizados.sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre));

    const nombresVistos = new Set();
    for (const doc of documentosNormalizados) {
      const clave = claveDocumento(doc);
      if (nombresVistos.has(clave)) {
        return json(
          { ok: false, error: "No puede haber dos documentos activos con el mismo nombre." },
          400
        );
      }
      nombresVistos.add(clave);
    }

    const actuales = await leerDocumentosAdmin(env, adminId, true);
    const firmaActual = firmaDocumentos(actuales);
    const firmaNueva = firmaDocumentos(documentosNormalizados);
    const versionAnterior = await obtenerVersionActual(env, adminId);

    if (firmaActual === firmaNueva) {
      return json({
        ok: true,
        mensaje: "No hay cambios en los documentos comunes.",
        admin_id: adminId,
        version_actual: versionAnterior > 0 ? versionAnterior : 1,
        documentos: actuales
      });
    }

    const sentencias = [];
    const actualesPorClave = new Map(actuales.map((doc) => [claveDocumento(doc), doc]));
    const nuevasClaves = new Set(documentosNormalizados.map((doc) => claveDocumento(doc)));

    for (const actual of actuales) {
      if (!nuevasClaves.has(claveDocumento(actual))) {
        sentencias.push(
          env.DB.prepare(`
            UPDATE admin_documentos_comunes
            SET
              activo = 0,
              fecha_actualizacion = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(actual.id)
        );
      }
    }

    for (const doc of documentosNormalizados) {
      const actual = actualesPorClave.get(claveDocumento(doc));

      if (!actual) {
        sentencias.push(
          env.DB.prepare(`
            INSERT INTO admin_documentos_comunes (
              admin_id,
              nombre,
              descripcion,
              archivo_url,
              orden,
              activo,
              version_documental,
              fecha_actualizacion
            )
            VALUES (?, ?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP)
          `).bind(
            adminId,
            doc.nombre,
            doc.descripcion,
            doc.archivo_url,
            doc.orden
          )
        );
        continue;
      }

      if (esMismoContenidoDocumento(actual, doc)) {
        if (Number(actual.orden || 0) !== Number(doc.orden || 0)) {
          sentencias.push(
            env.DB.prepare(`
              UPDATE admin_documentos_comunes
              SET
                orden = ?,
                fecha_actualizacion = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(doc.orden, actual.id)
          );
        }
        continue;
      }

      sentencias.push(
        env.DB.prepare(`
          UPDATE admin_documentos_comunes
          SET
            activo = 0,
            fecha_actualizacion = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(actual.id)
      );

      sentencias.push(
        env.DB.prepare(`
          INSERT INTO admin_documentos_comunes (
            admin_id,
            nombre,
            descripcion,
            archivo_url,
            orden,
            activo,
            version_documental,
            fecha_actualizacion
          )
          VALUES (?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
        `).bind(
          adminId,
          doc.nombre,
          doc.descripcion,
          doc.archivo_url,
          doc.orden,
          Number(actual.version_documental || 0) + 1
        )
      );
    }

    await env.DB.batch(sentencias);

    const documentos = await leerDocumentosAdmin(env, adminId, false);
    const versionActual = documentos
      .filter((doc) => Number(doc.activo || 0) === 1)
      .reduce((max, doc) => Math.max(max, Number(doc.version_documental || 0)), 0);

    return json({
      ok: true,
      mensaje: documentos.length
        ? "Documentos comunes actualizados correctamente."
        : "Se han desactivado los documentos comunes del administrador.",
      admin_id: adminId,
      version_actual: documentos.length ? versionActual : versionAnterior,
      documentos
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al guardar los documentos comunes.",
        detalle: error.message
      },
      500
    );
  }
}
