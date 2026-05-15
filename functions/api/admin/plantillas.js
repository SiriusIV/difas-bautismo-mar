import { getAdminSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  });
}

function dbPrimaria(env) {
  if (typeof env?.DB?.withSession === "function") {
    return env.DB.withSession("first-primary");
  }
  return env.DB;
}

function limpiarTexto(valor) {
  return String(valor ?? "").trim();
}

function sanitizarSegmento(valor = "") {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parsearIdPositivo(valor) {
  const numero = Number.parseInt(String(valor ?? "").trim(), 10);
  return Number.isInteger(numero) && numero > 0 ? numero : null;
}

function parsearCamposDetectados(valor) {
  try {
    const parsed = typeof valor === "string" ? JSON.parse(valor || "[]") : valor;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        nombre: limpiarTexto(item?.nombre),
        tipo: limpiarTexto(item?.tipo) || "Campo",
        modo: limpiarTexto(item?.modo).toUpperCase() === "LIBRE" ? "LIBRE" : "VINCULADO",
        nota: limpiarTexto(item?.nota || item?.observacion)
      }))
      .filter((item) => item.nombre);
  } catch {
    return [];
  }
}

async function asegurarTablaPlantillas(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_plantillas_documentales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      actividad_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      descripcion TEXT DEFAULT '',
      tipo_generacion TEXT NOT NULL DEFAULT 'ASISTENTE',
      estado TEXT NOT NULL DEFAULT 'ACTIVA',
      archivo_nombre TEXT DEFAULT '',
      archivo_url TEXT DEFAULT '',
      archivo_key TEXT DEFAULT '',
      campos_detectados_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const columnas = await env.DB.prepare(`PRAGMA table_info(admin_plantillas_documentales)`).all();
  const nombres = new Set((columnas?.results || []).map((row) => String(row.name || "").trim()));
  if (!nombres.has("archivo_key")) {
    await env.DB.prepare(`ALTER TABLE admin_plantillas_documentales ADD COLUMN archivo_key TEXT DEFAULT ''`).run();
  }
}

async function obtenerActividadPermitida(env, session, actividadId) {
  if (!actividadId) return null;

  if (String(session.rol || "").toUpperCase() === "SUPERADMIN") {
    return await dbPrimaria(env).prepare(`
      SELECT id, admin_id, titulo_publico, nombre
      FROM actividades
      WHERE id = ?
      LIMIT 1
    `).bind(actividadId).first();
  }

  return await dbPrimaria(env).prepare(`
    SELECT id, admin_id, titulo_publico, nombre
    FROM actividades
    WHERE id = ?
      AND admin_id = ?
    LIMIT 1
  `).bind(actividadId, session.usuario_id).first();
}

async function obtenerPlantillaPorId(env, session, plantillaId) {
  if (!plantillaId) return null;

  if (String(session.rol || "").toUpperCase() === "SUPERADMIN") {
    return await dbPrimaria(env).prepare(`
      SELECT *
      FROM admin_plantillas_documentales
      WHERE id = ?
      LIMIT 1
    `).bind(plantillaId).first();
  }

  return await dbPrimaria(env).prepare(`
    SELECT *
    FROM admin_plantillas_documentales
    WHERE id = ?
      AND admin_id = ?
    LIMIT 1
  `).bind(plantillaId, session.usuario_id).first();
}

function normalizarFilaPlantilla(row) {
  if (!row) return null;
  return {
    id: Number(row.id || 0),
    admin_id: Number(row.admin_id || 0),
    actividad_id: Number(row.actividad_id || 0),
    actividad_titulo: limpiarTexto(row.actividad_titulo || row.actividad_nombre),
    nombre: limpiarTexto(row.nombre),
    descripcion: limpiarTexto(row.descripcion),
    tipo_generacion: limpiarTexto(row.tipo_generacion || "ASISTENTE") || "ASISTENTE",
    estado: limpiarTexto(row.estado || "ACTIVA") || "ACTIVA",
    archivo_nombre: limpiarTexto(row.archivo_nombre),
    archivo_url: limpiarTexto(row.archivo_url),
    archivo_key: limpiarTexto(row.archivo_key),
    campos_detectados: parsearCamposDetectados(row.campos_detectados_json || "[]"),
    created_at: row.created_at || "",
    updated_at: row.updated_at || ""
  };
}

async function contarReferenciasArchivo(env, archivoKey, plantillaIdIgnorada = null) {
  const key = limpiarTexto(archivoKey);
  if (!key) return 0;

  if (plantillaIdIgnorada) {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM admin_plantillas_documentales
      WHERE archivo_key = ?
        AND id <> ?
    `).bind(key, plantillaIdIgnorada).first();
    return Number(row?.total || 0);
  }

  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM admin_plantillas_documentales
    WHERE archivo_key = ?
  `).bind(key).first();
  return Number(row?.total || 0);
}

async function subirPdfPlantilla({ env, session, actividadId, nombrePlantilla, file }) {
  if (!env.DOCS_BUCKET) {
    throw new Error("Falta configurar el repositorio de documentos del sistema.");
  }

  const contentType = String(file.type || "").toLowerCase();
  const nombreArchivo = String(file.name || "").toLowerCase();
  if (contentType !== "application/pdf" && !nombreArchivo.endsWith(".pdf")) {
    throw new Error("Solo se admiten plantillas PDF.");
  }

  const nombreSeguro = sanitizarSegmento(nombrePlantilla) || "plantilla";
  const timestamp = Date.now();
  const key = `plantillas/admin-${session.usuario_id}/actividad-${actividadId}/${timestamp}-${nombreSeguro}.pdf`;
  const buffer = await file.arrayBuffer();

  await env.DOCS_BUCKET.put(key, buffer, {
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `inline; filename="${nombreSeguro}.pdf"`
    },
    customMetadata: {
      admin_id: String(session.usuario_id),
      actividad_id: String(actividadId),
      nombre_plantilla: nombrePlantilla,
      original_filename: String(file.name || "")
    }
  });

  return {
    archivo_key: key,
    archivo_url: `/api/documentos?key=${encodeURIComponent(key)}`,
    archivo_nombre: String(file.name || `${nombreSeguro}.pdf`)
  };
}

async function listarPlantillas(context, session) {
  const { request, env } = context;
  await asegurarTablaPlantillas(env);

  const url = new URL(request.url);
  const actividadId = parsearIdPositivo(url.searchParams.get("actividad_id"));
  const soloActivas = String(url.searchParams.get("solo_activas") || "").trim() === "1";

  const binds = [];
  let where = "";
  if (String(session.rol || "").toUpperCase() !== "SUPERADMIN") {
    where = "WHERE p.admin_id = ?";
    binds.push(session.usuario_id);
  }

  if (actividadId) {
    where += where ? " AND " : "WHERE ";
    where += "p.actividad_id = ?";
    binds.push(actividadId);
  }

  if (soloActivas) {
    where += where ? " AND " : "WHERE ";
    where += "UPPER(TRIM(COALESCE(p.estado, ''))) = 'ACTIVA'";
  }

  const rows = await dbPrimaria(env).prepare(`
    SELECT
      p.*,
      COALESCE(a.titulo_publico, a.nombre, '') AS actividad_titulo,
      COALESCE(a.nombre, a.titulo_publico, '') AS actividad_nombre
    FROM admin_plantillas_documentales p
    LEFT JOIN actividades a
      ON a.id = p.actividad_id
    ${where}
    ORDER BY
      CASE WHEN UPPER(TRIM(COALESCE(p.estado, ''))) = 'ACTIVA' THEN 0 ELSE 1 END,
      p.updated_at DESC,
      p.id DESC
  `).bind(...binds).all();

  return json({
    ok: true,
    plantillas: (rows?.results || []).map(normalizarFilaPlantilla)
  });
}

async function guardarPlantilla(context, session) {
  const { request, env } = context;
  await asegurarTablaPlantillas(env);

  const formData = await request.formData();
  const plantillaId = parsearIdPositivo(formData.get("id"));
  const nombre = limpiarTexto(formData.get("nombre"));
  const descripcion = limpiarTexto(formData.get("descripcion"));
  const actividadId = parsearIdPositivo(formData.get("actividad_id"));
  const tipoGeneracion = limpiarTexto(formData.get("tipo_generacion") || "ASISTENTE").toUpperCase();
  const estado = limpiarTexto(formData.get("estado") || "ACTIVA").toUpperCase();
  const camposDetectados = parsearCamposDetectados(formData.get("campos_detectados_json") || "[]");
  const file = formData.get("file");

  if (!nombre) {
    return json({ ok: false, error: "Debes indicar un nombre para la plantilla." }, 400);
  }

  if (!actividadId) {
    return json({ ok: false, error: "Debes asociar la plantilla a una actividad válida." }, 400);
  }

  const actividad = await obtenerActividadPermitida(env, session, actividadId);
  if (!actividad) {
    return json({ ok: false, error: "La actividad seleccionada no está disponible para este administrador." }, 403);
  }

  const plantillaAnterior = plantillaId ? await obtenerPlantillaPorId(env, session, plantillaId) : null;
  if (plantillaId && !plantillaAnterior) {
    return json({ ok: false, error: "No se encontró la plantilla documental solicitada." }, 404);
  }

  let archivoNombre = limpiarTexto(plantillaAnterior?.archivo_nombre);
  let archivoUrl = limpiarTexto(plantillaAnterior?.archivo_url);
  let archivoKey = limpiarTexto(plantillaAnterior?.archivo_key);
  let archivoReemplazado = false;

  if (file instanceof File && Number(file.size || 0) > 0) {
    const upload = await subirPdfPlantilla({
      env,
      session,
      actividadId,
      nombrePlantilla: nombre,
      file
    });
    archivoNombre = upload.archivo_nombre;
    archivoUrl = upload.archivo_url;
    archivoKey = upload.archivo_key;
    archivoReemplazado = true;
  }

  if (!archivoUrl) {
    return json({ ok: false, error: "Debes importar una plantilla PDF antes de guardar." }, 400);
  }

  const valores = [
    actividadId,
    nombre,
    descripcion,
    ["ASISTENTE", "SOLICITUD", "GRUPO"].includes(tipoGeneracion) ? tipoGeneracion : "ASISTENTE",
    ["ACTIVA", "PAUSA"].includes(estado) ? estado : "ACTIVA",
    archivoNombre,
    archivoUrl,
    archivoKey,
    JSON.stringify(camposDetectados),
    new Date().toISOString()
  ];
  const marcaTiempo = new Date().toISOString();

  let plantillaGuardada = null;

  if (plantillaAnterior) {
    await env.DB.prepare(`
      UPDATE admin_plantillas_documentales
      SET actividad_id = ?,
          nombre = ?,
          descripcion = ?,
          tipo_generacion = ?,
          estado = ?,
          archivo_nombre = ?,
          archivo_url = ?,
          archivo_key = ?,
          campos_detectados_json = ?,
          updated_at = ?
      WHERE id = ?
    `).bind(...valores, plantillaAnterior.id).run();

    plantillaGuardada = await obtenerPlantillaPorId(env, session, plantillaAnterior.id);

    const oldKey = limpiarTexto(plantillaAnterior.archivo_key);
    if (archivoReemplazado && oldKey && oldKey !== archivoKey) {
      const referencias = await contarReferenciasArchivo(env, oldKey, plantillaAnterior.id);
      if (referencias === 0 && env.DOCS_BUCKET) {
        await env.DOCS_BUCKET.delete(oldKey);
      }
    }
  } else {
    const insert = await env.DB.prepare(`
      INSERT INTO admin_plantillas_documentales (
        admin_id,
        actividad_id,
        nombre,
        descripcion,
        tipo_generacion,
        estado,
        archivo_nombre,
        archivo_url,
        archivo_key,
        campos_detectados_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      session.usuario_id,
      actividadId,
      nombre,
      descripcion,
      ["ASISTENTE", "SOLICITUD", "GRUPO"].includes(tipoGeneracion) ? tipoGeneracion : "ASISTENTE",
      ["ACTIVA", "PAUSA"].includes(estado) ? estado : "ACTIVA",
      archivoNombre,
      archivoUrl,
      archivoKey,
      JSON.stringify(camposDetectados),
      marcaTiempo,
      marcaTiempo
    ).run();

    const newId = Number(insert?.meta?.last_row_id || 0);
    plantillaGuardada = await obtenerPlantillaPorId(env, session, newId);
  }

  return json({
    ok: true,
    mensaje: plantillaAnterior
      ? "Plantilla documental actualizada correctamente."
      : "Plantilla documental guardada correctamente.",
    plantilla: normalizarFilaPlantilla({
      ...plantillaGuardada,
      actividad_titulo: actividad.titulo_publico || actividad.nombre || "",
      actividad_nombre: actividad.nombre || actividad.titulo_publico || ""
    })
  });
}

async function duplicarPlantilla(context, session, payload) {
  const { env } = context;
  await asegurarTablaPlantillas(env);

  const plantillaId = parsearIdPositivo(payload?.id);
  if (!plantillaId) {
    return json({ ok: false, error: "Debes indicar una plantilla válida para duplicar." }, 400);
  }

  const origen = await obtenerPlantillaPorId(env, session, plantillaId);
  if (!origen) {
    return json({ ok: false, error: "No se encontró la plantilla documental solicitada." }, 404);
  }

  const ahora = new Date().toISOString();
  const insert = await env.DB.prepare(`
    INSERT INTO admin_plantillas_documentales (
      admin_id,
      actividad_id,
      nombre,
      descripcion,
      tipo_generacion,
      estado,
      archivo_nombre,
      archivo_url,
      archivo_key,
      campos_detectados_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    origen.admin_id,
    origen.actividad_id,
    `${limpiarTexto(origen.nombre) || "Plantilla"} (copia)`,
    limpiarTexto(origen.descripcion),
    limpiarTexto(origen.tipo_generacion || "ASISTENTE") || "ASISTENTE",
    limpiarTexto(origen.estado || "ACTIVA") || "ACTIVA",
    limpiarTexto(origen.archivo_nombre),
    limpiarTexto(origen.archivo_url),
    limpiarTexto(origen.archivo_key),
    origen.campos_detectados_json || "[]",
    ahora,
    ahora
  ).run();

  const nueva = await obtenerPlantillaPorId(env, session, Number(insert?.meta?.last_row_id || 0));
  const actividad = await obtenerActividadPermitida(env, session, Number(nueva?.actividad_id || 0));

  return json({
    ok: true,
    mensaje: "Se ha creado una copia de la plantilla documental.",
    plantilla: normalizarFilaPlantilla({
      ...nueva,
      actividad_titulo: actividad?.titulo_publico || actividad?.nombre || "",
      actividad_nombre: actividad?.nombre || actividad?.titulo_publico || ""
    })
  });
}

async function eliminarPlantilla(context, session, payload) {
  const { env } = context;
  await asegurarTablaPlantillas(env);

  const plantillaId = parsearIdPositivo(payload?.id);
  if (!plantillaId) {
    return json({ ok: false, error: "Debes indicar una plantilla válida para eliminar." }, 400);
  }

  const plantilla = await obtenerPlantillaPorId(env, session, plantillaId);
  if (!plantilla) {
    return json({ ok: false, error: "No se encontró la plantilla documental solicitada." }, 404);
  }

  await env.DB.prepare(`
    DELETE FROM admin_plantillas_documentales
    WHERE id = ?
  `).bind(plantillaId).run();

  const archivoKey = limpiarTexto(plantilla.archivo_key);
  if (archivoKey) {
    const referencias = await contarReferenciasArchivo(env, archivoKey);
    if (referencias === 0 && env.DOCS_BUCKET) {
      await env.DOCS_BUCKET.delete(archivoKey);
    }
  }

  return json({
    ok: true,
    mensaje: "Plantilla documental eliminada correctamente.",
    plantilla_id: plantillaId
  });
}

export async function onRequestGet(context) {
  const session = await getAdminSession(context.request, context.env);
  if (!session) {
    return json({ ok: false, error: "No autorizado." }, 401);
  }

  try {
    return await listarPlantillas(context, session);
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudieron cargar las plantillas documentales.",
      detalle: error?.message || String(error)
    }, 500);
  }
}

export async function onRequestPost(context) {
  const session = await getAdminSession(context.request, context.env);
  if (!session) {
    return json({ ok: false, error: "No autorizado." }, 401);
  }

  try {
    const contentType = String(context.request.headers.get("content-type") || "").toLowerCase();

    if (contentType.includes("multipart/form-data")) {
      return await guardarPlantilla(context, session);
    }

    const body = await context.request.json().catch(() => null);
    const action = limpiarTexto(body?.action).toLowerCase();

    if (action === "delete") {
      return await eliminarPlantilla(context, session, body);
    }

    if (action === "duplicate") {
      return await duplicarPlantilla(context, session, body);
    }

    return json({ ok: false, error: "Acción no reconocida para plantillas documentales." }, 400);
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudo procesar la plantilla documental.",
      detalle: error?.message || String(error)
    }, 500);
  }
}
