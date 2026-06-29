# Handoff técnico: cambio de modelo documental multipropietario

Fecha de preparación: 2026-06-29  
Frase para retomar el trabajo: **continuamos con el cambio de modelo documental multipropietario**

## Objetivo funcional

Evolucionar la gestión documental obligatoria de actividades desde el modelo actual de **responsable documental único por actividad** hacia un modelo **multipropietario por documento**.

La actividad seguirá perteneciendo y siendo coordinada por su administrador organizador, pero la documentación preceptiva asociada a esa actividad podrá estar formada por documentos procedentes de repositorios de varios propietarios documentales distintos. Cada documento deberá ser revisado y aprobado por su propietario documental.

## Situación actual resumida

Actualmente, la aplicación maneja un modelo en el que:

- Cada administrador puede tener documentación obligatoria propia.
- Cada secretaría puede tener documentación obligatoria propia.
- Un administrador puede estar en autogestión documental o delegar la gestión documental en una secretaría.
- En la edición de actividad, el bloque de documentación preceptiva queda editable solo para el responsable documental efectivo de esa actividad.
- La validación documental se encamina hacia el responsable documental de la actividad, no hacia el propietario individual de cada documento.

Esta lógica está repartida principalmente en:

- `admin-actividades.html`
- `functions/api/admin/actividades-guardar.js`
- `functions/api/_actividad_documentacion.js`
- `functions/api/_documentacion_responsable.js`
- `functions/api/_documentacion_actividades_solicitables.js`
- `functions/api/_impacto_documental_reservas.js`
- `functions/api/usuario/documentacion-admin.js`
- `functions/api/admin/documentacion-contexto.js`
- `functions/api/admin/documentacion-resolver.js`
- `functions/api/admin/documentacion-resolver-agrupado.js`
- `functions/api/secretaria/documentacion-resolver-agrupado.js`
- `functions/api/admin/documentacion-pendientes.js`
- `functions/api/secretaria/documentacion-pendientes.js`
- `functions/api/admin/usuarios-publicos-documentos.js`
- `functions/api/secretaria/usuarios-publicos-documentos.js`

## Nueva regla de negocio deseada

### Configuración de documentos exigidos por actividad

El administrador propietario/coordinador de la actividad debe ser quien tenga la potestad de:

- Asociar documentos obligatorios a su actividad.
- Desvincular documentos obligatorios de su actividad.
- Elegir documentos desde repositorios de distintos propietarios documentales.

El gestor documental ya no debe decidir por sí mismo qué documentos exige una actividad solo por ser responsable documental delegado.

### Propiedad y validación

Cada documento obligatorio mantiene su propietario documental original:

- Si el documento pertenece a un administrador, ese administrador lo valida.
- Si el documento pertenece a una secretaría, esa secretaría lo valida.

Una misma actividad puede exigir, por ejemplo:

- Documento A, propiedad del administrador organizador.
- Documento B, propiedad de una secretaría.
- Documento C, propiedad de otro propietario documental permitido.

En ese caso:

- El solicitante remite la documentación exigida por la actividad.
- Cada documento remitido entra en la bandeja de revisión de su propietario documental.
- Cada propietario solo revisa los documentos de los que es responsable.
- La actividad solo queda documentalmente habilitada cuando todos los documentos exigidos para esa actividad están aprobados por sus propietarios correspondientes.

## Separación conceptual obligatoria

El cambio debe separar dos conceptos que ahora están parcialmente mezclados:

1. **Configuración documental de actividad**
   - Quién decide qué documentos exige una actividad.
   - Debe ser el administrador propietario de la actividad.

2. **Validación documental**
   - Quién revisa y aprueba/rechaza cada documento remitido.
   - Debe ser el propietario documental de cada documento.

## UI esperada en edición de actividad

En `admin-actividades.html`, bloque `Documentación preceptiva`:

- El administrador de la actividad debe poder añadir/quitar documentos exigidos.
- No debe quedar bloqueado por el modo de gestión documental delegado.
- El texto actual tipo “solo el responsable documental puede modificar...” debe cambiarse.
- La UI debe evolucionar hacia una selección por propietario documental:
  - Selector/listado de propietarios documentales disponibles.
  - Documentos disponibles de cada propietario.
  - Lista de documentos ya vinculados a la actividad, mostrando propietario y nombre de documento.

Primer paso recomendable:

- Cambiar solo la potestad de edición para que el administrador de la actividad pueda modificar la documentación preceptiva.
- Mantener compatibilidad con el modelo actual mientras se diseña la relación multipropietario real.

## Modelo de datos recomendado

No hacer una sustitución brusca. Mantener compatibilidad hacia atrás y añadir una tabla relacional nueva.

Tabla propuesta:

```sql
CREATE TABLE IF NOT EXISTS actividad_documentos_obligatorios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actividad_id INTEGER NOT NULL,
  documento_id INTEGER NOT NULL,
  propietario_id INTEGER NOT NULL,
  propietario_rol TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actividad_id, documento_id)
);
```

Donde:

- `actividad_id`: actividad que exige el documento.
- `documento_id`: id de `admin_documentos_comunes`.
- `propietario_id`: usuario propietario del documento.
- `propietario_rol`: `ADMIN`, `SECRETARIA` u otro rol documental futuro.
- `activo`: permite desvincular sin perder histórico si se decide conservar trazabilidad.

Importante:

- La tabla actual `admin_documentos_comunes` ya contiene documentos con `admin_id`; en el nuevo modelo ese `admin_id` debe interpretarse como propietario del documento, no necesariamente como administrador organizador de la actividad.
- Si hoy la configuración documental de actividad se guarda por nombres/modo en campos de actividad, esa información debe mantenerse temporalmente como compatibilidad mientras se migra a ids.

## Migración progresiva recomendada

### Fase 1: lectura y diagnóstico sin cambiar comportamiento

Objetivo:

- Confirmar dónde se guarda exactamente la documentación preceptiva actual.
- Identificar si se guarda por nombre, modo, lista JSON, campos de actividad o helper compartido.
- Documentar todos los flujos que consultan documentos exigidos para permitir/rechazar solicitudes.

Archivos clave:

- `functions/api/_actividad_documentacion.js`
- `functions/api/_documentacion_actividades_solicitables.js`
- `functions/api/_reservas_documentacion.js`
- `functions/api/actividades.js`
- `functions/api/admin/mis-actividades.js`
- `functions/api/secretaria/actividades.js`
- `admin-actividades.html`

### Fase 2: habilitar edición por administrador de actividad

Objetivo:

- En edición de actividad, permitir que el administrador propietario de la actividad modifique la documentación preceptiva.
- Mantener la visualización en modo consulta para usuarios que no sean el administrador propietario.
- No cambiar todavía toda la validación documental.

Puntos probables:

- `functions/api/admin/mis-actividades.js`: actualmente expone `puede_editar_documentacion_actividad`.
- `functions/api/secretaria/actividades.js`: actualmente puede forzar permisos de edición documental a secretaría.
- `admin-actividades.html`: usa `actividad.puede_editar_documentacion_actividad` para activar/desactivar el bloque.
- `functions/api/admin/actividades-guardar.js`: actualmente usa `usuarioEsResponsableDocumentalActividad(...)` para aceptar o descartar cambios documentales.

Nueva regla en esta fase:

- Puede editar documentación de actividad si `session.usuario_id === actividad.admin_id` o si es `SUPERADMIN`.
- Una secretaría puede verla, pero no modificarla, salvo que además sea propietaria/coordinadora de esa actividad si existiera ese caso.

### Fase 3: nueva relación actividad-documento por id

Objetivo:

- Crear tabla `actividad_documentos_obligatorios`.
- Empezar a guardar documentos exigidos por `documento_id`, no solo por nombre.
- Mantener conversión temporal desde configuración antigua por nombre para no romper actividades existentes.

Reglas:

- Cada documento exigido debe resolver su `propietario_id` desde `admin_documentos_comunes.admin_id`.
- La actividad puede tener documentos de varios propietarios.
- Evitar duplicados por `(actividad_id, documento_id)`.

### Fase 4: selección UI multipropietario

Objetivo:

- En `admin-actividades.html`, reemplazar el selector simple actual por una UI de selección por propietario documental.

UX sugerida:

- Botón `Añadir`.
- Modal o bloque con:
  - Selector de propietario documental.
  - Lista de documentos activos de ese propietario.
  - Casillas de verificación para seleccionar varios documentos.
  - Botón `Aceptar`.
- En la lista de documentos vinculados:
  - Nombre del documento.
  - Propietario documental.
  - Versión.
  - Botón para visualizar documento base.
  - Botón para desvincular, si el usuario es administrador de la actividad.

### Fase 5: remisión documental por solicitante

Objetivo:

- Cuando el solicitante llegue al área documental desde una actividad, la app debe mostrar documentos exigidos por esa actividad, aunque pertenezcan a varios propietarios.
- La remisión de cada documento debe quedar vinculada al propietario documental correcto.

Archivos probables:

- `functions/api/usuario/documentacion-admin.js`
- `functions/api/usuario/documentacion-resumen.js`
- `functions/api/usuario/documentacion-organizadores.js`
- `usuario-documentacion.html`
- `usuario-perfil.html`

Riesgo:

- Muchas tablas actuales se llaman `centro_admin_documentacion` y están estructuradas por `centro_usuario_id + admin_id`. En el nuevo modelo, `admin_id` puede seguir representando el propietario documental, pero no debe confundirse con el organizador de la actividad.

### Fase 6: bandejas de revisión por propietario documental

Objetivo:

- Cada propietario documental ve solo documentos que son suyos.
- Si una actividad exige documentos de tres propietarios distintos, cada uno recibe en su bandeja únicamente sus documentos.

Archivos probables:

- `functions/api/admin/documentacion-pendientes.js`
- `functions/api/secretaria/documentacion-pendientes.js`
- `functions/api/admin/documentacion-detalle.js`
- `functions/api/secretaria/documentacion-detalle.js`
- `functions/api/admin/documentacion-resolver.js`
- `functions/api/admin/documentacion-resolver-agrupado.js`
- `functions/api/secretaria/documentacion-resolver-agrupado.js`
- `admin-validaciones-documentales.html`
- `admin-documentos.html`

### Fase 7: cálculo de actividades solicitables

Objetivo:

- El correo y las comprobaciones de solicitud deben calcular si el solicitante tiene aprobados todos los documentos exigidos por cada actividad, independientemente del propietario de cada documento.

Archivo clave:

- `functions/api/_documentacion_actividades_solicitables.js`

Nueva regla:

- Para cada actividad reservable, activa y visible:
  - Obtener documentos exigidos por `actividad_documentos_obligatorios`.
  - Para cada documento, comprobar si el solicitante tiene ese documento aprobado en el expediente correspondiente al propietario documental.
  - Si todos están aprobados, la actividad es solicitables.
  - Si falta alguno, no es solicitables.

### Fase 8: impacto documental sobre reservas existentes

Objetivo:

- Si se añade/quita/cambia un documento exigido por una actividad, recalcular reservas afectadas.
- Si la modificación afecta a documentos propiedad de varios validadores, las notificaciones deben ser coherentes.

Archivos clave:

- `functions/api/_impacto_documental_reservas.js`
- `functions/api/_avisos_actividad_documentacion.js`
- `functions/api/_reservas_documentacion.js`
- `functions/api/admin/actividades-guardar.js`

No romper:

- Regla existente de suspensión/eliminación de solicitudes por cambios documentales.
- Regla de restablecer estado previo cuando se aprueba documentación regularizada.
- Correos de documentación aprobada/rechazada y tabla de actividades disponibles para solicitud.

## Compatibilidad y riesgos

### Riesgo 1: documentos identificados por nombre

Si la configuración actual guarda documentos por nombre, el nuevo modelo debe migrar a ids para evitar conflictos:

- Dos propietarios podrían tener documentos con el mismo nombre.
- La validación por nombre dejaría de ser fiable.

Mitigación:

- Mantener lectura legacy por nombre solo como fallback.
- Nuevo guardado siempre por `documento_id`.

### Riesgo 2: confusión entre organizador y propietario documental

En el modelo nuevo:

- `actividad.admin_id` = propietario/coordinador de la actividad.
- `admin_documentos_comunes.admin_id` = propietario documental del documento.
- No deben asumirse iguales.

### Riesgo 3: correos automáticos

Los correos no deben decir que “el organizador X” valida toda la documentación si intervienen varios propietarios documentales.

Recomendación:

- Correo de revisión documental: explicar documento, estado y propietario/revisor si aporta claridad.
- Correo de actividades disponibles: mantener enfoque global por actividades solicitables, sin centrarlo en un único organizador documental.

### Riesgo 4: bandejas duplicadas o invisibles

El documento remitido debe aparecer en una sola bandeja: la del propietario del documento.

Evitar:

- Que aparezca en la bandeja del organizador solo porque creó la actividad.
- Que aparezca en la secretaría delegada antigua si no es propietaria de ese documento.

## Reglas de negocio consolidadas para documentos

Estados UI de documento:

- `No presentado`
- `En revisión`
- `Aprobado`
- `Rechazado`
- `Desactualizado`

No es estado documental:

- `No requerido`

La relevancia documental debe evaluarse por actividad:

- Un solicitante puede tener documentación incompleta para un propietario documental global, pero completa para una actividad concreta.
- La aptitud para solicitar depende solo de los documentos exigidos por esa actividad.

## Propuesta de primer cambio seguro al retomar

Cuando se retome con la frase **continuamos con el cambio de modelo documental multipropietario**, no empezar directamente por una migración completa.

Primer paso recomendado:

1. Leer código actual de:
   - `functions/api/admin/mis-actividades.js`
   - `functions/api/secretaria/actividades.js`
   - `functions/api/admin/actividades-guardar.js`
   - `functions/api/_actividad_documentacion.js`
   - `admin-actividades.html`
2. Cambiar solo la autorización de edición de documentación preceptiva:
   - Puede editar el administrador propietario de la actividad.
   - No puede editar solo por ser responsable documental delegado.
3. Mantener el selector actual y el modelo actual durante esa primera capa.
4. Validar:
   - Administrador propietario puede añadir/quitar documentos.
   - Secretaría delegada puede ver, pero no modificar.
   - Guardar actividad no descarta los cambios documentales del administrador.
   - No se rompen correos ni cálculo documental actual.

Segundo paso:

- Diseñar e introducir tabla nueva `actividad_documentos_obligatorios`.

## Criterio de éxito final

El cambio estará completo cuando:

- Una actividad pueda exigir documentos de varios propietarios documentales.
- El administrador de la actividad pueda configurar esos documentos.
- Cada documento remitido sea revisado por su propietario.
- Las bandejas de revisión muestren solo documentos propios.
- El solicitante pueda solicitar una actividad solo si tiene aprobados todos los documentos exigidos por esa actividad.
- Los correos automáticos reflejen correctamente el estado documental y las actividades disponibles, sin depender de un gestor documental único.

