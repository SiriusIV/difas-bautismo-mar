import { getSecretariaSession, obtenerSecretariaPerfil, obtenerAdminsAdscritos, obtenerDocumentosBaseSecretaria } from "./_documental.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function construirResumenDocumentacion(documentos) {
  const activos = documentos.filter((doc) => Number(doc.activo || 0) === 1).length;
  if (!documentos.length) return "No hay documentos base definidos actualmente.";
  return activos > 0 ? `${activos} documento(s) activo(s).` : "No hay documentos base activos actualmente.";
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getSecretariaSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const secretaria = await obtenerSecretariaPerfil(env, session.usuario_id);
    if (!secretaria) {
      return json({ ok: false, error: "Secretaría no encontrada." }, 404);
    }

    const [documentos, admins] = await Promise.all([
      obtenerDocumentosBaseSecretaria(env, session.usuario_id),
      obtenerAdminsAdscritos(env, session.usuario_id)
    ]);

    const versionActual = documentos.reduce(
      (max, doc) => Math.max(max, Number(doc.version_documental || 0)),
      0
    );

    return json({
      ok: true,
      admin_id: Number(secretaria.id || 0),
      modo_documental: "SECRETARIA",
      modo_documental_etiqueta: "Secretaría",
      editable: true,
      propietario_documental_id: Number(secretaria.id || 0),
      resumen: construirResumenDocumentacion(documentos),
      observacion: "",
      admin: secretaria,
      responsable_documental: secretaria,
      secretaria: secretaria,
      admins_adscritos_total: admins.length,
      version_actual: versionActual > 0 ? versionActual : 1,
      documentos: documentos.map((row) => ({
        id: Number(row.id || 0),
        admin_id: Number(row.admin_id || 0),
        nombre: row.nombre || "",
        descripcion: row.descripcion || "",
        archivo_url: row.archivo_url || "",
        orden: Number(row.orden || 0),
        activo: Number(row.activo || 0) === 1,
        version_documental: Number(row.version_documental || 0),
        fecha_actualizacion: row.fecha_actualizacion || ""
      }))
    });
  } catch (error) {
    return json({
      ok: false,
      error: "No se pudo cargar el contexto documental de la secretaría.",
      detalle: error.message
    }, 500);
  }
}
