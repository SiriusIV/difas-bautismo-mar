export async function asegurarTablaSolicitudesArmada(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS solicitudes_registro_armada (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      centro TEXT NOT NULL,
      localidad TEXT,
      responsable_legal TEXT NOT NULL,
      tipo_documento TEXT NOT NULL,
      documento_identificacion TEXT NOT NULL,
      email TEXT NOT NULL,
      telefono_contacto TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'PENDIENTE',
      fecha_solicitud TEXT NOT NULL DEFAULT (datetime('now')),
      fecha_resolucion TEXT,
      resuelto_por_superadmin_id INTEGER,
      motivo_resolucion TEXT,
      usuario_creado_id INTEGER
    )
  `).run();
}

export function limpiarTexto(valor) {
  return String(valor || "").trim();
}

export function normalizarCentro(valor) {
  return limpiarTexto(valor).replace(/\s+/g, " ").toUpperCase();
}

export function generarPasswordTemporal() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*_-";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return `${out}A1!`;
}
