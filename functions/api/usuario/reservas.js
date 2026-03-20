import { requireUser } from "../_utils.js";

export async function onRequest(context) {
  try {
    const { request, env } = context;

    const user = await requireUser(request, env);
    if (!user) {
      return new Response(JSON.stringify({ ok:false }), { status:401 });
    }

    const { results } = await env.DB.prepare(`
      SELECT 
        r.id,
        r.codigo_reserva,
        r.estado,
        f.fecha,
        f.hora_inicio,
        f.hora_fin,
        r.personas,
        r.plazas_prereservadas,
        a.nombre as actividad
      FROM reservas r
      LEFT JOIN franjas f ON r.franja_id = f.id
      LEFT JOIN actividades a ON r.actividad_id = a.id
      WHERE r.usuario_id = ?
      ORDER BY f.fecha DESC, f.hora_inicio DESC
    `).bind(user.id).all();

    return new Response(JSON.stringify({ ok:true, data:results }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error:e.message }), { status:500 });
  }
}
