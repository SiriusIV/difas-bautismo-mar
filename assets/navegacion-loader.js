(function () {
  const RETARDO_MS = 450;
  const LIMITE_SEGURIDAD_MS = 8000;
  const COMPROBACIONES_NAVEGACION_MS = [0, 120, 350, 700, 1200, 2000];
  let temporizador = null;
  let temporizadorSeguridad = null;
  let overlay = null;
  let tokenProgramacion = 0;

  function inyectarEstilos() {
    if (document.getElementById("estilosNavegacionLoader")) return;
    const style = document.createElement("style");
    style.id = "estilosNavegacionLoader";
    style.textContent = `
      .navegacion-loader {
        position: fixed;
        inset: 0;
        z-index: 99999;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(9, 26, 48, 0.28);
        backdrop-filter: blur(2px);
      }
      .navegacion-loader.activo {
        display: flex;
      }
      .navegacion-loader-card {
        min-width: 190px;
        padding: 20px 24px;
        border: 1px solid rgba(180, 198, 222, 0.8);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 16px 36px rgba(9, 26, 48, 0.22);
        color: #083766;
        font-family: inherit;
        font-weight: 700;
        text-align: center;
      }
      .navegacion-loader-spinner {
        width: 34px;
        height: 34px;
        margin: 0 auto 10px;
        border: 4px solid #dbe8f8;
        border-top-color: #1263d8;
        border-radius: 999px;
        animation: navegacion-loader-giro 0.8s linear infinite;
      }
      .navegacion-loader-texto {
        font-size: 0.95rem;
      }
      @keyframes navegacion-loader-giro {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  function obtenerOverlay() {
    if (overlay) return overlay;
    inyectarEstilos();
    overlay = document.createElement("div");
    overlay.className = "navegacion-loader";
    overlay.setAttribute("aria-live", "polite");
    overlay.setAttribute("aria-label", "Cargando página");
    overlay.innerHTML = `
      <div class="navegacion-loader-card" role="status">
        <div class="navegacion-loader-spinner" aria-hidden="true"></div>
        <div class="navegacion-loader-texto">Cargando página...</div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function mostrarLoader() {
    obtenerOverlay().classList.add("activo");
    if (temporizadorSeguridad) clearTimeout(temporizadorSeguridad);
    temporizadorSeguridad = setTimeout(() => {
      temporizadorSeguridad = null;
      if (!document.hidden) ocultarLoader();
    }, LIMITE_SEGURIDAD_MS);
  }

  function ocultarLoader() {
    if (temporizador) {
      clearTimeout(temporizador);
      temporizador = null;
    }
    if (temporizadorSeguridad) {
      clearTimeout(temporizadorSeguridad);
      temporizadorSeguridad = null;
    }
    if (overlay) overlay.classList.remove("activo");
  }

  function programarLoader() {
    tokenProgramacion += 1;
    ocultarLoader();
    const tokenActual = tokenProgramacion;
    temporizador = setTimeout(() => {
      if (tokenActual !== tokenProgramacion) return;
      temporizador = null;
      mostrarLoader();
    }, RETARDO_MS);
  }

  function cancelarLoaderProgramado() {
    tokenProgramacion += 1;
    ocultarLoader();
  }

  function esEnlaceNavegable(enlace) {
    if (!(enlace instanceof HTMLAnchorElement)) return false;
    if (enlace.target && enlace.target !== "_self") return false;
    if (enlace.hasAttribute("download")) return false;
    const href = String(enlace.getAttribute("href") || "").trim();
    if (!href || href === "#" || href.toLowerCase().startsWith("javascript:")) return false;
    if (/^(mailto|tel):/i.test(href)) return false;
    try {
      const url = new URL(enlace.href, window.location.href);
      return url.href !== window.location.href || !!url.hash;
    } catch (_) {
      return false;
    }
  }

  function esControlNavegable(control) {
    if (!(control instanceof HTMLElement)) return false;
    if (control.closest("[data-no-page-loader], .sin-page-loader")) return false;
    if (control instanceof HTMLButtonElement && control.disabled) return false;
    const onclick = String(control.getAttribute("onclick") || "");
    if (/(abrirModalLogin|cerrarModalLogin|recuperarPassword|volverAModalLogin)/i.test(onclick)) return false;
    if (/(location|\.href|assign\s*\(|replace\s*\()/i.test(onclick)) return true;
    if (control.hasAttribute("data-page-loader")) return true;
    return false;
  }

  function esControlConNavegacionProbable(control) {
    if (!(control instanceof HTMLElement)) return false;
    if (control.closest("[data-no-page-loader], .sin-page-loader")) return false;
    if (control instanceof HTMLButtonElement && control.disabled) return false;
    const textoNavegacion = [
      control.id,
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      control.textContent
    ].join(" ");
    return /\b(volver|portal|panel|calendario|actividad|actividades|reserva|reservas|solicitud|solicitudes|perfil|editar|plantillas|informes|usuarios|salir)\b/i.test(textoNavegacion);
  }

  function comprobarNavegacionDiferida(urlInicial, control) {
    let activado = false;
    COMPROBACIONES_NAVEGACION_MS.forEach((retardo) => {
      setTimeout(() => {
        if (activado) return;
        if (!document.body.contains(control)) return;
        const urlActual = window.location.href;
        const navega = document.hidden || urlActual !== urlInicial;
        if (navega) {
          activado = true;
          programarLoader();
        }
      }, retardo);
    });
  }

  function manejarClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const enlace = target.closest("a[href]");
    if (esEnlaceNavegable(enlace)) {
      programarLoader();
      return;
    }
    const control = target.closest("button, [role='button'], input[type='submit']");
    if (esControlNavegable(control)) {
      programarLoader();
      return;
    }
    if (esControlConNavegacionProbable(control)) {
      comprobarNavegacionDiferida(window.location.href, control);
    }
  }

  function envolverNavegacionProgramatica() {
    try {
      const assignOriginal = window.location.assign.bind(window.location);
      window.location.assign = function (url) {
        programarLoader();
        return assignOriginal(url);
      };
    } catch (_) {}
    try {
      const replaceOriginal = window.location.replace.bind(window.location);
      window.location.replace = function (url) {
        programarLoader();
        return replaceOriginal(url);
      };
    } catch (_) {}
  }

  function initNavegacionLoader() {
    window.NavegacionLoader = {
      programar: programarLoader,
      ocultar: ocultarLoader,
      cancelar: cancelarLoaderProgramado
    };
    envolverNavegacionProgramatica();
    document.addEventListener("click", manejarClick, true);
    window.addEventListener("pageshow", ocultarLoader);
    window.addEventListener("pagehide", ocultarLoader);
    window.addEventListener("popstate", cancelarLoaderProgramado);
    window.addEventListener("hashchange", cancelarLoaderProgramado);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) ocultarLoader();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNavegacionLoader);
  } else {
    initNavegacionLoader();
  }
})();
