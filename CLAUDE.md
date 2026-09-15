# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A YNAB-style envelope budgeting app built entirely on Google Apps Script + Google Sheets — no
server, no database, no build step. Four files get pasted directly into the Apps Script editor
bound to a Google Sheet and deployed as a web app. See `INSTALACION.md` for the full deployment
walkthrough and `resumen-proyecto-gastos.md` for the project history (this started as a simple
expense-logging POC and grew into a full budget app after the user provided a real YNAB export).

## Files and how they fit together

| File | Role |
|---|---|
| `Codigo.gs` | The entire backend: schema, compute engine, read/write API, YNAB importer, scheduling. This is where almost all logic lives. |
| `Index.html` | Page shell only (tab bar, modal skeleton, month nav). Uses `<?!= include('Estilos'); ?>` / `<?!= include('Script'); ?>` — Apps Script's `HtmlService` template syntax, evaluated server-side by `doGet()`. |
| `Estilos.html` | All CSS. |
| `Script.html` | All frontend JS. Talks to the backend exclusively through `google.script.run.<functionName>(payload)`, always via the `api()`/`call()` wrappers in this file — never call `google.script.run` directly elsewhere. |
| `INSTALACION.md` | User-facing install/deploy guide (Spanish). Keep it in sync with any change to setup steps, menu items, or the import flow. |

There is no separate frontend/backend deploy: all four files live in one Apps Script project
bound to one Spreadsheet, and "building" means pasting updated file contents into the Apps
Script editor and creating a new deployment version (Apps Script does not auto-publish edits).

## Data model

Everything lives in named sheets of the bound Spreadsheet, declared in the `SCHEMA` object at
the top of `Codigo.gs`. Key design choices that aren't obvious from a quick read:

- **`Transactions` is split-level**: one row per split line, not one row per transaction. A
  transaction with N category splits is N rows sharing a `txnId`. This mirrors YNAB's own
  export format and avoids a join against a separate splits table. `groupTxns_()` re-assembles
  rows into whole transactions for display.
- **Amounts are signed** (`amount` column), not separate inflow/outflow columns. Sign convention:
  positive = money entering the account named in `accountId`.
- **Accounts have three types**: `debit`, `credit`, `tracking`. `tracking` accounts (investments,
  assets) count toward net worth but are completely off-budget — their transactions never touch
  a category's activity or Ready to Assign.
- **Every credit account auto-gets a linked category** of `type: 'cc_payment'` in the
  `Credit Card Payments` group (`linkedAccountId` points back to the account). This category
  can't be created, hidden, or deleted directly by the user — it's managed alongside its account.
- **`Snapshots` holds locked vs. computed carryover**. Rows imported from a YNAB export are
  marked `locked: true` and are never recalculated — they're treated as ground truth. Only
  months after the import cutoff get computed and cached by `stateUpTo_()` /
  `invalidateSnapshotsFrom_()`. Don't remove the `locked` flag check when touching snapshot code;
  doing so would let the engine overwrite historically-accurate imported data with its own
  (necessarily imperfect) reconstruction.
- **`RTA`** (the string constant, not a sheet) is a pseudo-category id representing "Ready to
  Assign" — money that hasn't been budgeted into a category yet.

## The compute engine (the part that actually matters)

`computeMonth_()` and `computeBalances_()` in `Codigo.gs` are pure functions — no
`SpreadsheetApp` calls — so they can be tested with in-memory fixtures. This separation is
deliberate and should be preserved: any new budgeting rule belongs in these functions, not
scattered through the read/write API.

Rules encoded there, in priority order:

1. `available(category, month) = carryover + assigned + activity` — envelopes roll over month
   to month.
2. A cash-category overspend (negative available) does **not** roll forward; it's pulled out of
   next month's Ready to Assign instead. An overspend in a `cc_payment` category **does** roll
   forward — it represents real uncovered debt.
3. Spending on a credit account moves the spent amount into that card's payment envelope, but
   **only up to what the envelope can actually cover** — overspending is never silently
   budgeted for. This intentionally diverges from a naive "always reserve 100%" reading of the
   requirement, because validating against a real YNAB export showed YNAB caps it too.
4. Transfers only touch the budget when they settle a credit card (debit → credit) or when a
   leg carries an explicit category (e.g., moving money into a tracking/investment account).
   Card-to-card transfers move debt around without releasing any envelope.

If you change any of this, re-run `selfTest()` (in the Apps Script editor, or headless — see
Testing below) before touching anything else; it encodes these rules as executable assertions.

## Working on this locally (no Apps Script sandbox available)

Apps Script code can't run outside the Apps Script editor natively, so this repo's dev loop
depends on a self-authored emulation layer that has proven itself against the real dataset:

- **`SpreadsheetApp` / `Utilities` / `LockService` / etc. can be stubbed** with a small in-memory
  sheet emulator (arrays of arrays behind a `Range`-like API) to run `Codigo.gs` unmodified in
  Node via `new Function(source + '; return {...exports...}')`. Build this stub in the
  scratchpad, not in the repo, if you need it again — it's dev tooling, not part of the shipped
  project.
- The user's own historical YNAB export (two CSVs: `...Plan.csv` and `...Register.csv`, both in
  this directory) is the ground-truth test fixture. Any change to the compute engine or the
  importer should be re-validated against it: reconstruct via `runImport_()` in the emulator and
  diff the resulting `Available`/`Activity` per (month, category) against the Plan CSV, and diff
  computed account balances against the Register CSV's net inflow/outflow per account. Expect
  the three `Credit Card Payments` categories to have some irreducible drift (YNAB applies an
  internal coverage heuristic not fully reconstructable from the export) — everything else
  should match to the cent.
- For UI changes: the four files can be flattened into one static HTML page (replace the two
  `<?!= include(...) ?>` template tags with the literal file contents, stub `google.script.run`
  to call the backend functions directly) and driven with `jsdom` or a real browser. This is the
  only way to see the tab bar / modal / rendering logic actually work end-to-end before deploying.

There is no package.json, no npm scripts, and no CI in this repo — testing infrastructure like
the above is disposable/scratch, not a checked-in test suite.

## The YNAB importer

`importFromYnab()` is a two-pass menu action:

1. First run (when `_ImportAccounts` doesn't exist yet): reads staging sheets `_ImportRegister`
   and `_ImportPlan` (the user pastes/imports the two YNAB CSV exports as sheets with those exact
   names) and writes `_ImportAccounts`, a review sheet where account type (`debit`/`credit`/
   `tracking`) is heuristically pre-filled — `credit` if the account name matches a
   `Credit Card Payments` category, `tracking` if it has zero categorized transactions, `debit`
   otherwise. The user is expected to review/correct this sheet by hand.
2. Second run: does the actual import, replacing `Accounts`, `Categories`, `Transactions`,
   `Budgets`, `Snapshots`, `Recurring` wholesale (`replaceAll_()`). It's idempotent — safe to
   re-run.

Non-obvious parts of the transform, worth knowing before touching this function:

- YNAB exports both legs of every transfer as separate rows; the importer pairs them up by
  `(account pair, date, |amount|)` and collapses them into one `transfer`-type row, preferring
  whichever leg carried a category (relevant for transfers into tracking accounts).
- Split transactions are rejoined via the `Split (n/m)` marker YNAB puts in the Memo field.
- `Payee` is deliberately dropped — in the real dataset it's almost entirely
  `Transfer : X` / `Starting Balance` / boilerplate, and `Memo` is the field users actually put
  content in.
- Ready to Assign has no column in the YNAB export, so the importer reconstructs it forward from
  transaction history and then shifts the whole series so the most recent imported month lands
  at exactly 0 (a budget "in good standing"). The size of that shift is reported to the user.

## Conventions used throughout `Codigo.gs`

- Private/helper functions end in `_` (e.g. `readSheet_`, `computeMonth_`) — anything without
  the trailing underscore is called from the frontend via `google.script.run` and must accept a
  single JSON-serializable payload and return a JSON-serializable value.
- Every mutating function wraps its body in `withLock_()` (a `LockService` script lock) and ends
  by returning `getState(payload.month)` — the frontend never applies an optimistic diff, it
  always re-renders from the full state the mutation returns.
- Sheet reads go through `readSheet_()`, which memoizes per-execution in the `_cache` object;
  call `delete _cache[name]` (or rely on `withLock_`, which resets it) after writing a sheet a
  mutation reads from, or stale data will be served within the same execution.
- Dates are stored and passed as `'YYYY-MM-DD'` strings throughout, never `Date` objects, to
  avoid timezone reinterpretation — see `todayStr_()`, `monthOf_()`, `addMonths_()`.
  Real Sheets auto-converts strings like `'2026-09'` into Date cells on `setValues()`, which
  silently breaks every `t.month === month` filter (Plan at $0, empty Spending). Two guards:
  `ensureSheets_()` sets the `DATE_FORMATS` columns to plain text, and `readSheet_()` converts
  any Date cell back to a string. Keep both; a local emulator won't reproduce this unless it
  mimics the conversion.
