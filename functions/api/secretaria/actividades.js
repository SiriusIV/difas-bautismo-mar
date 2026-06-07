import { getUserSession } from "../usuario/_auth.js";
import {
  construirResumenDocumentacionActividad,
  obtenerCatalogoDocumentosActivosAdmin,
  obtenerConfiguracionDocumentalPorActividades
} from "../_actividad_documentacion.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
    },
    ...init
  });
}

async function desactivarActividadesFinalizadasPorPeriodo(env) {
  await env.DB.prepare(`
    UPDATE actividades
    SET activa = 0,
        visible_portal = 0
    WHERE tipo = 'TEMPORAL'
      AND fecha_fin IS NOT NULL
      AND date(fecha_fin) < date('now')
      AND (
        COALESCE(activa, 0) <> 0
        OR COALESCE(visible_portal, 0) <> 0
      )
  `).run();
}

async function obtenerRequisitosPorActividades(env, actividadIds) {
  const ids = Array.from(
    new Set((actividadIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))
  );
  if (!ids.length) return new Map();

  try {
    const placeholders = ids.map(() => "?").join(", ");
    let result;
    try {
      result = await env.DB.prepare(`
        SELECT actividad_id, texto, COALESCE(activo, 1) AS activo
        FROM actividad_requisitos
        WHERE actividad_id IN (${placeholders})
        ORDER BY actividad_id ASC, orden ASC, id ASC
      `).bind(...ids).all();
    } catch (error) {
      result = await env.DB.prepare(`
        SELECT actividad_id, texto
        FROM actividad_requisitos
        WHERE actividad_id IN (${placeholders})
        ORDER BY actividad_id ASC, orden ASC, id ASC
      `).bind(...ids).all();
    }

    const mapa = new Map();
    for (const row of result?.results || []) {
      const actividadId = Number(row.actividad_id || 0);
      if (!mapa.has(actividadId)) mapa.set(actividadId, []);
      mapa.get(actividadId).push({
        texto: String(row.texto || "").trim(),
        activo: Number(row.activo ?? 1) === 0 ? 0 : 1
      });
    }
    return mapa;
  } catch (_) {
    return new Map();
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    await desactivarActividadesFinalizadasPorPeriodo(env);
    const session = await getUserSession(request, env.SECRET_KEY);
    if (!session?.id) {
      return json({ ok: false, error: "No autorizado." }, { status: 401 });
    }

    if (String(session.rol || "").toUpperCase() !== "SECRETARIA") {
      return json({ ok: false, error: "No autorizado." }, { status: 403 });
    }

    const adminsResult = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM usuarios
      WHERE secretaria_usuario_id = ?
        AND COALESCE(modulo_secretaria, 0) = 0
        AND rol = 'ADMIN'
    `).bind(session.id).first();

    const result = await env.DB.prepare(`
      WITH admins_secretaria AS (
        SELECT id
        FROM usuarios
        WHERE secretaria_usuario_id = ?
          AND COALESCE(modulo_secretaria, 0) = 0
          AND rol = 'ADMIN'
      ),
      franja_ocupacion AS (
        SELECT
          f.id AS franja_id,
          f.actividad_id,
          f.capacidad,
          COALESCE(SUM(
            CASE
              WHEN r.estado IN ('PENDIENTE', 'CONFIRMADA', 'SUSPENDIDA') THEN
                CASE
                  WHEN r.prereserva_expira_en IS NOT NULL
                       AND datetime('now') <= datetime(r.prereserva_expira_en)
                    THEN max(
                      COALESCE(r.plazas_prereservadas, 0),
                      COALESCE((
                        SELECT COUNT(*)
                        FROM visitantes v
                        WHERE v.reserva_id = r.id
                      ), 0)
                    )
                  ELSE COALESCE((
                    SELECT COUNT(*)
                    FROM visitantes v
                    WHERE v.reserva_id = r.id
                  ), 0)
                END
              ELSE 0
            END
          ), 0) AS ocupadas
        FROM franjas f
        LEFT JOIN reservas r
          ON r.franja_id = f.id
        GROUP BY
          f.id,
          f.actividad_id,
          f.capacidad
      ),
      actividad_totales AS (
        SELECT
          actividad_id,
          COALESCE(SUM(capacidad), 0) AS plazas_totales,
          COALESCE(SUM(ocupadas), 0) AS plazas_ocupadas
        FROM franja_ocupacion
        GROUP BY actividad_id
      ),
      actividad_franja_final AS (
        SELECT
          actividad_id,
          MAX(CASE WHEN COALESCE(es_recurrente, 0) = 1 THEN 1 ELSE 0 END) AS tiene_franjas_recurrentes,
          MAX(
            CASE
              WHEN COALESCE(es_recurrente, 0) = 0 AND fecha IS NOT NULL AND hora_fin IS NOT NULL
                THEN datetime(fecha || ' ' || hora_fin)
              ELSE NULL
            END
          ) AS ultima_franja_fin
        FROM franjas
        GROUP BY actividad_id
      )
      SELECT
        a.id,
        a.nombre,
        a.tipo,
        a.fecha_inicio,
        a.fecha_fin,
        a.titulo_publico,
        a.subtitulo_publico,
        a.descripcion_corta,
        a.lugar,
        a.imagen_url,
        a.imagen_id,
        a.activa,
        a.visible_portal,
        a.orden_portal,
        a.organizador_publico,
        a.latitud,
        a.longitud,
        a.direccion_postal,
        a.zoom_mapa,
        a.usa_franjas,
        a.requiere_reserva,
        a.aforo_limitado,
        COALESCE(a.aforo_maximo, 0) AS aforo_maximo,
        a.admin_id,
        a.provincia,
        a.es_recurrente,
        a.patron_recurrencia,
        a.usa_enlace_externo,
        a.enlace_externo_url,
        u.web_externa_url AS organizador_web_externa_url,
        CASE
          WHEN TRIM(COALESCE(u.web_externa_url, '')) <> '' THEN
            COALESCE(u.web_externa_activa, 1)
          ELSE 0
        END AS organizador_web_externa_activa,
        COALESCE(at.plazas_totales, 0) AS plazas_totales,
        COALESCE(at.plazas_ocupadas, 0) AS plazas_ocupadas,
        (COALESCE(at.plazas_totales, 0) - COALESCE(at.plazas_ocupadas, 0)) AS plazas_disponibles,
        COALESCE(aff.tiene_franjas_recurrentes, 0) AS tiene_franjas_recurrentes,
        aff.ultima_franja_fin,
        CASE
          WHEN a.aforo_limitado = 1
               AND a.usa_franjas = 1
               AND COALESCE(at.plazas_totales, 0) > 0
               AND (COALESCE(at.plazas_totales, 0) - COALESCE(at.plazas_ocupadas, 0)) <= 0
            THEN 1
          ELSE 0
        END AS completa_calculada
      FROM actividades a
      INNER JOIN admins_secretaria s
        ON s.id = a.admin_id
      LEFT JOIN usuarios u
        ON u.id = a.admin_id
      LEFT JOIN actividad_totales at
        ON at.actividad_id = a.id
      LEFT JOIN actividad_franja_final aff
        ON aff.actividad_id = a.id
      WHERE a.activa = 1
        AND a.visible_portal = 1
        AND (
          a.tipo = 'PERMANENTE'
          OR (
            a.tipo = 'TEMPORAL'
            AND (
              a.fecha_fin IS NULL
              OR date(a.fecha_fin) >= date('now')
            )
          )
        )
      ORDER BY a.orden_portal ASC, a.id ASC
    `).bind(session.id).all();

    const actividadesRaw = result.results || [];
    const actividadIds = actividadesRaw.map((a) => Number(a.id || 0)).filter((id) => id > 0);
    const requisitosPorActividad = await obtenerRequisitosPorActividades(env, actividadIds);
    const configuracionDocumentalPorActividad = await obtenerConfiguracionDocumentalPorActividades(env, actividadIds);
    const catalogoDocumentacionPorAdmin = new Map();
    const adminIds = Array.from(
      new Set(actividadesRaw.map((a) => Number(a.admin_id || 0)).filter((id) => id > 0))
    );

    for (const adminId of adminIds) {
      catalogoDocumentacionPorAdmin.set(
        adminId,
        await obtenerCatalogoDocumentosActivosAdmin(env, adminId)
      );
    }

    const catalogoDocumentacionSecretaria = await obtenerCatalogoDocumentosActivosAdmin(env, Number(session.id || 0));

    return json({
      ok: true,
      admins_asociados: Number(adminsResult?.total || 0),
      catalogo_documentacion_admin: catalogoDocumentacionSecretaria,
      actividades: actividadesRaw.map((a) => {
        const actividadId = Number(a.id || 0);
        const adminId = Number(a.admin_id || 0);
        const catalogoActividad = catalogoDocumentacionPorAdmin.get(adminId) || [];
        const configuracionActividad = configuracionDocumentalPorActividad.get(actividadId) || null;
        return {
        documentacion_actividad: construirResumenDocumentacionActividad(
          catalogoActividad,
          configuracionActividad
        ),
        documentos_admin_activos: catalogoActividad,
        puede_editar_documentacion_actividad: true,
        ...a,
        plazas_totales: Number(a.plazas_totales || 0),
        plazas_ocupadas: Number(a.plazas_ocupadas || 0),
        plazas_disponibles: Number(a.plazas_disponibles || 0),
        requisitos_particulares: requisitosPorActividad.get(actividadId) || [],
        completa_calculada: Number(a.completa_calculada || 0)
      };
      })
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "No se pudieron cargar las actividades de la secretaría.",
        detalle: error.message
      },
      { status: 500 }
    );
  }
}
