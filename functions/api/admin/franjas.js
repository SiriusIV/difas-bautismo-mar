<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Administración de reservas</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #f4f6f8;
      margin: 0;
      padding: 0;
      color: #222;
    }

    .contenedor {
      max-width: 1400px;
      margin: 40px auto;
      background: #ffffff;
      padding: 28px;
      border-radius: 10px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.08);
    }

    h1 {
      margin-top: 0;
      font-size: 28px;
    }

    h2 {
      margin-top: 6px;
      font-size: 22px;
      font-weight: normal;
    }

    .cabecera {
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      margin-bottom: 20px;
      min-height: 120px;
    }

    .logo {
      position: absolute;
      left: 0;
      max-width: 120px;
      height: auto;
    }

    .titulos {
      text-align: center;
    }

    .acciones-cabecera {
      position: absolute;
      right: 0;
      top: 0;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .lugar-evento {
      margin-top: 8px;
      font-size: 15px;
      color: #444;
      text-align: center;
    }

    .panel {
      background: #f7f9fb;
      border: 1px solid #dde4ea;
      border-radius: 8px;
      padding: 18px;
      margin-bottom: 24px;
    }

    .mensaje {
      margin-top: 16px;
      margin-bottom: 18px;
      padding: 12px;
      border-radius: 6px;
      display: none;
    }

    .mensaje.error {
      display: block;
      background: #fdeaea;
      color: #9b1c1c;
      border: 1px solid #f5c2c2;
    }

    .mensaje.ok {
      display: block;
      background: #eaf7ea;
      color: #146c2e;
      border: 1px solid #b9e0c0;
    }

    .mensaje.info {
      display: block;
      background: #eef4ff;
      color: #1d4f91;
      border: 1px solid #c9dcff;
    }

    .filtros {
      display: grid;
      grid-template-columns: 180px 220px 180px 1fr auto auto;
      gap: 12px;
      align-items: end;
    }

    label {
      display: block;
      font-weight: bold;
      margin-bottom: 6px;
    }

    input, select {
      width: 100%;
      padding: 10px;
      border: 1px solid #c9cfd6;
      border-radius: 6px;
      font-size: 15px;
      box-sizing: border-box;
    }

    button, .btn-enlace {
      background: #0b5ed7;
      color: white;
      border: none;
      padding: 11px 16px;
      border-radius: 6px;
      font-size: 15px;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
      white-space: nowrap;
    }

    button:hover, .btn-enlace:hover {
      background: #094db1;
    }

    button:disabled {
      background: #7aa7e8;
      cursor: not-allowed;
    }

    .btn-secundario {
      background: #6c757d;
    }

    .btn-secundario:hover {
      background: #565e64;
    }

    .btn-ver {
      background: #198754;
    }

    .btn-ver:hover {
      background: #13653f;
    }

    .btn-confirmar {
      background: #198754;
    }

    .btn-confirmar:hover {
      background: #13653f;
    }

    .btn-rechazar {
      background: #dc3545;
    }

    .btn-rechazar:hover {
      background: #b52a37;
    }

    .btn-cancelar {
      background: #6c757d;
    }

    .btn-cancelar:hover {
      background: #565e64;
    }

    .btn-reabrir {
      background: #fd7e14;
    }

    .btn-reabrir:hover {
      background: #d96404;
    }

    .resumen {
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 12px;
    }

    .tabla-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      min-width: 1280px;
    }

    th, td {
      padding: 12px 10px;
      border-bottom: 1px solid #dde4ea;
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }

    th {
      background: #eef4ff;
      color: #1d4f91;
    }

    .acciones {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .estado {
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: bold;
      display: inline-block;
      border: 1px solid transparent;
    }

    .estado.pendiente {
      background: #fff4db;
      color: #8a5a00;
      border-color: #f0d58a;
    }

    .estado.confirmada {
      background: #eaf7ea;
      color: #146c2e;
      border-color: #b9e0c0;
    }

    .estado.rechazada {
      background: #fdeaea;
      color: #9b1c1c;
      border-color: #f5c2c2;
    }

    .estado.cancelada {
      background: #eef1f4;
      color: #495057;
      border-color: #d5d9de;
    }

    .texto-secundario {
      color: #555;
      font-size: 13px;
      line-height: 1.5;
    }

    @media (max-width: 1100px) {
      .filtros {
        grid-template-columns: 1fr;
      }

      .logo,
      .acciones-cabecera {
        position: static;
        display: block;
        margin: 0 auto 10px auto;
      }

      .cabecera {
        display: block;
        min-height: auto;
      }

      .acciones-cabecera {
        text-align: center;
      }
    }
  </style>
</head>
<body>
  <div class="contenedor" id="app" style="display:none;">
    <div class="cabecera">
      <img src="logo.png" alt="Logo" class="logo">
      <div class="titulos">
        <h1 id="tituloEvento">Cargando evento...</h1>
        <h2 id="subtituloEvento">Panel de administración de reservas</h2>
        <div id="lugarEvento" class="lugar-evento" style="display:none;"></div>
      </div>
      <div class="acciones-cabecera">
        <a class="btn-enlace btn-secundario" href="admin-franjas.html">Ir a franjas</a>
        <button type="button" id="btnCerrarSesion">Cerrar sesión</button>
      </div>
    </div>

    <div id="mensaje" class="mensaje"></div>

    <div class="panel">
      <h3>Filtros</h3>

      <div class="filtros">
        <div>
          <label for="filtroFecha">Fecha</label>
          <input type="date" id="filtroFecha" />
        </div>

        <div>
          <label for="filtroFranja">Franja</label>
          <select id="filtroFranja">
            <option value="">Todas</option>
          </select>
        </div>

        <div>
          <label for="filtroEstado">Estado</label>
          <select id="filtroEstado">
            <option value="">Todos</option>
            <option value="PENDIENTE">PENDIENTE</option>
            <option value="CONFIRMADA">CONFIRMADA</option>
            <option value="RECHAZADA">RECHAZADA</option>
            <option value="CANCELADA">CANCELADA</option>
          </select>
        </div>

        <div>
          <label for="filtroTexto">Buscar</label>
          <input type="text" id="filtroTexto" placeholder="Código, centro, contacto, email o teléfono" />
        </div>

        <div>
          <button type="button" id="btnAplicarFiltros">Aplicar filtros</button>
        </div>

        <div>
          <button type="button" id="btnLimpiarFiltros" class="btn-secundario">Limpiar</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <div id="resumen" class="resumen">Cargando reservas...</div>

      <div class="tabla-wrap">
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Fecha / franja</th>
              <th>Centro / contacto</th>
              <th>Contacto</th>
              <th>Personas</th>
              <th>Visitantes</th>
              <th>Estado</th>
              <th>Observaciones</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody id="tablaReservas">
            <tr>
              <td colspan="9">Cargando datos...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let reservasCache = [];
    let franjasCache = [];
    let accionEnCurso = false;

    function redirigirLogin() {
      const next = encodeURIComponent(window.location.pathname);
      window.location.href = `admin-login.html?next=${next}`;
    }

    async function comprobarSesionAdmin() {
      const response = await fetch("/api/admin/session", {
        method: "GET",
        credentials: "same-origin"
      });

      if (!response.ok) {
        redirigirLogin();
        return false;
      }

      return true;
    }

    async function cerrarSesion() {
      try {
        await fetch("/api/admin/logout", {
          method: "POST",
          credentials: "same-origin"
        });
      } catch {
        // sin acción
      }

      redirigirLogin();
    }

    function mostrarMensaje(tipo, texto) {
      const mensaje = document.getElementById("mensaje");
      mensaje.className = "mensaje " + tipo;
      mensaje.style.display = "block";
      mensaje.textContent = texto;
    }

    function limpiarMensaje() {
      const mensaje = document.getElementById("mensaje");
      mensaje.className = "mensaje";
      mensaje.style.display = "none";
      mensaje.textContent = "";
    }

    async function cargarConfigEvento() {
      try {
        const response = await fetch("/api/config-evento", {
          credentials: "same-origin"
        });
        const data = await response.json();

        if (!response.ok || !data.ok) {
          throw new Error(data.error || "No se pudo cargar la configuración del evento.");
        }

        const config = data.config || {};

        document.title = "Administración de reservas";
        document.getElementById("tituloEvento").textContent = config.nombre_evento || "Evento no configurado";
        document.getElementById("subtituloEvento").textContent = "Panel de administración de reservas";

        const lugarEl = document.getElementById("lugarEvento");
        if (config.lugar && String(config.lugar).trim() !== "") {
          lugarEl.style.display = "block";
          lugarEl.innerHTML = `<strong>Lugar:</strong> ${config.lugar}`;
        } else {
          lugarEl.style.display = "none";
          lugarEl.textContent = "";
        }
      } catch (error) {
        console.error(error);
        document.getElementById("tituloEvento").textContent = "Evento no disponible";
        document.getElementById("subtituloEvento").textContent = "Panel de administración de reservas";
      }
    }

    async function cargarFranjasParaFiltro() {
      const select = document.getElementById("filtroFranja");

      try {
        const response = await fetch("/api/admin/franjas", {
          credentials: "same-origin"
        });

        if (response.status === 401) {
          redirigirLogin();
          return;
        }

        const data = await response.json();

        if (!response.ok || !data.ok) {
          throw new Error(data.error || "No se pudieron cargar las franjas.");
        }

        franjasCache = Array.isArray(data.franjas) ? data.franjas : [];

        select.innerHTML = `<option value="">Todas</option>`;

        franjasCache.forEach(f => {
          const option = document.createElement("option");
          option.value = f.id;
          option.textContent = `${f.fecha} - ${f.hora_inicio} a ${f.hora_fin}`;
          select.appendChild(option);
        });

      } catch (error) {
        console.error(error);
        select.innerHTML = `<option value="">Error al cargar franjas</option>`;
      }
    }

    function construirQuery() {
      const params = new URLSearchParams();

      const fecha = document.getElementById("filtroFecha").value;
      const franjaId = document.getElementById("filtroFranja").value;
      const estado = document.getElementById("filtroEstado").value;
      const q = document.getElementById("filtroTexto").value.trim();

      if (fecha) params.set("fecha", fecha);
      if (franjaId) params.set("franja_id", franjaId);
      if (estado) params.set("estado", estado);
      if (q) params.set("q", q);

      return params.toString();
    }

    async function cargarReservas() {
      const tbody = document.getElementById("tablaReservas");
      tbody.innerHTML = `<tr><td colspan="9">Cargando datos...</td></tr>`;

      const query = construirQuery();
      const url = query ? `/api/admin/reservas?${query}` : "/api/admin/reservas";

      const response = await fetch(url, {
        credentials: "same-origin"
      });

      if (response.status === 401) {
        redirigirLogin();
        return;
      }

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || "No se pudieron cargar las reservas.");
      }

      reservasCache = Array.isArray(data.reservas) ? data.reservas : [];
      renderizarTabla();
    }

    function actualizarResumen() {
      const resumen = document.getElementById("resumen");

      if (!reservasCache.length) {
        resumen.textContent = "No hay reservas con los filtros actuales.";
        return;
      }

      const total = reservasCache.length;
      const pendientes = reservasCache.filter(r => r.estado === "PENDIENTE").length;
      const confirmadas = reservasCache.filter(r => r.estado === "CONFIRMADA").length;
      const rechazadas = reservasCache.filter(r => r.estado === "RECHAZADA").length;
      const canceladas = reservasCache.filter(r => r.estado === "CANCELADA").length;
      const personas = reservasCache.reduce((acc, r) => acc + Number(r.personas || 0), 0);

      resumen.innerHTML = `
        <strong>Total solicitudes:</strong> ${total} &nbsp; | &nbsp;
        <strong>Pendientes:</strong> ${pendientes} &nbsp; | &nbsp;
        <strong>Confirmadas:</strong> ${confirmadas} &nbsp; | &nbsp;
        <strong>Rechazadas:</strong> ${rechazadas} &nbsp; | &nbsp;
        <strong>Canceladas:</strong> ${canceladas} &nbsp; | &nbsp;
        <strong>Personas:</strong> ${personas}
      `;
    }

    function badgeEstado(estado) {
      const e = String(estado || "").toLowerCase();
      return `<span class="estado ${e}">${estado}</span>`;
    }

    function accionesPorEstado(reserva) {
      const editarUrl = `editar.html?token=${encodeURIComponent(reserva.token_edicion)}`;
      const asistentesUrl = `asistentes.html?token=${encodeURIComponent(reserva.token_edicion)}`;

      let accionesExtra = "";

      if (reserva.estado === "PENDIENTE") {
        accionesExtra = `
          <button type="button" class="btn-confirmar" data-id="${reserva.id}" data-accion="confirmar">Confirmar</button>
          <button type="button" class="btn-rechazar" data-id="${reserva.id}" data-accion="rechazar">Rechazar</button>
          <button type="button" class="btn-cancelar" data-id="${reserva.id}" data-accion="cancelar">Cancelar</button>
        `;
      } else if (reserva.estado === "CONFIRMADA") {
        accionesExtra = `
          <button type="button" class="btn-cancelar" data-id="${reserva.id}" data-accion="cancelar">Cancelar</button>
          <button type="button" class="btn-reabrir" data-id="${reserva.id}" data-accion="reabrir">Reabrir</button>
        `;
      } else if (reserva.estado === "RECHAZADA") {
        accionesExtra = `
          <button type="button" class="btn-reabrir" data-id="${reserva.id}" data-accion="reabrir">Reabrir</button>
          <button type="button" class="btn-cancelar" data-id="${reserva.id}" data-accion="cancelar">Cancelar</button>
        `;
      } else if (reserva.estado === "CANCELADA") {
        accionesExtra = `
          <button type="button" class="btn-reabrir" data-id="${reserva.id}" data-accion="reabrir">Reabrir</button>
        `;
      }

      return `
        <div class="acciones">
          <a class="btn-enlace btn-ver" href="${editarUrl}" target="_blank">Editar</a>
          <a class="btn-enlace btn-ver" href="${asistentesUrl}" target="_blank">Asistentes</a>
          ${accionesExtra}
        </div>
      `;
    }

    function renderizarTabla() {
      const tbody = document.getElementById("tablaReservas");
      tbody.innerHTML = "";

      if (!reservasCache.length) {
        tbody.innerHTML = `<tr><td colspan="9">No hay reservas con los filtros actuales.</td></tr>`;
        actualizarResumen();
        return;
      }

      reservasCache.forEach(reserva => {
        const tr = document.createElement("tr");

        tr.innerHTML = `
          <td>
            <strong>${reserva.codigo_reserva || reserva.id}</strong><br>
            <span class="texto-secundario">ID interno: ${reserva.id}</span>
          </td>
          <td>
            <strong>${reserva.fecha}</strong><br>
            ${reserva.hora_inicio} - ${reserva.hora_fin}
          </td>
          <td>
            <strong>${reserva.centro || ""}</strong><br>
            <span class="texto-secundario">${reserva.contacto || ""}</span>
          </td>
          <td>
            <div>${reserva.telefono || ""}</div>
            <div class="texto-secundario">${reserva.email || ""}</div>
          </td>
          <td>
            <strong>${reserva.personas || 0}</strong><br>
            <span class="texto-secundario">
              Mayores 10: ${reserva.mayores10 || 0}<br>
              Menores 10: ${reserva.menores10 || 0}
            </span>
          </td>
          <td>${reserva.numero_visitantes || 0}</td>
          <td>${badgeEstado(reserva.estado)}</td>
          <td>${reserva.observaciones ? reserva.observaciones : '<span class="texto-secundario">Sin observaciones</span>'}</td>
          <td>${accionesPorEstado(reserva)}</td>
        `;

        tbody.appendChild(tr);
      });

      tbody.querySelectorAll("button[data-id]").forEach(btn => {
        btn.addEventListener("click", async function () {
          const id = this.getAttribute("data-id");
          const accion = this.getAttribute("data-accion");

          let textoConfirmacion = "¿Desea ejecutar esta acción?";

          if (accion === "confirmar") {
            textoConfirmacion = "¿Desea confirmar esta solicitud?";
          } else if (accion === "rechazar") {
            textoConfirmacion = "¿Desea rechazar esta solicitud?";
          } else if (accion === "cancelar") {
            textoConfirmacion = "¿Desea cancelar esta solicitud o reserva?";
          } else if (accion === "reabrir") {
            textoConfirmacion = "¿Desea reabrir esta solicitud y dejarla pendiente?";
          }

          const confirmar = window.confirm(textoConfirmacion);
          if (!confirmar) return;

          await ejecutarAccionReserva(id, accion);
        });
      });

      actualizarResumen();
    }

    async function ejecutarAccionReserva(id, accion) {
      if (accionEnCurso) return;

      limpiarMensaje();

      try {
        accionEnCurso = true;

        const response = await fetch("/api/admin/reservas", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json"
          },
          credentials: "same-origin",
          body: JSON.stringify({
            id,
            accion
          })
        });

        if (response.status === 401) {
          redirigirLogin();
          return;
        }

        const data = await response.json();

        if (!response.ok || !data.ok) {
          mostrarMensaje("error", data.error || "No se pudo ejecutar la acción.");
          return;
        }

        mostrarMensaje("ok", data.mensaje || "Acción realizada correctamente.");
        await cargarReservas();

      } catch (error) {
        mostrarMensaje("error", error.message || "Error de conexión con el servidor.");
      } finally {
        accionEnCurso = false;
      }
    }

    function limpiarFiltros() {
      document.getElementById("filtroFecha").value = "";
      document.getElementById("filtroFranja").value = "";
      document.getElementById("filtroEstado").value = "";
      document.getElementById("filtroTexto").value = "";
    }

    document.addEventListener("DOMContentLoaded", async function () {
      const ok = await comprobarSesionAdmin();
      if (!ok) return;

      document.getElementById("app").style.display = "block";
      document.getElementById("btnCerrarSesion").addEventListener("click", cerrarSesion);

      document.getElementById("btnAplicarFiltros").addEventListener("click", async function () {
        limpiarMensaje();
        try {
          await cargarReservas();
        } catch (error) {
          mostrarMensaje("error", error.message || "No se pudieron cargar las reservas.");
        }
      });

      document.getElementById("btnLimpiarFiltros").addEventListener("click", async function () {
        limpiarMensaje();
        limpiarFiltros();
        try {
          await cargarReservas();
        } catch (error) {
          mostrarMensaje("error", error.message || "No se pudieron cargar las reservas.");
        }
      });

      try {
        await cargarConfigEvento();
        await cargarFranjasParaFiltro();
        await cargarReservas();
      } catch (error) {
        mostrarMensaje("error", error.message || "No se pudo inicializar el panel de reservas.");
      }
    });
  </script>
</body>
</html>
