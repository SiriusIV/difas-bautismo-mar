(function () {
  const MEDIA_QUERY = "(max-width: 700px)";
  const SELECTOR_MODAL_EXCLUIDO = [
    ".modal",
    ".modal-login",
    ".modal-fondo",
    ".modal-contenido",
    ".modal-doc-base",
    ".modal-panel",
    ".modal-ventana",
    ".mensaje-modal-admin",
    ".mensaje-modal-panel",
    ".mensaje-modal-detalle",
    ".confirmacion-envio-mensaje"
  ].join(", ");

  function esMovil() {
    return window.matchMedia(MEDIA_QUERY).matches;
  }

  function estaDentroDeModal(el) {
    if (!(el instanceof HTMLElement)) return false;
    return !!el.closest(SELECTOR_MODAL_EXCLUIDO);
  }

  function tieneContenidoVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) {
      return false;
    }
    if (el.hidden) return false;
    return el.textContent.trim() !== "" || !!el.querySelector("button, a, input, textarea, select");
  }

  function sincronizarMensaje(el) {
    if (!(el instanceof HTMLElement)) return;
    const elegible = esMovil() && !estaDentroDeModal(el);
    el.classList.toggle("mensaje-mobile-flotante", elegible);
    el.classList.toggle("mensaje-mobile-flotante-activa", elegible && tieneContenidoVisible(el));
  }

  function registrarMensaje(el) {
    if (!(el instanceof HTMLElement) || el.dataset.mobileMensajeRegistrado === "1") return;
    el.dataset.mobileMensajeRegistrado = "1";
    sincronizarMensaje(el);

    const observer = new MutationObserver(() => sincronizarMensaje(el));
    observer.observe(el, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
      childList: true,
      subtree: true
    });
  }

  function registrarMensajesExistentes(root) {
    if (!(root instanceof Element || root instanceof Document)) return;
    root.querySelectorAll(".mensaje").forEach(registrarMensaje);
  }

  function initMensajesFlotantes() {
    registrarMensajesExistentes(document);

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches(".mensaje")) registrarMensaje(node);
          registrarMensajesExistentes(node);
        });
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", () => {
      document.querySelectorAll(".mensaje").forEach(sincronizarMensaje);
    }, { passive: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMensajesFlotantes);
  } else {
    initMensajesFlotantes();
  }
})();
