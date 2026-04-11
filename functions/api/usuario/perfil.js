import { getUserSession } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getUserSession(request, env.SECRET_KEY);

    if (!session || !session.id) {
      return json(
        { ok: false, error: "No autorizado" },
        401
      );
    }

    const user = await env.DB.prepare(`
      SELECT
        id,
        nombre,
        nombre_publico,
        localidad,
        centro,
        email,
        telefono_contacto,
        responsable_legal,
        tipo_documento,
        documento_identificacion,
        web_externa_url,
        logo_url,
        rol
      FROM usuarios
      WHERE id = ?
      LIMIT 1
    `).bind(session.id).first();

    if (!user) {
      return json(
        { ok: false, error: "Usuario no encontrado" },
        404
      );
    }

    return json({
      ok: true,
      perfil: {
        id: user.id,
        nombre: user.nombre || "",
        nombre_publico: user.nombre_publico || "",
        localidad: user.localidad || "",
        centro: user.centro || "",
        email: user.email || "",
        telefono_contacto: user.telefono_contacto || "",
        responsable_legal: user.responsable_legal || "",
        tipo_documento: user.tipo_documento || "",
        documento_identificacion: user.documento_identificacion || "",
        web_externa_url: user.web_externa_url || "",
        logo_url: user.logo_url || "",
        rol: user.rol || ""
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Error al cargar el perfil",
        detalle: error.message
      },
      500
    );
  }
}
