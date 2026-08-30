import { asegurarColumnaRechazoBloqueado, asegurarColumnaRechazoEliminaEn, condicionSqlReservaOcupa } from "./_reservas_rechazo_plazo.js";

export async function asegurarColumnaAforoMaximo(env) {
  if (!env?.DB) return;

  try {
    await env.DB.prepare(`
      ALTER TABLE actividades
      ADD COLUMN aforo_maximo INTEGER
    `).run();
  } catch (error) {
    const mensaje = String(error?.message || "").toLowerCase();
    if (
      !mensaje.includes("duplicate column") &&
      !mensaje.includes("already exists") &&
      !mensaje.includes("duplicate")
    ) {
      throw error;
    }
  }
}

export async function obtenerBloqueoActividadSinFranja(env, actividadId, reservaIdExcluir = null) {
  await asegurarColumnaRechazoEliminaEn(env);
  await asegurarColumnaRechazoBloqueado(env);
  const condicionReservaOcupa = condicionSqlReservaOcupa("r");
  const excluir = Number.isInteger(Number(reservaIdExcluir)) && Number(reservaIdExcluir) > 0;
  const sql = `
    SELECT
      COALESCE(SUM(
        CASE
          WHEN ${condicionReservaOcupa} THEN
            CASE
              WHEN r.estado = 'RECHAZADA' THEN MAX(
                COALESCE(r.plazas_prereservadas, 0),
                COALESCE((
                  SELECT COUNT(*)
                  FROM visitantes v
                  WHERE v.reserva_id = r.id
                ), 0)
              )
              WHEN r.prereserva_expira_en IS NOT NULL
                   AND datetime('now') <= datetime(r.prereserva_expira_en)
                THEN MAX(
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
    FROM reservas r
    WHERE r.actividad_id = ?
      AND r.franja_id IS NULL
      ${excluir ? "AND r.id <> ?" : ""}
  `;

  const bindValues = excluir ? [actividadId, Number(reservaIdExcluir)] : [actividadId];
  const row = await env.DB.prepare(sql).bind(...bindValues).first();
  return Number(row?.ocupadas || 0);
}
