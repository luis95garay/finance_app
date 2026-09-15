# Budget — presupuesto por sobres (Google Apps Script)

App de presupuesto por sobres estilo [YNAB](https://www.ynab.com/), corriendo enteramente
sobre Google Apps Script + Google Sheets. Sin servidor, sin base de datos, sin build. Los
cuatro archivos se pegan directo en el editor de Apps Script vinculado a un Google Sheet y se
despliegan como web app. Los datos quedan en tu propio Drive.

## Capturas

| | | |
|---|---|---|
| ![Home](home.jpeg) | ![Plan](plan.jpeg) | ![Spending](spending.jpeg) |
| ![Accounts](accounts.jpeg) | ![Reflect](reflect.jpeg) | |

## Qué incluye

- **Presupuesto por sobres**: cada categoría tiene un balance disponible que se arrastra mes a
  mes (`carryover + assigned + activity`).
- **Cuentas debit, credit y tracking**: las cuentas de inversión/activos (`tracking`) cuentan
  para el patrimonio neto pero quedan fuera del presupuesto.
- **Pago de tarjetas de crédito integrado**: cada cuenta de crédito tiene su propia categoría
  de pago automática, que se llena a medida que gastás con esa tarjeta (sin reservar de más).
- **Transferencias con reglas de YNAB**: mover plata entre cuentas no toca el presupuesto,
  salvo que salde una tarjeta o entre a una cuenta de inversión.
- **Importador de YNAB**: migrá tu historial completo (cuentas, categorías, transacciones,
  balances) desde el export CSV de YNAB, en dos pasadas (revisión de cuentas + importación).
- **Motor de cálculo puro y testeado**: la lógica de presupuesto vive en funciones sin efectos
  secundarios (`computeMonth_`, `computeBalances_`), validadas contra un export real de YNAB.

## Archivos del proyecto

| Archivo | Rol |
|---|---|
| `Codigo.gs` | Backend completo: esquema, motor de cálculo, API de lectura/escritura, importador de YNAB, tareas programadas. |
| `Index.html` | Shell de la página (barra de tabs, modal, navegación de meses). |
| `Estilos.html` | Todo el CSS. |
| `Script.html` | Todo el JS del frontend, hablando con el backend vía `google.script.run`. |

No hay separación frontend/backend ni pipeline de build: los cuatro archivos viven en un solo
proyecto de Apps Script vinculado a un único Spreadsheet.

## Instalación

Ver [`INSTALACION.md`](INSTALACION.md) para la guía completa de despliegue (~15 minutos),
incluyendo la importación del historial de YNAB.

## Historia del proyecto

Ver [`resumen-proyecto-gastos.md`](resumen-proyecto-gastos.md): esto empezó como un registro
simple de gastos (POC) y creció hasta ser una app de presupuesto completa después de que se
importara un export real de YNAB.

## Desarrollo

No hay `package.json`, scripts de npm ni CI: este es un proyecto pensado para pegarse directo
en el editor de Apps Script. Para más detalle sobre el modelo de datos, las reglas del motor de
presupuesto y cómo iterar localmente sin un sandbox de Apps Script, ver [`CLAUDE.md`](CLAUDE.md).
