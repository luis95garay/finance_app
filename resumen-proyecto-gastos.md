# Contexto del proyecto: App de registro de gastos personales

## Situación inicial

Una persona (no técnica, sin conocimientos de programación) maneja actualmente sus finanzas personales en Google Drive / Google Sheets. Le pidió a Luis ayuda para tener una forma más cómoda de registrar sus gastos desde el celular. El objetivo original **no es reemplazar Google Sheets** — es mejorar la interfaz de captura manteniendo los datos donde ya viven.

## Decisión de arquitectura

Se evaluó la opción de construir un HTML desplegado en Cloud Run desde el inicio, y se descartó para esta etapa. Motivo: un HTML estático en Cloud Run no resuelve persistencia por sí solo (requeriría backend + base de datos + auth), lo cual es sobre-ingeniería para un problema que es 100% de UI de captura, y además rompe el requisito implícito de que los datos sigan siendo de la usuaria y editables en su Sheet de siempre.

**Stack elegido para el MVP: Google Apps Script**, vinculado directamente al Google Sheet existente de la usuaria.

Ventajas de esta decisión:
- Cero costo de hosting/infraestructura
- Cero servidor o base de datos nueva que mantener
- Auth resuelto (cuenta de Google de la propia usuaria)
- Los datos siguen viviendo en su Drive, con su historial intacto
- Se puede instalar como PWA en la pantalla de inicio del celular ("Agregar a pantalla de inicio"), sintiéndose como app nativa sin serlo

## Estado actual: POC funcional entregado

Se construyó y entregó un proof of concept end-to-end, compuesto por dos archivos:

### `Codigo.gs` (backend Apps Script)
- `doGet()`: sirve el HTML como web app
- `guardarGasto(gasto)`: escribe una fila en la hoja `Gastos` (crea la hoja con encabezados si no existe). Campos: Fecha, Categoría, Monto, Nota
- `obtenerUltimosGastos(cantidad)`: devuelve los últimos N gastos para mostrar historial en la UI

### `Index.html` (frontend)
- Interfaz mobile-first: categorías como botones grandes (Comida, Transporte, Casa, Salud, Ocio, Otros — placeholder, pendiente de validar con la usuaria), input numérico grande para el monto, campo de fecha (default hoy), nota opcional
- Guardado vía `google.script.run` (comunicación nativa Apps Script sin necesidad de API REST)
- Confirmación visual al guardar + historial de últimos gastos registrados debajo del formulario

### Pasos de despliegue (manuales, ~10-15 min, ya validados)
1. Abrir el Sheet → Extensiones → Apps Script
2. Pegar `Codigo.gs` en el archivo de código
3. Crear archivo HTML nuevo llamado exactamente `Index`, pegar `Index.html`
4. Implementar → Nueva implementación → Aplicación web → Ejecutar como "Yo" → Acceso según corresponda
5. Copiar la URL, agregarla a pantalla de inicio del celular

## Roadmap discutido (no implementado aún)

La usuaria quiere evolucionar esto hacia un sistema de presupuestos por sobres (estilo YNAB), con las siguientes automatizaciones:

1. **Presupuestos por categoría**: cada gasto registrado debe restar automáticamente del presupuesto de su categoría (ej. Entretenimiento)
2. **Múltiples cuentas**: soporte para "Efectivo", "Tarjeta de crédito", etc., cada una con su propio saldo
3. **Reparto automático de ingreso mensual**: el día del ingreso (ej. el 31), repartir el monto entre presupuestos según reglas definidas
4. **Traslado de sobrante a ahorro**: a fin de mes, lo no gastado de cada presupuesto se mueve a una cuenta "Ahorro"

### Diseño de datos propuesto para el roadmap
Separar en varias hojas dentro del mismo Spreadsheet:
- `Cuentas`: nombre de cuenta + saldo actual
- `Presupuestos`: categoría, monto asignado, gastado este mes, disponible
- `Movimientos`: fecha, categoría, monto, cuenta origen (reemplaza/expande la hoja `Gastos` actual)
- `Reglas`: cómo se reparte el ingreso mensual entre presupuestos

### Notas técnicas para la automatización mensual
- Usar un **trigger diario** (no uno fijado al día 31, porque no todos los meses tienen 31 días) que chequee internamente si la fecha actual es el último día del mes antes de ejecutar la lógica de cierre de mes
- Usar `LockService` (`getScriptLock`) al escribir/restar sobre `Presupuestos` y `Cuentas` para evitar condiciones de carrera si hay escrituras simultáneas (ej. un gasto registrado justo cuando corre el job de fin de mes)
- Límites de cuota de Apps Script (gratis): ~90 min/día de ejecución de triggers, 20 triggers activos por script — ninguno es un problema real a esta escala

### Orden de implementación sugerido
1. Resta automática del presupuesto al registrar cada gasto (extiende el POC actual)
2. Reparto automático del ingreso mensual (validar bien las reglas de reparto con la usuaria antes de automatizar, porque van a cambiar)
3. Traslado de sobrante a ahorro (dejar para el final — mueve "dinero real" entre categorías, requiere logging claro de qué se movió y por qué)

## Cuándo migrar a Cloud Run + API + base de datos propia

Se discutió que la migración a una arquitectura más pesada (Cloud Run, API REST/GraphQL, Firestore/Postgres) **no** está determinada solo por la cantidad de usuarios. Triggers reales para migrar:

1. Escrituras concurrentes *frecuentes* sobre el mismo registro (no solo "varios usuarios", sino alta frecuencia de escritura simultánea)
2. Volumen de datos acercándose al límite de Sheets (10M celdas) o rendimiento degradado por miles de filas con fórmulas/triggers complejos
3. Necesidad de consultas complejas (joins, agregaciones pesadas, búsqueda full-text) que Sheets no resuelve bien
4. Lógica de negocio compleja: roles/auth granular, transacciones atómicas multi-tabla, colas de trabajo, integraciones de pago reales
5. Necesidad de servir la misma lógica a múltiples frontends (web + iOS + Android nativos)
6. Requisitos de cumplimiento/auditoría que Sheets no puede satisfacer

Señal más honesta para migrar: cuando el desarrollo empieza a luchar contra la herramienta (Apps Script) en vez de contra el problema de negocio — no antes, por especulación de escala futura.

Para el alcance actual (presupuestos, cuentas, categorías, pocos usuarios) se concluyó que Apps Script + Sheets es suficiente por un tiempo largo. La lógica de negocio que se construya ahí (reglas de reparto, cálculo de sobrante, resta por categoría) se traduce casi 1:1 a un backend futuro si algún día hace falta migrar — no es trabajo perdido.

## Archivos del POC (adjuntos/disponibles)
- `Codigo.gs`
- `Index.html`
