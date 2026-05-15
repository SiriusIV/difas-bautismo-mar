const LEGACY_STORAGE_KEY = "difas_plantillas_documentales_borradores_v1";
let usuarioSesion = null;
let actividadesCache = [];
let plantillasCache = [];
let plantillaActual = null;
let archivoPdfSesion = null;
let temporizadorMensaje = null;
let hayCambiosSinGuardar = false;
let actividadInicialURL = null;

function aplicarLogoAdminArfer(img, usuario = {}) { if (!img) return; img.style.width = ""; const logo = String(usuario?.logo_url || "").trim(); img.classList.remove("logo-admin-personal"); img.src = logo || "logo.png"; if (logo) img.classList.add("logo-admin-personal"); img.classList.remove("logo-pendiente"); }
function escapeHtml(v) { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function limpiarTexto(v) { return String(v ?? "").trim(); }
function normalizarComparacion(texto) { return limpiarTexto(texto).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function mostrarMensaje(tipo, texto) { const el = document.getElementById("mensaje"), manual = tipo === "error"; el.className = `mensaje ${tipo}`; el.style.display = "block"; el.innerHTML = `<div class="mensaje-inner"><div>${escapeHtml(texto)}</div>${manual ? `<button type="button" class="mensaje-cerrar" aria-label="Cerrar aviso">×</button>` : ""}</div>`; if (temporizadorMensaje) { clearTimeout(temporizadorMensaje); temporizadorMensaje = null; } if (!manual) { temporizadorMensaje = setTimeout(limpiarMensaje, 4000); } else { el.querySelector(".mensaje-cerrar")?.addEventListener("click", limpiarMensaje); } }
function limpiarMensaje() { const el = document.getElementById("mensaje"); el.className = "mensaje"; el.style.display = "none"; el.innerHTML = ""; if (temporizadorMensaje) { clearTimeout(temporizadorMensaje); temporizadorMensaje = null; } }
function obtenerActividadPorId(id) { return actividadesCache.find((a) => Number(a.id) === Number(id)) || null; }
function plantillaVacia() { return { id: null, nombre: "", descripcion: "", actividad_id: "", actividad_titulo: "", tipo_generacion: "ASISTENTE", estado: "ACTIVA", archivo_nombre: "", archivo_url: "", archivo_key: "", campos_detectados: [], created_at: "", updated_at: "" }; }
function actualizarEstadoSesion(texto) { const el = document.getElementById("textoEstadoSesion"); if (el) el.textContent = texto; }
function marcarCambiosPendientes() { hayCambiosSinGuardar = true; actualizarEstadoSesion("Hay cambios sin guardar en esta plantilla."); }
function reiniciarEstadoCambios() { hayCambiosSinGuardar = false; actualizarEstadoSesion(""); }
function obtenerActividadInicialURL() { const params = new URLSearchParams(window.location.search); const raw = params.get("actividad_id") || ""; const id = Number.parseInt(raw, 10); return Number.isInteger(id) && id > 0 ? id : null; }
function poblarSelectActividades() { const select = document.getElementById("actividadPlantilla"), valor = select.value; select.innerHTML = `<option value="">Selecciona una actividad</option>`; actividadesCache.forEach((a) => { const option = document.createElement("option"); option.value = String(a.id); option.textContent = a.titulo_publico || a.nombre || `Actividad ${a.id}`; select.appendChild(option); }); if (valor && actividadesCache.some((a) => String(a.id) === String(valor))) select.value = valor; }
function renderSelectorPlantillas() { const select = document.getElementById("selectorPlantillaRepositorio"); if (!select) return; const valorActual = plantillaActual?.id ? String(plantillaActual.id) : ""; select.innerHTML = ""; const vacio = document.createElement("option"); vacio.value = ""; vacio.textContent = plantillasCache.length ? "" : "No hay plantillas guardadas"; select.appendChild(vacio); plantillasCache.forEach((plantilla) => { const option = document.createElement("option"); option.value = String(plantilla.id); const actividad = plantilla.actividad_titulo || "Sin actividad asociada"; option.textContent = `${plantilla.nombre || "Plantilla sin nombre"} · ${actividad}`; select.appendChild(option); }); if (!plantillasCache.length) { select.value = ""; select.disabled = true; return; } select.disabled = false; select.value = plantillasCache.some((item) => String(item.id) === valorActual) ? valorActual : ""; }
function actualizarEstadoParserPdf() {}
function obtenerTipoCampoPdf(field) { const nombreClase = String(field?.constructor?.name || "").toLowerCase(); if (nombreClase.includes("textfield")) return "Texto"; if (nombreClase.includes("checkbox")) return "Casilla"; if (nombreClase.includes("radiogroup")) return "Opcion"; if (nombreClase.includes("dropdown")) return "Desplegable"; if (nombreClase.includes("optionlist")) return "Lista"; if (nombreClase.includes("button")) return "Boton"; if (nombreClase.includes("signature")) return "Firma"; return "Campo"; }
async function extraerCamposPdf(file) { if (!window.PDFLib?.PDFDocument) throw new Error("El lector PDF del constructor no esta disponible en este momento."); const bytes = await file.arrayBuffer(); const pdfDoc = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false }); return pdfDoc.getForm().getFields().map((field) => ({ nombre: field.getName(), tipo: obtenerTipoCampoPdf(field), modo: "VINCULADO", obligatorio: true })); }
function actualizarModoCampoDetectado(index, modo) { if (!plantillaActual?.campos_detectados?.[index]) return; plantillaActual.campos_detectados[index] = { ...plantillaActual.campos_detectados[index], modo: modo === "LIBRE" ? "LIBRE" : "VINCULADO" }; marcarCambiosPendientes(); }
function actualizarObligatorioCampoDetectado(index, obligatorio) { if (!plantillaActual?.campos_detectados?.[index]) return; plantillaActual.campos_detectados[index] = { ...plantillaActual.campos_detectados[index], obligatorio: !!obligatorio }; marcarCambiosPendientes(); }
function renderCamposDetectados() {
  const campos = Array.isArray(plantillaActual?.campos_detectados) ? plantillaActual.campos_detectados : [];
  const tabla = document.getElementById("tablaCamposDetectados");
  const vacio = document.getElementById("estadoSinCampos");
  const body = document.getElementById("tablaCamposDetectadosBody");
  if (!campos.length) {
    tabla.classList.add("oculto");
    vacio.classList.remove("oculto");
    body.innerHTML = "";
    return;
  }
  vacio.classList.add("oculto");
  tabla.classList.remove("oculto");
  body.innerHTML = campos.map((campo, index) => `<tr><td>${escapeHtml(campo.nombre || "")}</td><td><select class="tabla-campos-select" data-campo-index="${index}" data-tipo-control="dato"><option value="VINCULADO" ${String(campo.modo || "VINCULADO") === "VINCULADO" ? "selected" : ""}>Vinculado</option><option value="LIBRE" ${String(campo.modo || "VINCULADO") === "LIBRE" ? "selected" : ""}>Libre</option></select></td><td><select class="tabla-campos-select" data-campo-index="${index}" data-tipo-control="obligatorio"><option value="SI" ${campo.obligatorio === false ? "" : "selected"}>Si</option><option value="NO" ${campo.obligatorio === false ? "selected" : ""}>No</option></select></td></tr>`).join("");
  body.querySelectorAll("select[data-campo-index]").forEach((select) => {
    select.addEventListener("change", () => {
      const index = Number(select.dataset.campoIndex);
      if (select.dataset.tipoControl === "obligatorio") actualizarObligatorioCampoDetectado(index, select.value === "SI");
      else actualizarModoCampoDetectado(index, select.value);
    });
  });
}
function actualizarSubtituloSegunActividad() {}
function actualizarResumenArchivo() {
  const btnVer = document.getElementById("btnVerPdfPlantilla");
  const textoVisor = document.getElementById("textoVisorPlantilla");
  if (archivoPdfSesion?.file) {
    textoVisor.textContent = `${archivoPdfSesion.name} esta cargado en la sesion actual y quedara subido al repositorio cuando guardes la plantilla.`;
    btnVer.classList.add("oculto");
    btnVer.removeAttribute("href");
    return;
  }
  if (plantillaActual?.archivo_url) {
    btnVer.href = plantillaActual.archivo_url;
    textoVisor.textContent = `${plantillaActual.archivo_nombre || "plantilla.pdf"} ya esta almacenado en el repositorio documental del sistema.`;
    btnVer.classList.remove("oculto");
    return;
  }
  textoVisor.textContent = "Cuando esta plantilla tenga un PDF guardado en el repositorio, podras visualizarlo desde aqui.";
  btnVer.classList.add("oculto");
  btnVer.removeAttribute("href");
}
function actualizarEstadoAcciones() {
  document.getElementById("btnEliminarBorrador").disabled = !Number(plantillaActual?.id || 0);
}
function volcarPlantillaEnFormulario(plantilla) {
  plantillaActual = { ...plantillaVacia(), ...(plantilla || {}) };
  archivoPdfSesion = null;
  document.getElementById("nombrePlantilla").value = plantillaActual.nombre || "";
  document.getElementById("descripcionPlantilla").value = plantillaActual.descripcion || "";
  document.getElementById("actividadPlantilla").value = plantillaActual.actividad_id ? String(plantillaActual.actividad_id) : "";
  document.getElementById("tipoGeneracionPlantilla").value = plantillaActual.tipo_generacion || "ASISTENTE";
  document.getElementById("estadoPlantilla").value = plantillaActual.estado || "ACTIVA";
  document.getElementById("tituloEditor").textContent = plantillaActual.nombre?.trim() || "Nueva plantilla documental";
  actualizarSubtituloSegunActividad(plantillaActual.actividad_id);
  actualizarEstadoAcciones();
  document.getElementById("inputPdfPlantilla").value = "";
  actualizarResumenArchivo();
  renderCamposDetectados();
  renderSelectorPlantillas();
  reiniciarEstadoCambios();
}
function seleccionarPlantilla(id) {
  if (hayCambiosSinGuardar) mostrarMensaje("aviso", "Habia cambios sin guardar en la plantilla actual. Guardalos si quieres conservarlos antes de cambiar.");
  const encontrada = plantillasCache.find((item) => Number(item.id) === Number(id));
  volcarPlantillaEnFormulario(encontrada || plantillaVacia());
}
function crearNuevoBorrador() {
  limpiarMensaje();
  const base = plantillaVacia();
  if (actividadInicialURL && obtenerActividadPorId(actividadInicialURL)) {
    const actividad = obtenerActividadPorId(actividadInicialURL);
    base.actividad_id = Number(actividad.id);
    base.actividad_titulo = actividad.titulo_publico || actividad.nombre || "";
  }
  volcarPlantillaEnFormulario(base);
}
function crearBorradorContextualActividad(actividadId) {
  const borrador = plantillaVacia();
  const actividad = obtenerActividadPorId(actividadId);
  if (actividad) {
    borrador.actividad_id = Number(actividad.id);
    borrador.actividad_titulo = actividad.titulo_publico || actividad.nombre || "";
    borrador.nombre = `Plantilla ${borrador.actividad_titulo}`.trim();
  }
  volcarPlantillaEnFormulario(borrador);
}
function volcarFormularioEnPlantilla(base = plantillaActual) {
  if (!base) return null;
  const actividadId = document.getElementById("actividadPlantilla").value;
  const actividad = obtenerActividadPorId(actividadId);
  return {
    ...base,
    nombre: limpiarTexto(document.getElementById("nombrePlantilla").value),
    descripcion: limpiarTexto(document.getElementById("descripcionPlantilla").value),
    actividad_id: actividadId ? Number(actividadId) : "",
    actividad_titulo: actividad?.titulo_publico || actividad?.nombre || "",
    tipo_generacion: document.getElementById("tipoGeneracionPlantilla").value || "ASISTENTE",
    estado: document.getElementById("estadoPlantilla").value || "ACTIVA",
    archivo_nombre: archivoPdfSesion?.name || base.archivo_nombre || "",
    campos_detectados: Array.isArray(base.campos_detectados) ? base.campos_detectados : [],
    updated_at: new Date().toISOString()
  };
}
async function cargarPlantillasServidor() {
  const res = await fetch("/api/admin/plantillas", { credentials: "same-origin" });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.detalle || data?.error || "No se pudieron cargar las plantillas documentales.");
  plantillasCache = Array.isArray(data.plantillas) ? data.plantillas : [];
  renderSelectorPlantillas();
}
async function guardarBorradorActual() {
  limpiarMensaje();
  const plantilla = volcarFormularioEnPlantilla();
  if (!plantilla?.nombre) { mostrarMensaje("error", "Antes de guardar la plantilla debes indicar al menos un nombre interno."); return; }
  if (!plantilla?.actividad_id) { mostrarMensaje("error", "Antes de guardar la plantilla debes asociarla a una actividad concreta."); return; }
  if (!plantilla.archivo_url && !archivoPdfSesion?.file) { mostrarMensaje("error", "Debes importar una plantilla PDF antes de guardarla en el repositorio."); return; }
  const formData = new FormData();
  if (Number(plantilla.id || 0) > 0) formData.append("id", String(plantilla.id));
  formData.append("nombre", plantilla.nombre);
  formData.append("descripcion", plantilla.descripcion || "");
  formData.append("actividad_id", String(plantilla.actividad_id));
  formData.append("tipo_generacion", plantilla.tipo_generacion || "ASISTENTE");
  formData.append("estado", plantilla.estado || "ACTIVA");
  formData.append("campos_detectados_json", JSON.stringify(plantilla.campos_detectados || []));
  if (archivoPdfSesion?.file) formData.append("file", archivoPdfSesion.file, archivoPdfSesion.name || "plantilla.pdf");
  const res = await fetch("/api/admin/plantillas", { method: "POST", credentials: "same-origin", body: formData });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || !data?.plantilla) { mostrarMensaje("error", data?.detalle || data?.error || "No se pudo guardar la plantilla documental."); return; }
  const guardada = data.plantilla;
  const index = plantillasCache.findIndex((item) => Number(item.id) === Number(guardada.id));
  if (index >= 0) plantillasCache.splice(index, 1, guardada);
  else plantillasCache.unshift(guardada);
  mostrarMensaje("ok", data.mensaje || "Plantilla documental guardada correctamente.");
  volcarPlantillaEnFormulario(guardada);
}
async function eliminarBorradorActual() {
  if (!Number(plantillaActual?.id || 0)) { crearNuevoBorrador(); return; }
  limpiarMensaje();
  const res = await fetch("/api/admin/plantillas", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id: plantillaActual.id }) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) { mostrarMensaje("error", data?.detalle || data?.error || "No se pudo eliminar la plantilla documental."); return; }
  plantillasCache = plantillasCache.filter((item) => Number(item.id) !== Number(plantillaActual.id));
  mostrarMensaje("ok", data.mensaje || "Plantilla documental eliminada correctamente.");
  if (plantillasCache.length) volcarPlantillaEnFormulario(plantillasCache[0]);
  else crearNuevoBorrador();
}
async function procesarArchivoPdf(file) {
  if (!file) return;
  const nombre = String(file.name || "").toLowerCase();
  if (String(file.type || "").toLowerCase() !== "application/pdf" && !nombre.endsWith(".pdf")) { mostrarMensaje("error", "El constructor solo admite plantillas en formato PDF."); return; }
  try {
    actualizarEstadoParserPdf("Analizando PDF...");
    const campos = await extraerCamposPdf(file);
    archivoPdfSesion = { file, name: file.name, size: Number(file.size || 0) };
    plantillaActual = { ...volcarFormularioEnPlantilla(), archivo_nombre: file.name, campos_detectados: campos, updated_at: new Date().toISOString() };
    actualizarResumenArchivo();
    renderCamposDetectados();
    marcarCambiosPendientes();
    if (campos.length) {
      actualizarEstadoParserPdf("Campos detectados");
      mostrarMensaje("ok", `PDF analizado correctamente. Se han detectado ${campos.length} campo(s) rellenable(s).`);
    } else {
      actualizarEstadoParserPdf("PDF sin campos");
      mostrarMensaje("aviso", "El PDF se ha cargado, pero no se han encontrado campos rellenables. Si esperabas un formulario, revisaremos si usa otra tecnologia distinta o si los campos no son AcroForm estandar.");
    }
  } catch (error) {
    actualizarEstadoParserPdf("Error de lectura");
    mostrarMensaje("error", error?.message || "No se pudo analizar el PDF rellenable.");
  }
}
function prepararDropzone() {
  const dropzone = document.getElementById("dropzonePdfPlantilla"), input = document.getElementById("inputPdfPlantilla");
  dropzone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => procesarArchivoPdf(input.files && input.files[0] || null));
  ["dragenter", "dragover"].forEach((evento) => {
    dropzone.addEventListener(evento, (e) => { e.preventDefault(); dropzone.classList.add("activa"); });
  });
  ["dragleave", "drop"].forEach((evento) => {
    dropzone.addEventListener(evento, (e) => { e.preventDefault(); dropzone.classList.remove("activa"); });
  });
  dropzone.addEventListener("drop", (e) => procesarArchivoPdf(e.dataTransfer?.files?.[0] || null));
}
function registrarEventosFormulario() {
  ["nombrePlantilla", "descripcionPlantilla", "actividadPlantilla", "tipoGeneracionPlantilla", "estadoPlantilla"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => {
      if (id === "nombrePlantilla") document.getElementById("tituloEditor").textContent = el.value.trim() || "Nueva plantilla documental";
      marcarCambiosPendientes();
    });
    el.addEventListener("change", () => {
      if (id === "actividadPlantilla") actualizarSubtituloSegunActividad(el.value);
      if (id === "nombrePlantilla") document.getElementById("tituloEditor").textContent = el.value.trim() || "Nueva plantilla documental";
      marcarCambiosPendientes();
    });
  });
  document.getElementById("selectorPlantillaRepositorio").addEventListener("change", (event) => {
    const id = Number.parseInt(event.target.value || "", 10);
    if (Number.isInteger(id) && id > 0) seleccionarPlantilla(id);
  });
  document.getElementById("btnNuevaPlantilla").addEventListener("click", crearNuevoBorrador);
  document.getElementById("btnGuardarBorrador").addEventListener("click", guardarBorradorActual);
  document.getElementById("btnEliminarBorrador").addEventListener("click", eliminarBorradorActual);
}
async function cargarSesion() {
  const res = await fetch("/api/usuario/session", { credentials: "same-origin" }), data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || !data?.authenticated || !data?.user) { location.href = "portal.html"; return false; }
  const rol = String(data.user.rol || "").toUpperCase();
  if (rol !== "ADMIN" && rol !== "SUPERADMIN") { location.href = "portal.html"; return false; }
  usuarioSesion = data.user;
  document.getElementById("subtituloCabecera").textContent = usuarioSesion.nombre || usuarioSesion.email || "Administrador";
  aplicarLogoAdminArfer(document.getElementById("logoCabecera"), usuarioSesion);
  return true;
}
async function cargarActividades() {
  const res = await fetch("/api/admin/mis-actividades", { credentials: "same-origin" }), data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.error || "No se pudieron cargar las actividades del administrador.");
  actividadesCache = Array.isArray(data.actividades) ? data.actividades : [];
  poblarSelectActividades();
}
function cargarPlantillasLocalesLegado() { try { const raw = localStorage.getItem(LEGACY_STORAGE_KEY); const parsed = JSON.parse(raw || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
async function dataUrlAFile(dataUrl, nombreArchivo) { const response = await fetch(String(dataUrl || "")); const blob = await response.blob(); return new File([blob], nombreArchivo || "plantilla.pdf", { type: "application/pdf" }); }
function existeEquivalenteServidor(localDraft) { return plantillasCache.some((item) => Number(item.actividad_id || 0) === Number(localDraft?.actividad_id || 0) && normalizarComparacion(item.nombre) === normalizarComparacion(localDraft?.nombre) && normalizarComparacion(item.archivo_nombre) === normalizarComparacion(localDraft?.archivo_nombre)); }
async function migrarPlantillasLocalesLegadas() {
  const legacy = cargarPlantillasLocalesLegado();
  if (!legacy.length) return;
  let migradas = 0, pendientes = 0;
  for (const draft of legacy) {
    if (!draft?.nombre || !draft?.actividad_id || existeEquivalenteServidor(draft)) continue;
    const formData = new FormData();
    formData.append("nombre", limpiarTexto(draft.nombre));
    formData.append("descripcion", limpiarTexto(draft.descripcion));
    formData.append("actividad_id", String(Number(draft.actividad_id)));
    formData.append("tipo_generacion", limpiarTexto(draft.tipo_generacion || "ASISTENTE") || "ASISTENTE");
    formData.append("estado", limpiarTexto(draft.estado || "ACTIVA") || "ACTIVA");
    formData.append("campos_detectados_json", JSON.stringify(Array.isArray(draft.campos_detectados) ? draft.campos_detectados : []));
    try {
      if (String(draft.archivo_data_url || "").startsWith("data:application/pdf")) {
        const file = await dataUrlAFile(draft.archivo_data_url, draft.archivo_nombre || "plantilla.pdf");
        formData.append("file", file, file.name);
      } else { pendientes += 1; continue; }
      const res = await fetch("/api/admin/plantillas", { method: "POST", credentials: "same-origin", body: formData });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) migradas += 1; else pendientes += 1;
    } catch { pendientes += 1; }
  }
  if (migradas > 0 && pendientes === 0) localStorage.removeItem(LEGACY_STORAGE_KEY);
  if (migradas > 0) {
    await cargarPlantillasServidor();
    mostrarMensaje(pendientes > 0 ? "aviso" : "ok", pendientes > 0 ? `Se han migrado ${migradas} plantilla(s) locales al repositorio del servidor, pero aun quedan ${pendientes} pendiente(s) de revisar.` : `Se han migrado ${migradas} plantilla(s) locales al repositorio real del servidor.`);
  }
}
function seleccionarPlantillaInicial() {
  if (actividadInicialURL) {
    const deActividad = plantillasCache.find((item) => Number(item.actividad_id) === Number(actividadInicialURL));
    if (deActividad) { volcarPlantillaEnFormulario(deActividad); return; }
    if (obtenerActividadPorId(actividadInicialURL)) { crearBorradorContextualActividad(actividadInicialURL); return; }
  }
  if (plantillasCache.length) volcarPlantillaEnFormulario(plantillasCache[0]);
  else crearNuevoBorrador();
}
(async function init() {
  actividadInicialURL = obtenerActividadInicialURL();
  const ok = await cargarSesion();
  if (!ok) return;
  prepararDropzone();
  registrarEventosFormulario();
  try {
    await cargarActividades();
    await cargarPlantillasServidor();
    await migrarPlantillasLocalesLegadas();
  } catch (error) {
    mostrarMensaje("error", error?.message || "Error al cargar las plantillas documentales.");
  }
  seleccionarPlantillaInicial();
})();
