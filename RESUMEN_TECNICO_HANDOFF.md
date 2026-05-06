# Resumen Tecnico de Handoff

## Proyecto

- Ruta base: `C:\Users\edube\difas-bautismo-mar`
- Aplicacion web con HTMLs con `<script>` embebido y backend en `functions/api/...`
- Frontend sin framework. Mucha logica de pantalla vive dentro de cada HTML.
- Backend sobre Cloudflare Pages Functions / Workers con SQLite/D1.

## Objetivo de este documento

Este resumen sirve para abrir un chat nuevo y retomar el desarrollo exactamente desde el punto actual, sin perder:

- decisiones de negocio
- depuracion UX ya cerrada
- arquitectura funcional por rol
- archivos sensibles
- problemas ya resueltos
- pendientes inmediatos

## Regla de trabajo que ha funcionado mejor

Conviene seguir esta dinamica:

1. interpretar el cambio pedido
2. explicarlo brevemente
3. esperar `conforme` cuando el cambio UX tenga implicaciones de maquetacion o flujo
4. despues editar y verificar

Tambien ha sido util:

- respuestas cortas
- tocar solo los tramos necesarios
- verificar los `<script>` embebidos con `node --check`
- no volver a copias viejas salvo peticion expresa

## Arquitectura funcional por rol

### Solicitante / usuario publico

Pantallas principales:

- `portal.html`
- `usuario-panel.html`
- `usuario-perfil.html`
- `solicitud-reserva.html`
- `editar.html`
- `asistentes.html`
- `admin-calendario.html` ahora tambien accesible para solicitantes

Capacidades principales:

- ver actividades publicas
- solicitar actividad
- gestionar su perfil documental
- editar sus solicitudes
- gestionar asistentes
- anular solicitudes
- ver calendario:
  - pestaña `Actividades`: todas las actividades programadas visibles
  - pestaña `Solicitudes`: solo sus propias solicitudes

Restricciones importantes:

- en calendario no puede abrir actividades ajenas como ficha editable
- en calendario solo ve sus propias solicitudes
- en actividades del calendario no ve historico pasado; solo administradores lo ven

### Administrador / superadministrador

Pantallas principales:

- `portal.html`
- `mis-actividades.html`
- `admin-actividades.html`
- `admin-reservas.html`
- `admin-calendario.html`
- `admin-documentos.html`
- `admin-validaciones-documentales.html`

Capacidades principales:

- crear y editar actividades
- gestionar reservas
- validar o rechazar solicitudes
- revisar documentacion
- ver calendario:
  - pestaña `Solicitudes`: reservas
  - pestaña `Actividades`: actividades programadas

## Pantallas y estado actual

### 1. `portal.html`

Estado actual:

- portal publico/mixto segun rol
- cabecera, logo y UTF corregidos
- campana de notificaciones ya estable
- carrusel y ficha resumen recuperados tras el ajuste del estado `COMPLETA`

Reglas importantes ya implementadas:

- las alertas documentales y de reservas se calculan como alertas operativas, no solo por la tabla antigua `notificaciones`
- para solicitante:
  - alerta cuando cambia el estado de su solicitud
- para admin:
  - alerta de nueva solicitud pendiente
  - alerta de cancelacion hecha por el solicitante

Regla visual importante:

- cuando una actividad con franjas agota sus plazas por reservas vivas o prereservas vigentes, el portal la marca como `COMPLETA`
- si despues expira la prereserva y vuelven plazas, debe dejar de aparecer como completa

Archivos clave relacionados:

- `portal.html`
- `functions/api/actividades.js`
- `functions/api/usuario/reservas.js`
- `functions/api/_notificaciones.js`

### 2. `solicitud-reserva.html`

Situacion:

- esta pantalla antes era `index.html`
- se separo el flujo de solicitud a un archivo propio
- `index.html` queda como compatibilidad/redireccion

Estado UX actual:

- cabecera alineada con el resto del site
- primer bloque con nombre de actividad, organiza, lugar y acciones
- bloque visual central:
  - imagen de actividad a la izquierda
  - franja, plazas disponibles, plazas reservadas y observaciones a la derecha
- bloque inferior:
  - resumen de reserva
  - bloque informativo amarillo

Reglas funcionales actuales:

- hereda automaticamente solo:
  - centro solicitante interno
  - franja si viene por URL
- persona de contacto, telefono y correo son editables y pueden ser distintos del usuario logueado
- hay aviso si se intenta salir sin enviar la solicitud
- telefono y email tienen validacion de formato
- los campos obligatorios estan marcados con asterisco rojo
- el bloque informativo esta reservado para requisitos particulares y mensajes de negocio

### 3. `usuario-panel.html`

Estado UX actual:

- modernizado visualmente
- mismo aire general que paneles modernos
- columna `Codigo` eliminada
- boton circular de anular solicitud
- modal de estado compacto y guiado
- botones superiores:
  - portal
  - calendario (ya metido en el archivo local)

Reglas funcionales actuales:

- usuario puede anular cualquiera de sus solicitudes
- el estado es boton y abre modal
- `SUSPENDIDA` se interpreta como suspension documental

Nota importante:

- el boton de calendario ya esta incluido en el archivo local `usuario-panel.html`
- si no se ve en produccion, revisar despliegue/commit

### 4. `usuario-perfil.html`

Estado actual:

- se simplifico la tabla documental del solicitante
- desaparece la columna de seleccion
- la fila se considera activa al pulsar sobre sus acciones
- si hay cambios y se intenta salir sin guardar, avisa
- hay `beforeunload` para no perder cambios

### 5. `admin-actividades.html`

Pantalla muy trabajada. Estado ya bastante maduro.

Flujo actual:

1. Configuracion
2. Programacion
3. Localizacion
4. Requisitos particulares

Reglas ya consolidadas:

- `Con franjas horarias` gobierna si existe o no la pantalla de Programacion
- las fechas generales viven en Configuracion
- `visible_portal` y `activa` quedaron unificados funcionalmente
- `usa_franjas` no borra franjas al apagarse
- solo bloquea apagado de franjas si hay reservas vivas que realmente lo impiden

Nueva pantalla ya añadida:

- `Requisitos particulares`
- tabla editable por filas
- una fila por requisito
- scroll vertical si hay muchos
- los requisitos se guardan en tabla relacionada

Archivos implicados:

- `admin-actividades.html`
- `functions/api/admin/actividades-guardar.js`
- `functions/api/admin/mis-actividades.js`
- `functions/api/admin/actividades-eliminar.js`
- `functions/api/actividades.js`

### 6. `admin-calendario.html`

Es una de las pantallas mas afinadas y a la vez mas sensibles.

Estado UX actual:

- cabecera alineada con el resto del site
- primer bloque con:
  - titulo
  - rango temporal centrado
  - flechas de desplazamiento en el primer bloque
  - acciones `Reservas`, `Actividades`, `Portal`
- segundo bloque con:
  - pestañas `Solicitudes / Actividades`
  - toolbar `Hoy / Mes / Semana / Dia / Lista`
  - leyenda inferior
  - calendario con altura variable segun vista

Vista `Solicitudes`:

- filtro de estado
- contadores
- muestra reservas

Vista `Actividades`:

- muestra actividades programadas
- colores por estado:
  - `DISPONIBLE`
  - `ULTIMAS PLAZAS`
  - `COMPLETA`
  - `FINALIZADA`

Permisos actuales:

- admin/superadmin: acceso completo
- solicitante: acceso permitido
  - actividades: todas, solo lectura
  - solicitudes: solo las suyas

Reglas de centrado ya conseguidas:

- en `Mes`, `Semana`, `Dia` y `Lista` se ancla al proximo evento futuro de la vista activa
- `Hoy` es la unica que usa la fecha del sistema

Vista `Lista`:

- ya no es `listWeek`
- se convirtio en `Lista continua`
- carga un rango amplio
- muestra dias vacios
- scroll vertical continuo
- oculta rango y flechas del primer bloque cuando esta activa
- sangria visual aumentada para que los eventos queden claramente indentados respecto al dia

Punto delicado:

- `admin-calendario.html` se rompio varias veces por mover DOM interno del calendario o por depender de datos no siempre presentes
- la version actual ya esta estable, pero conviene tocarla con bisturi

### 7. `admin-reservas.html`

Estado actual:

- sigue siendo referencia visual para varios iconos y botones del sistema
- su iconografia de calendario y de portal se ha reutilizado como patron

## Backend y reglas de negocio relevantes

### `functions/api/admin/calendario.js`

Estado actual:

- ya no depende de `getAdminSession`
- usa sesion generica y permite:
  - `ADMIN`
  - `SUPERADMIN`
  - `SOLICITANTE`
- vista `actividades`:
  - admin/superadmin ven todo
  - solicitante ve todas las actividades programadas
  - `editable_actividad` solo es verdadero si pertenece al admin o es superadmin
- vista `reservas`:
  - solicitante se filtra por `r.usuario_id = session.usuario_id`
  - admin ve lo suyo segun logica existente

Regla importante:

- para solicitante, en `actividades` no se devuelven actividades historicas pasadas
- para solicitante, en `solicitudes` si se mantiene el historico util de reservas

### `functions/api/actividades.js`

Cambios clave ya hechos:

- calculo robusto de `completa_calculada`
- para actividades con franjas, `COMPLETA` depende de agotamiento real de plazas
- no de la vieja condicion de `aforo_limitado`

### `functions/api/usuario/reservas.js`

Estado actual:

- devuelve datos suficientes para alertas operativas:
  - `fecha_solicitud`
  - `fecha_modificacion`
- filtra reservas sin programacion valida para ocultar residuos legacy

### `functions/api/reserva-cancelar.js`

Estado actual:

- cancelar ya no borra fisicamente la reserva
- la deja como `CANCELADA`
- libera visitantes
- actualiza `fecha_modificacion`
- notifica al admin

### `functions/api/_reservas_mantenimiento.js`

Uso:

- limpieza de residuos antiguos de reservas
- elimina o sanea reservas legacy sin actividad/franja/programacion valida

### `functions/api/_notificaciones.js`

Situacion:

- se reforzo compatibilidad con esquemas heredados
- pero para reservas en portal se termino complementando con alertas operativas calculadas desde datos reales

## Requisitos particulares

Modelo ya introducido:

- tabla hija relacionada por actividad
- un requisito por fila
- orden secuencial

Edicion:

- ultima pantalla en `admin-actividades.html`

Visualizacion:

- aparecen en el bloque informativo de `solicitud-reserva.html`
- de momento no en la ficha resumen publica de actividad

## Notificaciones y correos

Reglas actuales importantes:

- correos relacionados con solicitudes de actividad al solicitante:
  - deben ir al correo de contacto de la solicitud
  - no al email de la cuenta del usuario

- alertas internas en portal:
  - admin:
    - nueva solicitud pendiente
    - cancelacion por parte del solicitante
  - solicitante:
    - cambio de estado de su solicitud

Cancelaciones:

- al cancelar una solicitud desde el panel del solicitante:
  - se conserva traza en `CANCELADA`
  - el admin debe recibir alerta/correo

## Reglas de calendario ya decididas

### Historico

- administradores:
  - pueden ver actividades historicas
  - en reservas, historico del calendario solo conserva confirmadas una vez pasada la fecha

- solicitantes:
  - en `Solicitudes`: pueden ver su historico util
  - en `Actividades`: no ven actividades historicas

### Vista Lista

Reglas ya fijadas:

- no limitada a la semana visible
- secuencia continua
- dias vacios visibles
- scroll vertical
- al entrar debe anclarse al proximo evento futuro

## Migracion de `index.html`

Hecho:

- la antigua pagina de solicitud se movio a `solicitud-reserva.html`
- `index.html` queda como shim / compatibilidad
- la raiz debe asociarse a `portal.html`

## Archivos mas sensibles ahora mismo

- `portal.html`
- `admin-calendario.html`
- `admin-actividades.html`
- `usuario-panel.html`
- `solicitud-reserva.html`
- `functions/api/admin/calendario.js`
- `functions/api/actividades.js`
- `functions/api/usuario/reservas.js`
- `functions/api/reserva-cancelar.js`
- `functions/api/_reservas_mantenimiento.js`

## Problemas que ya aparecieron y conviene recordar

### 1. Codificacion UTF rota

Sintomas:

- acentos corruptos
- simbolos raros en textos o modales

Leccion:

- si aparece texto corrupto, revisar encoding antes de tocar logica

### 2. Cambios UX que no aparecian en web

Sintoma:

- el cambio estaba en local pero no desplegado

Leccion:

- comprobar `git diff` y `git status` antes de asumir que el cambio no funciona

### 3. `admin-calendario.html` es facil de romper

Causas historicas:

- mover nodos internos de FullCalendar
- usar propiedades no siempre presentes en callbacks
- mezclar fecha activa de una vista con la de otra

Leccion:

- preferir controles externos y cambios pequenos

## Estado actual de los cambios pendientes en git

Importante al retomar:

- hay archivos sueltos no trackeados que no forman parte del desarrollo principal, por ejemplo:
  - `.tmp_usuario_perfil_check.js`
  - `admin-actividades - copia.html`
  - `admin-actividades.html.last_attempt_backup.bak`
  - `docs/`

- existe `RESUMEN_TECNICO_HANDOFF.md` como archivo local de handoff y puede quedar sin trackear si no se hace `git add`

## Pendientes inmediatos para el siguiente chat

### Calendario

- seguir afinando si aparece alguna incoherencia de anclaje o scroll entre vistas
- revisar si el solicitante debe tener algun acceso mas visible al calendario desde `portal.html`

### Funcionalidades nuevas

Idea ya aparcada pero importante:

- asistente IA operativo conectado a APIs reales
- no IA libre
- panel lateral tipo chat
- respuestas por rol y sesion
- consultas sobre reservas, documentacion, actividades y estados reales

Orden recomendado cuando se retome:

1. cerrar del todo las funcionalidades pendientes de solicitud/edicion/reservas
2. luego abordar el asistente IA

## Estado general del sistema al cerrar este resumen

Se ha avanzado mucho en:

- coherencia UX entre pantallas
- limpieza de logicas legacy
- calendario administrativo y publico
- alertas de reservas y cambios de estado
- separacion clara del flujo de solicitud
- requisitos particulares por actividad

El sistema ya esta en una fase donde:

- la base funcional esta bastante estable
- los cambios nuevos conviene hacerlos encima de la version actual, no sobre residuos antiguos
- y el mayor valor ahora esta en:
  - rematar pequenas incoherencias
  - consolidar pruebas por escenarios reales
  - y empezar nuevas funcionalidades de forma controlada

## Frase de arranque sugerida para un chat nuevo

Se puede abrir un chat nuevo diciendo algo como:

> Retomamos el proyecto `C:\Users\edube\difas-bautismo-mar` desde el estado descrito en `RESUMEN_TECNICO_HANDOFF.md`. Quiero continuar desde la version actual, respetando las decisiones UX ya tomadas y sin volver a logicas legacy obsoletas.

