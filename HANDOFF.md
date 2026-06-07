# Handoff técnico — DIFAS Bautismo Mar

Fecha de continuidad: 2026-06-07  
Repositorio local: `C:\Users\edube\difas-bautismo-mar`  
Deploy: Cloudflare Pages + Pages Functions  
Base de datos: Cloudflare D1 / SQLite  

## Cómo usar este archivo

Este archivo es un mapa de continuidad para abrir un chat nuevo sin perder contexto. No sustituye al código real.

La fuente de verdad siempre son los archivos del repositorio local. Antes de cambiar nada:

- Lee `AGENTS.md`.
- Inspecciona el repositorio real con `rg`.
- Contrasta este handoff con los archivos existentes.
- Haz cambios quirúrgicos.
- Valida JS/API con `node --check`.
- Al final da comandos PowerShell con `git add`, `git commit` y `git push`.

Prompt recomendado para el chat nuevo:

```text
Estoy trabajando en el proyecto local C:\Users\edube\difas-bautismo-mar.
Lee primero HANDOFF.md como mapa de continuidad, pero considera que la fuente de verdad son los archivos reales del repositorio.
Antes de hacer cambios, inspecciona el código existente con rg, reconstruye el estado actual y continúa desde ahí.
Mantén cambios quirúrgicos, valida con node --check y al final dame comandos PowerShell con git add, git commit y git push.
```

## Arquitectura general

Aplicación web para gestión de actividades públicas institucionales, solicitudes/reservas, asistentes, documentación obligatoria y paneles por perfil.

Roles:

- Usuario público / solicitante.
- Administrador / organizador.
- Secretaría documental.
- Superadmin.

Frontend principal:

- `portal.html`
- `usuario-registro.html`
- `usuario-perfil.html`
- `usuario-panel.html`
- `admin-actividades.html`
- `admin-reservas.html`
- `admin-calendario.html`
- `admin-plantillas.html`
- `asistentes.html`

APIs y módulos clave:

- `functions/api/admin/actividades-guardar.js`
- `functions/api/admin/franjas.js`
- `functions/api/admin/reservas.js`
- `functions/api/admin/mis-actividades.js`
- `functions/api/secretaria/actividades.js`
- `functions/api/usuario/reservas.js`
- `functions/api/reserva-cancelar.js`
- `functions/api/reserva-confirmar-cambio-franja.js`
- `functions/api/franjas.js`
- `functions/api/actividades.js`
- `functions/api/_actividad_documentacion.js`
- `functions/api/_documentacion_responsable.js`
- `functions/api/_impacto_documental_reservas.js`
- `functions/api/_reservas_historial.js`
- `functions/api/_reservas_mantenimiento.js`
- `functions/api/_avisos_actividad_documentacion.js`
- `functions/api/_email.js`
- `functions/api/_notificaciones.js`

## Reglas UX consolidadas

- En móvil, tablas con scroll horizontal deben convertirse en fichas.
- Las fichas deben ser compactas, sin desbordes y con truncado visual en cadenas largas.
- Los elementos clicables poco evidentes llevan icono de mano/ratón: `assets/icono-estado-clicable.svg`.
- Los modales usan X discreta arriba derecha, salvo confirmaciones críticas donde se indique lo contrario.
- Las fichas seleccionadas se resaltan en azul suave.
- Los botones principales pueden ser pastillas largas con icono y texto.
- Mantener colorimetría consistente de estados.

## Estados documentales

El sistema dejó de usar el “estado del expediente documental” como regla decisoria. Lo importante es el estado individual de cada documento.

Estados UI:

- `No presentado`
- `En revisión`
- `Aprobado`
- `Rechazado`
- `Desactualizado`

`No requerido` no es un estado documental; solo indica que ese documento no aplica a una actividad concreta.

## Responsable documental

Última regla importante:

La documentación preceptiva/obligatoria de una actividad solo puede modificarla el responsable documental efectivo.

- Si el administrador está en autogestión, solo ese administrador modifica la documentación exigible de sus actividades.
- Si el administrador delegó en secretaría, solo esa secretaría modifica la documentación exigible.
- El otro perfil puede consultar, pero no modificar.

Archivos implicados:

- `functions/api/admin/actividades-guardar.js`
- `functions/api/admin/mis-actividades.js`
- `functions/api/secretaria/actividades.js`
- `admin-actividades.html`

Implementación reciente:

- Backend comprueba el responsable documental real.
- Si el usuario no es responsable documental, ignora cambios recibidos en `documentacion_actividad`.
- UI muestra el bloque en modo consulta y deshabilita añadir/eliminar documentos.

Pendiente recomendado:

- Revisar visualmente que el modo consulta documental queda claro en móvil y escritorio.
- Decidir si conviene mostrar aviso explícito cuando un usuario sin permiso intenta cambiar documentación.

## Documentación obligatoria por actividad

Cada actividad exige un subconjunto de documentos del repositorio del responsable documental efectivo.

Una actividad puede estar disponible para un usuario aunque no tenga todo el repositorio aprobado, siempre que tenga aprobados todos los documentos concretos exigidos por esa actividad.

Correos de revisión documental:

- Muestran tabla de documentos revisados.
- Muestran actividades disponibles para solicitar según documentación actualmente aprobada.
- Filtran actividades activas, visibles, con reserva y cuya documentación exigida esté aprobada.
- No deben listar actividades sin reserva.

## Solicitudes / reservas

Estados principales:

- `BORRADOR`
- `PENDIENTE`
- `CONFIRMADA`
- `SUSPENDIDA`
- `RECHAZADA`
- `CANCELADA`

### Rechazo manual

Una solicitud rechazada no se elimina inmediatamente. El usuario puede subsanar y reenviar.

Regla de eliminación automática:

- Se elimina cuando ocurra antes:
  - mitad del tiempo entre rechazo y comienzo de franja;
  - o 24 horas antes del comienzo.

El correo de rechazo debe incluir observaciones y fecha/hora exacta de eliminación automática.

### Suspensión documental

Si cambia documentación exigida o marco documental y la solicitud deja de cumplir:

- Si estaba `PENDIENTE`, vuelve a `PENDIENTE` al regularizar.
- Si estaba `CONFIRMADA`, vuelve a `CONFIRMADA` al regularizar.
- No debe confundirse con suspensión por franja.

### Suspensión por cambio de franja

Cuando una franja activa se edita y afecta a solicitudes:

- Las solicitudes afectadas pasan a `SUSPENDIDA`.
- Se registra historial con acción `CAMBIO_FRANJA`.
- El modal público distingue este motivo.
- Muestra franja anterior y franja actual.
- Botones:
  - `Confirmar solicitud`
  - `Anular solicitud`

Endpoint nuevo:

- `functions/api/reserva-confirmar-cambio-franja.js`

Archivos implicados:

- `functions/api/usuario/reservas.js`
- `usuario-panel.html`

## Franjas horarias

Funcionalidad reciente:

- Tabla de franjas en `admin-actividades.html` tiene columna inicial con switch por franja.
- Columna `Estado`: `Activa`, `Inactiva`, `Finalizada`.
- La pastilla de estado ya no va pegada a fecha/periodicidad.

Backend:

- `functions/api/admin/franjas.js`
- Columna defensiva `franjas.activa`.
- Tabla `franja_desactivacion_avisos`.

Reglas:

- Desactivar franja sin solicitudes futuras afectadas: directo, sin modal.
- Desactivar franja con solicitudes futuras: modal de confirmación; si continúa, elimina solicitudes futuras y avisa.
- Reactivar franja: avisa a solicitantes afectados por desactivación anterior.
- Editar franja activa con solicitudes: avisa y suspende según regla.
- Editar franja inactiva: guarda cambios sin correos, sin notificaciones y sin suspender.

APIs públicas:

- `functions/api/franjas.js` excluye franjas inactivas.
- `functions/api/actividades.js` excluye franjas inactivas de disponibilidad.

## Actividad o franja eliminada/desactivada

Actividad futura eliminada/desactivada:

- Elimina solicitudes futuras asociadas en cualquier estado.
- Conserva histórico si la actividad ya se realizó.
- El correo debe decir que la solicitud fue eliminada por cancelación/desactivación de la actividad, no rechazada.

Franja eliminada:

- Modal de advertencia al organizador.
- Si continúa, elimina solicitudes futuras afectadas.
- Correo explica que la actividad sigue activa y puede solicitar otras franjas disponibles.

## Panel de asistentes

Cambios relevantes:

- Foco inicial en primera caja `Nombre completo`.
- Móvil: tabla convertida en fichas.
- Fichas compactas, truncado visual y resaltado de ficha activa.
- Bloques inferiores igualan altura sin crecer al interactuar.
- Fecha límite de asignación destacada.
- Reloj sin segundos, actualiza cada minuto.
- Últimos cinco minutos en rojo.
- Al finalizar tiempo, muestra `FINALIZADA` y nota amarilla.
- Modales al eliminar último asistente según plazo agotado/no agotado.

## Panel de usuarios públicos

Cambios relevantes:

- Tabla escritorio aligerada: centro, email, teléfono, solicitudes.
- `Centro` abre ficha completa de usuario.
- Modal de ficha incluye datos de usuario excepto contraseña y botón de documentación.
- Móvil: fichas, truncados, filtros reorganizados y botón de documentación alargado.
- Modal de documentación remitida con acciones superiores: visualizar, aprobar, rechazar, eliminar.
- Si no eres gestor documental efectivo, solo visualizas.

## Registro usuario público

Cambios relevantes:

- Registro reservado a entidades/colectivos públicos o privados, no particulares.
- Campo obligatorio `NIF/CIF`.
- Validación sintáctica NIF/CIF y DNI.
- Errores genéricos sin pistas.
- Botón `Volver al portal` alargado.
- Botón inferior `Enviar solicitud de registro` con avión de papel.
- Fondo visual unificado.

## Portal

Cambios relevantes:

- Filtros por localidad, programa y rango de fechas.
- Fechas compactadas en móvil y pre-login escritorio.
- Si no hay actividades, no mostrar `Más información` ni `No necesita reserva`.
- Actividades sin reserva muestran cartel informativo.
- Botones de panel de actividades/reservas con iconos SVG.
- Botón de perfil actualizado.

## Calendarios

Cambios relevantes:

- Hover con globo informativo.
- Cursor mano en eventos clicables.
- Usuario público ve globos de actividades y solicitudes.
- Admin ve globos y abre acciones.
- Leyenda actividades: disponible, últimas plazas, completa, finalizada.
- Leyenda solicitudes: pendiente, confirmada, suspendida, rechazada.
- Vista lista muestra nombre junto al punto.
- Si no hay aforo limitado, el globo muestra `Aforo no limitado`.

## Admin reservas

Cambios relevantes:

- Cabecera móvil reorganizada.
- Filtros móviles con limpiar filtro arriba derecha.
- Fichas con icono clicable junto a pastilla estado.
- Modal estado admin con botones aceptar/rechazar transparentes y alineados.

## Plantillas documentales

Cambios relevantes:

- Título centrado.
- Tabla de campos detectados con cabeceras y celdas centradas.

## Lockdown Cloudflare

Variables:

- `LOCKDOWN_ENABLED=true`
- `LOCKDOWN_ALLOW=<IP pública>`

Limitación:

- Bloquea por IP pública del router, no por dispositivo dentro de la misma red.

## UTF / mojibake

Hubo varias limpiezas, pero pueden quedar restos (`estÃ¡`, `documentaciÃ³n`, etc.), sobre todo en `usuario-panel.html` y correos.

Pendiente recomendado:

- Pasada quirúrgica UTF futura, validando sintaxis después.

## Validación habitual

Para APIs:

```powershell
node --check functions/api/admin/actividades-guardar.js
node --check functions/api/admin/franjas.js
node --check functions/api/usuario/reservas.js
```

Para HTML con script:

```powershell
$content = Get-Content 'admin-actividades.html' -Raw
$match = [regex]::Match($content,'<script>([\s\S]*?)</script>')
if($match.Success){
  Set-Content -Path '__tmp_check.js' -Value $match.Groups[1].Value
  node --check __tmp_check.js
  Remove-Item '__tmp_check.js' -Force
}
```

## Último comando sugerido antes de crear este handoff

No está confirmado si ya fue ejecutado:

```powershell
cd C:\Users\edube\difas-bautismo-mar
git add admin-actividades.html functions/api/admin/actividades-guardar.js functions/api/admin/mis-actividades.js functions/api/secretaria/actividades.js
git commit -m "fix(documentacion): limitar edicion al responsable documental"
git push
```
