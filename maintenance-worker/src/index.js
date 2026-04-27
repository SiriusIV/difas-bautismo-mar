import { ejecutarMantenimientoReservas } from "../../functions/api/_reservas_mantenimiento.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(ejecutarMantenimientoReservas(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, worker: "reservas-mantenimiento-cron" });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      try {
        const resultado = await ejecutarMantenimientoReservas(env);
        return json({
          ok: true,
          mensaje: "Mantenimiento ejecutado manualmente desde el worker.",
          ...resultado
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: "No se pudo ejecutar el mantenimiento.",
            detalle: error.message
          },
          500
        );
      }
    }

    return json(
      {
        ok: true,
        worker: "reservas-mantenimiento-cron",
        rutas: ["/health", "/run (POST)"]
      },
      200
    );
  }
};
