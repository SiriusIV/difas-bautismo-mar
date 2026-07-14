import { getAdminSession } from "./_auth.js";
import { listarUsuariosArmada } from "./_admins_gestion.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado" }, 401);
    }

    if (String(session.rol || "").toUpperCase() !== "SUPERADMIN") {
      return json({ ok: false, error: "Solo SUPERADMIN" }, 403);
    }

    const usuariosArmada = await listarUsuariosArmada(env);

    return json({
      ok: true,
      usuarios: usuariosArmada.administradores,
      administradores: usuariosArmada.administradores,
      secretarias: usuariosArmada.secretarias
    });
  } catch (error) {
    return json(
      { ok: false, error: "Error cargando usuarios", detalle: error.message },
      500
    );
  }
}
