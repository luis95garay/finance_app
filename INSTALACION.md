# Instalación — Budget (Google Apps Script)

App de presupuesto por sobres estilo YNAB, corriendo sobre Google Sheets. Sin servidor, sin
base de datos, sin costo. Los datos viven en tu Drive y podés abrirlos como hoja de cálculo
cuando quieras.

Tiempo estimado: **15 minutos**, más unos 2 minutos que tarda la importación de tu historial.

---

## Archivos

| Archivo del repo | Cómo se llama dentro de Apps Script | Tipo |
|---|---|---|
| `Codigo.gs` | `Codigo` | Script |
| `Index.html` | `Index` | HTML |
| `Estilos.html` | `Estilos` | HTML |
| `Script.html` | `Script` | HTML |

Los tres HTML se crean con **Archivo › Nuevo › Archivo HTML** (no como script), y el nombre
tiene que ser exacto: el backend los une con `include('Estilos')` e `include('Script')`.
Apps Script agrega la extensión `.html` solo, así que al crearlos escribí `Index`, `Estilos`
y `Script` sin extensión.

---

## 1. Crear el Spreadsheet

1. Andá a [sheets.new](https://sheets.new) y nombralo, por ejemplo, `Budget`.
2. **Extensiones › Apps Script**. Se abre el editor con un proyecto vacío.
3. Nombrá el proyecto `Budget` arriba a la izquierda.

> La hoja `Gastos` del POC anterior no se toca ni se usa. Si vas a reutilizar aquel
> Spreadsheet, queda ahí como respaldo.

## 2. Pegar los cuatro archivos

1. En `Codigo.gs`, borrá todo y pegá el contenido de `Codigo.gs` de este repo.
2. Botón **+** junto a *Archivos* › **HTML** › nombre `Index` › pegá `Index.html`.
3. Repetí para `Estilos` y `Script`.
4. **Guardar** (Ctrl+S).

## 3. Crear las hojas

1. Volvé a la pestaña del Spreadsheet y **recargá la página**. Aparece un menú nuevo: **Budget**.
2. **Budget › Setup sheets**.
3. Google pide autorización la primera vez: *Revisar permisos* › tu cuenta › *Configuración
   avanzada* › *Ir a Budget (no seguro)* › *Permitir*. La advertencia es la normal para
   scripts propios sin verificar; el script solo toca este Spreadsheet.

Se crean 7 hojas: `Accounts`, `Categories`, `Budgets`, `Transactions`, `Snapshots`,
`Recurring`, `Config`.

**Si empezás de cero** (sin importar de YNAB), saltá al paso 5: la app te deja crear cuentas y
categorías desde la interfaz.

## 4. Importar tu historial de YNAB

En YNAB: *Budget Settings › Export budget data*. Bajás un `.zip` con dos CSV.

1. En el Spreadsheet: **Archivo › Importar › Subir**, elegí el CSV del **Register**, y en
   *Tipo de importación* seleccioná **Insertar hojas nuevas**. **Antes de confirmar, desmarcá la
   casilla "Convertir texto en números, fechas y fórmulas".** YNAB exporta las fechas en formato
   `MM/DD/YYYY` (mes/día); si tu Spreadsheet tiene configuración regional día/mes (la mayoría de
   países hispanohablantes), Sheets va a leer mal cualquier fecha donde el día sea ≤12 — por
   ejemplo `07/09/2026` (9 de julio) queda guardada como 7 de septiembre — y eso descuadra
   silenciosamente meses enteros del presupuesto, sin ningún error visible. Dejar el texto sin
   convertir evita el problema por completo. Renombrá la hoja resultante a exactamente
   `_ImportRegister`.
2. Lo mismo con el CSV del **Plan** (misma casilla desmarcada), renombrada a `_ImportPlan`.
3. **Budget › Import from YNAB**. La primera corrida no importa nada: crea una hoja
   `_ImportAccounts` con tus cuentas y el tipo que dedujo.
4. **Revisá `_ImportAccounts`.** Es el único paso que necesita criterio humano. La columna
   `type` acepta tres valores:

   | tipo | qué significa | cómo lo deduce |
   |---|---|---|
   | `debit` | efectivo, banco, ahorros: dinero que tenés | tiene transacciones categorizadas |
   | `credit` | tarjeta de crédito: dinero que debés | tiene su categoría en *Credit Card Payments* |
   | `tracking` | inversiones y activos: suma al patrimonio pero no se presupuesta | ninguna transacción categorizada |

   Corregí lo que esté mal y guardá.
5. **Budget › Import from YNAB** otra vez. Confirmá. Tarda 1–2 minutos con historial largo.
6. Leé el reporte al final. Compará los saldos por cuenta contra los de YNAB: deben coincidir
   al centavo. Si el reporte muestra una advertencia de fechas (⚠️), volvé al paso 1: borrá
   `_ImportRegister` y `_ImportPlan`, reimportalos con la casilla de conversión desmarcada, y
   corré la importación de nuevo — no sigas adelante con esa advertencia activa, porque significa
   que el presupuesto de varios meses va a estar mal aunque el conteo de filas se vea correcto.

Después de importar podés borrar `_ImportRegister`, `_ImportPlan` y `_ImportAccounts`.

## 5. Instalar el trigger de calendarización

**Budget › Install daily trigger**. Corre una vez por día de madrugada y postea los ingresos,
gastos o transferencias que hayas dejado programados.

Una regla programada para el día 30 se ejecuta el 28 en febrero (se ajusta al último día del
mes, nunca se salta). Si el trigger no corrió algún día, se pone al día en la siguiente corrida.

## 6. Publicar la app

1. En el editor de Apps Script: **Implementar › Nueva implementación**.
2. Engranaje › **Aplicación web**.
3. *Ejecutar como*: **Yo**. *Quién tiene acceso*: **Solo yo** (o *Cualquier persona con el
   enlace* si la va a usar otra persona con su propio navegador).
4. **Implementar** › copiá la URL.

## 7. Instalar en el celular

Abrí la URL en el celular y:

- **iPhone (Safari)**: Compartir › *Añadir a pantalla de inicio*.
- **Android (Chrome)**: menú ⋮ › *Añadir a pantalla de inicio*.

Queda con ícono propio y sin barra de navegador.

---

## Usar la app

La interfaz imita la app móvil de YNAB, en modo oscuro. Abajo hay cinco pestañas y el botón
**+ Transaction** (en Home, Plan y Spending) abre el formulario de movimientos.

| Pestaña | Qué muestra |
|---|---|
| **Home** | Tarjeta **Pinned** con tus sobres favoritos y una tarjeta plegable con el resumen del mes (ingreso, asignado, gastado). |
| **Plan** | Los sobres por grupo, con columnas *Assigned* (editable tocando el monto) y *Available*. Tocá "Sep 2026 ⌄" para cambiar de mes. Íconos: mostrar categorías ocultas, agregar categoría y menú ⋮ (plan de ingresos, etc.). |
| **Spending** | Movimientos del mes por fecha, con sección *Scheduled* para los programados. La lupa abre búsqueda y filtro por cuenta; ⋮ cambia de mes. |
| **Accounts** | Cuentas agrupadas en Cash, Credit y Tracking, más el patrimonio. ⊕ agrega una cuenta. |
| **Reflect** | Desglose de gasto del mes; indicadores del mes (gastado, % de los sobres usados, ingreso recibido, deuda de tarjetas); *Where it went* con cada categoría: gastado de lo disponible, % y barra; ingreso vs. gasto de los últimos seis meses; efectivo y patrimonio. |

**Sobres fijados (Pinned):** en Home tocá **Edit**, marcá los sobres que querés ver y
**Save**. Se guardan en la hoja `Config` (clave `pinnedCategories`), así que se ven igual en
todos tus dispositivos. Al instalar por primera vez la tarjeta arranca vacía.

---

## Cómo publicar cambios

Si editás cualquiera de los cuatro archivos, la URL **no** se actualiza sola:

**Implementar › Gestionar implementaciones** › ícono de lápiz › *Versión*: **Nueva versión** ›
**Implementar**. La URL se mantiene.

---

## Cómo funciona el presupuesto

Las reglas que gobiernan todos los números, para que nada te sorprenda:

- **Cada categoría es un sobre.** `disponible = lo que traía del mes pasado + lo asignado este
  mes + el movimiento del mes`. Lo que no gastás se arrastra al mes siguiente.

- **El ingreso no cae en una categoría, cae en *Ready to Assign*** y de ahí lo repartís. Si
  registrás un ingreso y le asignás categorías en el mismo formulario, la app hace las dos
  cosas de un tirón. Cuando ese número es distinto de cero aparece un banner arriba de Plan y
  Home: verde con lo que falta asignar, o rojo si asignaste más de lo que tenés. En cero no se
  muestra nada, porque cada dólar ya tiene un trabajo.

- **Gastar con tarjeta de crédito mueve dinero dos veces.** Si gastás $20 de Transportation con
  la tarjeta X, se descuentan $20 de Transportation **y** se apartan $20 en la categoría
  *Payment: X*, que es la plata reservada para pagar esa tarjeta. Cuando pagás la tarjeta
  (transferencia de una cuenta débito hacia la tarjeta), ese sobre se vacía y la deuda baja.

- **Si te sobregirás, la app no finge que hay plata.** Un sobre en negativo pagado en efectivo
  no arrastra el negativo: se descuenta del *Ready to Assign* del mes siguiente. Un sobregiro
  con tarjeta no se reserva para el pago — es deuda que quedó descubierta y se ve.

- **Mover presupuesto entre sobres** no crea ningún movimiento: tocá una categoría en Plan y
  usá *Move money*.

- **Las cuentas `tracking` quedan fuera del presupuesto.** Suman al patrimonio y nada más.

---

## Menú Budget

| Opción | Para qué |
|---|---|
| Setup sheets | Crea las hojas que falten. Es seguro correrlo varias veces. |
| Import from YNAB | La importación del paso 4. |
| Install daily trigger | Activa la calendarización. |
| Run scheduled transactions now | Fuerza la corrida sin esperar a mañana. |
| Rebuild snapshots | Borra los saldos mensuales calculados para que se recalculen. Si algún número se ve raro, esto es lo primero que hay que probar. |
| Run self test | 20 verificaciones del motor de cálculo. Resultado en *Registro de ejecuciones*. |
| Benchmark | Cuánto tarda en cargar un mes. |

---

## Problemas frecuentes

**Plan muestra todo en $0 (o una cuenta tiene un saldo que no corresponde), pese a que la
importación no dio ningún error.**
Es el síntoma de que Sheets leyó mal las fechas del Register al importarlo (ver el aviso al pie
del paso 4): con configuración regional día/mes, una fecha como `07/09/2026` (9 de julio en
formato de YNAB) se guarda como 7 de septiembre. El conteo de filas importadas da bien porque
cada transacción sigue existiendo — lo que cambia es a qué mes queda asignada, así que el
presupuesto del mes que estás mirando puede aparecer vacío mientras esa actividad quedó en otro
mes. Solución: borrá `_ImportRegister` y `_ImportPlan`, volvé a importar los dos CSV con
**"Convertir texto en números, fechas y fórmulas" desmarcado**, y corré *Import from YNAB* de
nuevo (no hace falta rehacer `_ImportAccounts`, ya tiene lo que necesita). El reporte de la
importación avisa automáticamente con un ⚠️ si detecta este patrón, comparando la actividad
reconstruida contra la columna `Activity` del propio export de YNAB.

**"Missing sheet X. Run Budget > Setup sheets."**
Se borró una hoja a mano. Corré *Setup sheets*.

**No aparece el menú Budget.**
Recargá la pestaña del Spreadsheet. El menú se crea al abrir el archivo.

**La app carga en blanco o dice "Could not load the budget".**
Casi siempre es que falta uno de los tres HTML o el nombre no es exacto (`Index`, `Estilos`,
`Script`, sin extensión). Revisá también *Ejecuciones* en el editor para ver el error real.

**Cambié el código y la app sigue igual.**
Falta publicar versión nueva (ver *Cómo publicar cambios*). El editor no republica solo. Si
actualizaste desde la versión con la banda superior clara, pegá los **cuatro** archivos: el
diseño nuevo cambia `Index`, `Estilos` y `Script`, y los pins necesitan la función
`setPinnedCategories` de `Codigo`. Si falta alguno, Home falla al guardar pins o la interfaz
queda a medias.

**Borré sin querer mis sobres fijados o quiero resetearlos.**
Borrá la fila `pinnedCategories` de la hoja `Config` y elegilos de nuevo desde Home › Edit.

**El trigger no corre.**
*Activadores* (ícono de reloj) en el editor: debe existir uno para
`runScheduledTransactions`. Si falló, ahí se ve el error. Reinstalalo con
*Install daily trigger*, que primero borra el anterior.

**Un ingreso programado se posteó dos veces.**
No debería: cada regla guarda el último mes en que corrió. Si pasó, borrá la fila duplicada en
la hoja `Transactions` y corré *Rebuild snapshots*.

**Los números de un mes viejo no cuadran.**
Todo lo anterior a la importación está bloqueado con los valores de YNAB
(columna `locked` en la hoja `Snapshots`) y no se recalcula. Si editás una transacción vieja, el
saldo de la cuenta cambia pero el presupuesto histórico no. Es intencional.

---

## Límites conocidos

- **La categoría de pago de tarjeta no reproduce el histórico de YNAB al 100%.** El motor
  reproduce exacto 3,451 de las 3,528 filas del export; las 77 restantes son las tres categorías
  *Credit Card Payments*, donde YNAB aplica una heurística interna de cobertura que no se puede
  deducir desde un CSV. Por eso la importación **bloquea los valores de YNAB** como saldo de
  apertura de cada mes: el estado con el que abrís la app es exacto, y de ahí en adelante manda
  la regla del motor, que es determinista y está documentada arriba.

- **Ready to Assign arranca en cero.** El export de YNAB no incluye ese número, así que no hay
  contra qué compararlo. La importación normaliza la serie para que el mes actual quede en cero
  (lo normal en un presupuesto al día) y el reporte te dice de cuánto fue el ajuste. Si tu YNAB
  muestra otra cosa, corregilo asignando o desasignando esa diferencia.

- **Cada carga lee todas las transacciones.** Los saldos de cuenta son acumulativos, así que no
  hay forma de leer solo el mes visible. Con ~6,400 líneas es una sola lectura y va bien; medí
  con *Benchmark* en tu cuenta. Si algún día se pone lento, la salida es archivar años viejos en
  otro Spreadsheet.

- **Un solo tipo de moneda.** Se configura en la hoja `Config` (clave `currency`).

- **No hay adjuntos, ni conciliación bancaria automática, ni importación de movimientos del
  banco.** Todo se digita a mano, que es el punto de este flujo.
