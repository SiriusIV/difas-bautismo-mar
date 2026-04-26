import { getAdminSession } from "./_auth.js";
import { getRolUsuario } from "./_permisos.js";
import { ejecutarMantenimientoReservas } from "../_reservas_mantenimiento.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const session = await getAdminSession(request, env);
    if (!session) {
      return json({ ok: false, error: "No autorizado." }, 401);
    }

    const rol = await getRolUsuario(env, session.usuario_id);
    if (!["ADMIN", "SUPERADMIN"].includes(String(rol || "").toUpperCase())) {
      return json({ ok: false, error: "No autorizado." }, 403);
    }

    const resultado = await ejecutarMantenimientoReservas(env);
    return json({
      ok: true,
      mensaje: "Mantenimiento de reservas ejecutado correctamente.",
      ...resultado
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudo ejecutar el mantenimiento de reservas.",
        detalle: error.message
      },
      500
    );
  }
}
