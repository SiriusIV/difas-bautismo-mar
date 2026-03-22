<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mis actividades</title>

<style>
body { font-family: Arial; background:#f4f6f8; margin:0; }
.contenedor { max-width:1100px; margin:30px auto; background:#fff; padding:20px; border-radius:10px; }

.cabecera { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
h1 { margin:0; }

.btn {
  background:#0b5ed7; color:#fff; border:none;
  padding:8px 12px; border-radius:6px; cursor:pointer;
}
.btn-sec { background:#6c757d; }
.btn:hover { opacity:0.9; }

table { width:100%; border-collapse:collapse; }
th, td { padding:10px; border-bottom:1px solid #ddd; text-align:left; }
th { background:#eef4ff; }

.badge { padding:3px 6px; border-radius:4px; color:#fff; font-size:12px; }
.ok { background:#198754; }
.no { background:#dc3545; }

.acciones button { margin-right:5px; }
</style>
</head>

<body>
<div class="contenedor">

  <div class="cabecera">
    <h1>Mis actividades</h1>
    <div>
      <button class="btn" onclick="nueva()">+ Nueva</button>
      <button class="btn btn-sec" onclick="portal()">Portal</button>
      <button class="btn btn-sec" onclick="logout()">Salir</button>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Nombre</th>
        <th>Tipo</th>
        <th>Fechas</th>
        <th>Activa</th>
        <th>Visible</th>
        <th>Acciones</th>
      </tr>
    </thead>
    <tbody id="tabla"></tbody>
  </table>

</div>

<script>
async function cargar() {
  const res = await fetch("/api/admin/mis-actividades", { credentials:"same-origin" });
  const data = await res.json();

  if (!data.ok) {
    alert(data.error || "Error");
    return;
  }

  const tbody = document.getElementById("tabla");
  tbody.innerHTML = data.actividades.map(a => `
    <tr>
      <td>${a.nombre}</td>
      <td>${a.tipo}</td>
      <td>${a.tipo==="TEMPORAL" ? (a.fecha_inicio+" → "+a.fecha_fin) : "-"}</td>
      <td><span class="badge ${a.activa? "ok":"no"}">${a.activa?"Sí":"No"}</span></td>
      <td><span class="badge ${a.visible_portal? "ok":"no"}">${a.visible_portal?"Sí":"No"}</span></td>
      <td class="acciones">
        <button onclick="editar(${a.id})">Editar</button>
        <button onclick="franjas(${a.id})">Franjas</button>
        <button onclick="reservas(${a.id})">Reservas</button>
      </td>
    </tr>
  `).join("");
}

function editar(id) {
  location.href = "admin-actividades.html?id=" + id;
}

function franjas(id) {
  location.href = "admin-franjas.html?actividad_id=" + id;
}

function reservas(id) {
  location.href = "admin-reservas.html?actividad_id=" + id;
}

function nueva() {
  location.href = "admin-actividades.html";
}

function portal() {
  location.href = "portal.html";
}

async function logout() {
  await fetch("/api/usuario/logout", { method:"POST", credentials:"same-origin" });
  location.href = "portal.html";
}

cargar();
</script>

</body>
</html>
