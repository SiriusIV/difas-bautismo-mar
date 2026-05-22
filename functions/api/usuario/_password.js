const encoder = new TextEncoder();

export const PASSWORD_POLICY = {
  minLength: 8
};

export function limpiarTexto(valor) {
  return String(valor || "").trim();
}

export function validarPoliticaPassword(password) {
  const valor = String(password || "");
  const errores = [];

  if (valor.length < PASSWORD_POLICY.minLength) {
    errores.push("Debe tener al menos 8 caracteres.");
  }

  if (!/[A-ZÁÉÍÓÚÜÑ]/.test(valor)) {
    errores.push("Debe incluir al menos una letra mayúscula.");
  }

  if (!/[a-záéíóúüñ]/.test(valor)) {
    errores.push("Debe incluir al menos una letra minúscula.");
  }

  if (!/[0-9]/.test(valor)) {
    errores.push("Debe incluir al menos un número.");
  }

  if (!/[^A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ]/.test(valor)) {
    errores.push("Debe incluir al menos un carácter especial.");
  }

  return {
    ok: errores.length === 0,
    errores
  };
}

export function mensajePoliticaPassword() {
  return "La contraseña debe tener al menos 8 caracteres e incluir una mayúscula, una minúscula, un número y un carácter especial.";
}

export async function hashPassword(password) {
  const data = encoder.encode(String(password || ""));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

export async function hashToken(token) {
  return hashPassword(token);
}

export function generarTokenSeguro(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function asegurarTablaResetPassword(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS password_reset_tokens (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "user_id INTEGER NOT NULL, " +
      "token_hash TEXT NOT NULL UNIQUE, " +
      "expires_at TEXT NOT NULL, " +
      "used_at TEXT, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')), " +
      "FOREIGN KEY (user_id) REFERENCES usuarios(id)" +
    ")"
  ).run();

  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id " +
    "ON password_reset_tokens(user_id)"
  ).run();

  await db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash " +
    "ON password_reset_tokens(token_hash)"
  ).run();
}

export async function asegurarColumnaForzarCambioPassword(db) {
  try {
    await db.prepare(
      "ALTER TABLE usuarios ADD COLUMN forzar_cambio_password INTEGER NOT NULL DEFAULT 0"
    ).run();
  } catch (error) {
    const detalle = String(error?.message || "").toLowerCase();
    if (
      detalle.includes("duplicate column name") ||
      detalle.includes("duplicate") ||
      detalle.includes("already exists")
    ) {
      return;
    }
    throw error;
  }
}
