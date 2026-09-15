/**
 * Budget — a YNAB-style envelope budgeting app on Google Apps Script + Sheets.
 *
 * Data model (one sheet per entity, see SCHEMA):
 *   Accounts      debit / credit / tracking
 *   Categories    grouped envelopes, plus one cc_payment envelope per credit card
 *   Budgets       how much was assigned to a category in a given month
 *   Transactions  SPLIT-LEVEL: one row per split line, grouped by txnId
 *   Snapshots     each category's available at the close of a month (locked = imported fact)
 *   Recurring     scheduled income / expense / transfer templates
 *   Config        key-value settings
 *
 * Money never lives in two places: balances and availables are always derived
 * from Transactions + Budgets, never stored as mutable truth.
 */

var SS = SpreadsheetApp.getActiveSpreadsheet();

var SCHEMA = {
  Accounts:     ['id', 'name', 'type', 'archived', 'note', 'createdAt'],
  Categories:   ['id', 'groupName', 'name', 'type', 'linkedAccountId', 'sortOrder', 'hidden'],
  Budgets:      ['month', 'categoryId', 'assigned'],
  Transactions: ['txnId', 'line', 'date', 'month', 'type', 'accountId', 'toAccountId',
                 'categoryId', 'amount', 'memo', 'cleared', 'recurringId', 'createdAt'],
  Snapshots:    ['month', 'categoryId', 'carryover', 'locked'],
  Recurring:    ['id', 'type', 'dayOfMonth', 'accountId', 'toAccountId', 'totalAmount',
                 'memo', 'splitsJson', 'active', 'lastRunMonth'],
  Config:       ['key', 'value']
};

var RTA = 'RTA';                       // pseudo-category id for Ready to Assign
var CC_GROUP = 'Credit Card Payments';
var DEFAULTS = { currency: '$', locale: 'en-US', schemaVersion: '2' };

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

function doGet() {
  ensureSheets_();
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Budget')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Budget')
    .addItem('Setup sheets', 'setup')
    .addItem('Import from YNAB', 'importFromYnab')
    .addItem('Install daily trigger', 'installTriggers')
    .addItem('Run scheduled transactions now', 'runScheduledTransactions')
    .addItem('Rebuild snapshots', 'rebuildSnapshotsMenu_')
    .addSeparator()
    .addItem('Run self test', 'selfTest')
    .addItem('Benchmark', 'benchmark')
    .addToUi();
}

function setup() {
  ensureSheets_();
  SpreadsheetApp.getUi().alert('Sheets ready. Next: import your YNAB CSVs, or start adding accounts in the app.');
}

// ---------------------------------------------------------------------------
// Sheet access layer
// ---------------------------------------------------------------------------

var _cache = {};   // per-execution memo; Apps Script gives each call a fresh instance

// Date-like columns, stored as plain text. Format is used when reading back a cell Sheets
// already converted to a Date.
var DATE_FORMATS = { month: 'yyyy-MM', lastRunMonth: 'yyyy-MM', date: 'yyyy-MM-dd',
                     createdAt: "yyyy-MM-dd'T'HH:mm:ss" };

function ensureSheets_() {
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = SS.getSheetByName(name);
    if (!sh) {
      sh = SS.insertSheet(name);
      sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    SCHEMA[name].forEach(function (col, c) {
      if (DATE_FORMATS[col]) sh.getRange(2, c + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    });
  });
  var cfg = readSheet_('Config');
  if (!cfg.length) {
    var rows = Object.keys(DEFAULTS).map(function (k) { return [k, DEFAULTS[k]]; });
    sheet_('Config').getRange(2, 1, rows.length, 2).setValues(rows);
    _cache = {};
  }
  var hasRta = readSheet_('Categories').some(function (c) { return c.id === RTA; });
  if (!hasRta) {
    appendRows_('Categories', [{ id: RTA, groupName: 'Inflow', name: 'Ready to Assign',
                                 type: 'rta', linkedAccountId: '', sortOrder: -1, hidden: false }]);
  }
}

function sheet_(name) {
  var sh = SS.getSheetByName(name);
  if (!sh) throw new Error('Missing sheet "' + name + '". Run Budget > Setup sheets.');
  return sh;
}

/** Reads a whole sheet as objects keyed by its header row. */
function readSheet_(name) {
  if (_cache[name]) return _cache[name];
  var sh = sheet_(name);
  var last = sh.getLastRow();
  var cols = SCHEMA[name];
  if (last < 2) { _cache[name] = []; return _cache[name]; }
  var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  var tz = SS.getSpreadsheetTimeZone();
  var out = values.map(function (row, i) {
    var o = { _row: i + 2 };
    for (var c = 0; c < cols.length; c++) {
      var v = row[c];
      // Sheets silently turns '2026-09' / '2026-09-12' into Date cells; the engine compares
      // these as strings, so convert them back or every month filter matches nothing.
      if (v instanceof Date) v = Utilities.formatDate(v, tz, DATE_FORMATS[cols[c]] || 'yyyy-MM-dd');
      o[cols[c]] = v;
    }
    return o;
  });
  _cache[name] = out;
  return out;
}

function appendRows_(name, objs) {
  if (!objs.length) return;
  var cols = SCHEMA[name];
  var rows = objs.map(function (o) {
    return cols.map(function (c) { return o[c] === undefined || o[c] === null ? '' : o[c]; });
  });
  var sh = sheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, cols.length).setValues(rows);
  delete _cache[name];
}

function replaceAll_(name, objs) {
  var sh = sheet_(name);
  var cols = SCHEMA[name];
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).clearContent();
  delete _cache[name];
  appendRows_(name, objs);
}

function deleteWhere_(name, pred) {
  var rows = readSheet_(name);
  var doomed = rows.filter(pred).map(function (r) { return r._row; })
                   .sort(function (a, b) { return b - a; });
  var sh = sheet_(name);
  doomed.forEach(function (r) { sh.deleteRow(r); });
  delete _cache[name];
  return doomed.length;
}

function uid_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }

function assign_(target) {
  for (var i = 1; i < arguments.length; i++) {
    var src = arguments[i];
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
  }
  return target;
}

// ---------------------------------------------------------------------------
// Dates. Stored as 'YYYY-MM-DD' strings so no timezone ever reinterprets them.
// ---------------------------------------------------------------------------

function monthOf_(dateStr) { return String(dateStr).slice(0, 7); }

function todayStr_() {
  return Utilities.formatDate(new Date(), SS.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

function addMonths_(month, n) {
  var y = +month.slice(0, 4), mth = +month.slice(5, 7) - 1 + n;
  y += Math.floor(mth / 12);
  mth = ((mth % 12) + 12) % 12;
  return y + '-' + ('0' + (mth + 1)).slice(-2);
}

function daysInMonth_(month) {
  return new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
}

function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function isTrue_(v) { return v === true || v === 'TRUE' || v === 'true'; }

// ---------------------------------------------------------------------------
// Compute engine — pure functions. No SpreadsheetApp here, so selfTest() can
// exercise them against in-memory fixtures.
// ---------------------------------------------------------------------------

/**
 * Account balances. `working` counts everything dated up to `today`, `cleared` only
 * reconciled rows. Rows dated after `today` (a scheduled paycheck YNAB exports) go to
 * `upcoming` instead, matching how YNAB shows the current balance. Without `today`,
 * every row counts.
 */
function computeBalances_(accounts, txns, today) {
  var bal = {};
  accounts.forEach(function (a) { bal[a.id] = { working: 0, cleared: 0, upcoming: 0 }; });
  function add(id, amt, clr, future) {
    if (!bal[id]) return;
    if (future) { bal[id].upcoming += amt; return; }
    bal[id].working += amt;
    if (clr) bal[id].cleared += amt;
  }
  txns.forEach(function (t) {
    var amt = Number(t.amount) || 0;
    var clr = isTrue_(t.cleared);
    var future = !!today && String(t.date) > today;
    add(t.accountId, amt, clr, future);
    if (t.type === 'transfer') add(t.toAccountId, -amt, clr, future);
  });
  Object.keys(bal).forEach(function (k) {
    bal[k].working = round2_(bal[k].working);
    bal[k].cleared = round2_(bal[k].cleared);
    bal[k].upcoming = round2_(bal[k].upcoming);
  });
  return bal;
}

/**
 * One month of the budget.
 *
 * Rules, in the order they matter:
 *  - activity(cat)  = sum of signed split amounts landing on that category
 *  - available(cat) = carryover + assigned + activity            (rollover)
 *  - a credit-card purchase moves its amount into the card's payment envelope,
 *    but only as far as the category can cover it: overspending is never
 *    silently budgeted for
 *  - negative available in a cash category does not roll; it comes out of next
 *    month's Ready to Assign. Negative in a payment envelope does roll — that
 *    is real uncovered debt.
 *
 * @param prev {carry: {catId: number}, rtaCarry: number}
 * @return {rows, carry, rtaCarry, readyToAssign, income, assignedTotal}
 */
function computeMonth_(month, prev, categories, budgets, txns, accounts) {
  var isCredit = {}, isTracking = {};
  accounts.forEach(function (a) {
    if (a.type === 'credit') isCredit[a.id] = true;
    if (a.type === 'tracking') isTracking[a.id] = true;
  });

  var payEnvOf = {};   // credit accountId -> its payment category id
  categories.forEach(function (c) {
    if (c.type === 'cc_payment' && c.linkedAccountId) payEnvOf[c.linkedAccountId] = c.id;
  });

  var assigned = {}, cash = {}, cred = {}, credByCard = {}, envActivity = {};
  var inflowRta = 0;    // drives Ready to Assign
  var inflowAll = 0;    // everything that came in, including income sent straight to a category

  budgets.forEach(function (b) {
    if (b.month === month) {
      assigned[b.categoryId] = round2_((assigned[b.categoryId] || 0) + Number(b.assigned));
    }
  });

  txns.forEach(function (t) {
    if (t.month !== month) return;
    var amt = Number(t.amount) || 0;
    var onCard = !!isCredit[t.accountId];

    if (t.type === 'transfer') {
      if (t.categoryId && t.categoryId !== RTA) {
        // A transfer that carries a category is money leaving (or entering) the
        // budget — typically buying into a tracking account. The on-budget side
        // owns the activity; its sign follows that side's direction.
        var fromIsBudget = !isTracking[t.accountId];
        var side = fromIsBudget ? t.accountId : t.toAccountId;
        var sideAmt = fromIsBudget ? amt : -amt;
        if (isCredit[side]) {
          cred[t.categoryId] = round2_((cred[t.categoryId] || 0) + sideAmt);
          var ck = t.categoryId + '|' + side;
          credByCard[ck] = round2_((credByCard[ck] || 0) + sideAmt);
        } else {
          cash[t.categoryId] = round2_((cash[t.categoryId] || 0) + sideAmt);
        }
        return;
      }
      // Otherwise a transfer only touches the budget when it settles a credit
      // card, and only when the money comes from a real cash account.
      // Card-to-card just moves debt around, so the envelope stays reserved.
      if (isCredit[t.toAccountId] && !onCard && !isTracking[t.accountId]) {
        var env = payEnvOf[t.toAccountId];
        if (env) envActivity[env] = round2_((envActivity[env] || 0) - Math.abs(amt));
      }
      return;
    }
    if (!t.categoryId || isTracking[t.accountId]) return;   // tracking accounts are off-budget
    if (t.type === 'income' && amt > 0) inflowAll = round2_(inflowAll + amt);
    if (t.categoryId === RTA) { inflowRta = round2_(inflowRta + amt); return; }

    if (onCard) {
      cred[t.categoryId] = round2_((cred[t.categoryId] || 0) + amt);
      var key = t.categoryId + '|' + t.accountId;
      credByCard[key] = round2_((credByCard[key] || 0) + amt);
    } else {
      cash[t.categoryId] = round2_((cash[t.categoryId] || 0) + amt);
    }
  });

  var carry = (prev && prev.carry) ? prev.carry : {};
  var rows = [], newCarry = {}, cashOverspend = 0, totalAssigned = 0;

  categories.forEach(function (c) {
    if (c.type === 'rta' || c.type === 'cc_payment') return;
    var ca = cash[c.id] || 0, cr = cred[c.id] || 0;
    var act = round2_(ca + cr);
    var asg = assigned[c.id] || 0;
    var avail = round2_((carry[c.id] || 0) + asg + act);
    totalAssigned = round2_(totalAssigned + asg);

    // How much of this month's credit spending the envelope can actually fund.
    var wants = round2_(-cr);
    if (wants > 0) {
      var covered = avail < 0 ? Math.max(0, round2_(wants + avail)) : wants;
      if (covered > 0) {
        Object.keys(credByCard).forEach(function (key) {
          var parts = key.split('|');
          if (parts[0] !== c.id) return;
          var env = payEnvOf[parts[1]];
          if (!env) return;
          var share = round2_(covered * (-credByCard[key]) / wants);
          envActivity[env] = round2_((envActivity[env] || 0) + share);
        });
      }
    }

    if (avail < 0) {
      // Only the part not attributable to credit spending is a cash hole.
      cashOverspend = round2_(cashOverspend +
                              Math.max(0, -round2_((carry[c.id] || 0) + asg + ca)));
      newCarry[c.id] = 0;
    } else {
      newCarry[c.id] = avail;
    }
    rows.push({ categoryId: c.id, assigned: asg, activity: act, available: avail });
  });

  categories.forEach(function (c) {
    if (c.type !== 'cc_payment') return;
    var act = round2_(envActivity[c.id] || 0);
    var asg = assigned[c.id] || 0;
    var avail = round2_((carry[c.id] || 0) + asg + act);
    totalAssigned = round2_(totalAssigned + asg);
    newCarry[c.id] = avail;          // uncovered debt keeps rolling
    rows.push({ categoryId: c.id, assigned: asg, activity: act, available: avail });
  });

  var rta = round2_(((prev && prev.rtaCarry) || 0) + inflowRta - totalAssigned);

  return {
    rows: rows,
    carry: newCarry,
    rtaCarry: round2_(rta - cashOverspend),
    readyToAssign: rta,
    income: inflowAll,
    assignedTotal: totalAssigned
  };
}

// ---------------------------------------------------------------------------
// Snapshots — each month's closing carryover. Rows marked `locked` came from
// the YNAB import and are treated as fact, so nothing before the import cutoff
// is ever recomputed.
// ---------------------------------------------------------------------------

function snapshotFor_(month) {
  var rows = readSheet_('Snapshots').filter(function (s) { return String(s.month) === month; });
  if (!rows.length) return null;
  var carry = {}, rtaCarry = 0;
  rows.forEach(function (s) {
    if (s.categoryId === '__RTA__') rtaCarry = Number(s.carryover) || 0;
    else carry[s.categoryId] = Number(s.carryover) || 0;
  });
  return { carry: carry, rtaCarry: rtaCarry };
}

function writeSnapshot_(month, state) {
  deleteWhere_('Snapshots', function (s) {
    return String(s.month) === month && !isTrue_(s.locked);
  });
  var rows = Object.keys(state.carry).map(function (cid) {
    return { month: month, categoryId: cid, carryover: state.carry[cid], locked: false };
  });
  rows.push({ month: month, categoryId: '__RTA__', carryover: state.rtaCarry, locked: false });
  appendRows_('Snapshots', rows);
}

function invalidateSnapshotsFrom_(month) {
  deleteWhere_('Snapshots', function (s) {
    return String(s.month) >= month && !isTrue_(s.locked);
  });
}

/**
 * Returns the carryover state entering `month`, computing and storing whatever
 * snapshots are missing. In normal use that is one or two months of work,
 * because everything up to the import cutoff is locked.
 */
function stateUpTo_(month) {
  var snap = snapshotFor_(addMonths_(month, -1));
  if (snap) return snap;

  var all = readSheet_('Snapshots');
  var known = all.map(function (s) { return String(s.month); })
                 .filter(function (m) { return m < month; })
                 .sort();
  var start = known.length ? addMonths_(known[known.length - 1], 1) : earliestMonth_();
  if (start >= month) return snapshotFor_(addMonths_(month, -1)) || { carry: {}, rtaCarry: 0 };

  var cats = readSheet_('Categories'), accounts = readSheet_('Accounts'),
      budgets = readSheet_('Budgets'), txns = readSheet_('Transactions');
  var prev = snapshotFor_(addMonths_(start, -1)) || { carry: {}, rtaCarry: 0 };

  for (var m = start; m < month; m = addMonths_(m, 1)) {
    var st = computeMonth_(m, prev, cats, budgets, txns, accounts);
    writeSnapshot_(m, st);
    prev = { carry: st.carry, rtaCarry: st.rtaCarry };
  }
  return prev;
}

function earliestMonth_() {
  var months = readSheet_('Transactions').map(function (t) { return String(t.month); })
                                         .filter(function (m) { return !!m; })
                                         .sort();
  return months.length ? months[0] : todayStr_().slice(0, 7);
}

function rebuildSnapshotsMenu_() {
  var n = deleteWhere_('Snapshots', function (s) { return !isTrue_(s.locked); });
  SpreadsheetApp.getUi().alert('Cleared ' + n + ' computed snapshots. They rebuild on next load.');
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

function getState(month) {
  ensureSheets_();
  month = month || todayStr_().slice(0, 7);

  var accounts = readSheet_('Accounts'),
      cats = readSheet_('Categories'),
      budgets = readSheet_('Budgets'),
      txns = readSheet_('Transactions');

  var prev = stateUpTo_(month);
  var mstate = computeMonth_(month, prev, cats, budgets, txns, accounts);
  var balances = computeBalances_(accounts, txns, todayStr_());

  var byCat = {};
  mstate.rows.forEach(function (r) { byCat[r.categoryId] = r; });

  var netWorth = 0;
  var accountsOut = accounts.map(function (a) {
    var b = balances[a.id] || { working: 0, cleared: 0, upcoming: 0 };
    if (!isTrue_(a.archived)) netWorth = round2_(netWorth + b.working);
    return { id: a.id, name: a.name, type: a.type, archived: isTrue_(a.archived),
             note: a.note, balance: b.working, cleared: b.cleared, upcoming: b.upcoming,
             paymentCategoryId: paymentEnvOf_(cats, a.id) };
  });

  return {
    month: month,
    today: todayStr_(),
    config: configMap_(),
    accounts: accountsOut,
    netWorth: netWorth,
    categories: cats.map(function (c) {
      var r = byCat[c.id] || { assigned: 0, activity: 0, available: 0 };
      return { id: c.id, groupName: c.groupName, name: c.name, type: c.type,
               linkedAccountId: c.linkedAccountId, sortOrder: Number(c.sortOrder) || 0,
               hidden: isTrue_(c.hidden),
               assigned: r.assigned, activity: r.activity, available: r.available };
    }),
    readyToAssign: mstate.readyToAssign,
    monthIncome: mstate.income,
    monthAssigned: mstate.assignedTotal,
    transactions: groupTxns_(txns.filter(function (t) { return t.month === month; })),
    recurring: readSheet_('Recurring').map(function (r) {
      return { id: r.id, type: r.type, dayOfMonth: Number(r.dayOfMonth), accountId: r.accountId,
               toAccountId: r.toAccountId, totalAmount: Number(r.totalAmount), memo: r.memo,
               splits: r.splitsJson ? JSON.parse(r.splitsJson) : [],
               active: isTrue_(r.active), lastRunMonth: String(r.lastRunMonth || '') };
    })
  };
}

function paymentEnvOf_(cats, accountId) {
  for (var i = 0; i < cats.length; i++) {
    if (cats[i].type === 'cc_payment' && cats[i].linkedAccountId === accountId) return cats[i].id;
  }
  return '';
}

function configMap_() {
  var out = {};
  readSheet_('Config').forEach(function (r) { out[r.key] = r.value; });
  return out;
}

/** Regroups split-level rows back into whole transactions, newest first. */
function groupTxns_(rows) {
  var byId = {}, order = [];
  rows.forEach(function (t) {
    if (!byId[t.txnId]) {
      byId[t.txnId] = { txnId: t.txnId, date: String(t.date).slice(0, 10), type: t.type,
                        accountId: t.accountId, toAccountId: t.toAccountId, memo: t.memo,
                        cleared: isTrue_(t.cleared), recurringId: t.recurringId,
                        amount: 0, splits: [] };
      order.push(t.txnId);
    }
    var g = byId[t.txnId];
    g.amount = round2_(g.amount + (Number(t.amount) || 0));
    if (t.categoryId) g.splits.push({ categoryId: t.categoryId, amount: round2_(t.amount) });
    if (!g.memo && t.memo) g.memo = t.memo;
  });
  return order.map(function (id) { return byId[id]; })
              .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
}

function getTransactions(opts) {
  ensureSheets_();
  opts = opts || {};
  var rows = readSheet_('Transactions');
  if (opts.month) rows = rows.filter(function (t) { return t.month === opts.month; });
  if (opts.accountId) rows = rows.filter(function (t) {
    return t.accountId === opts.accountId || t.toAccountId === opts.accountId;
  });
  if (opts.categoryId) rows = rows.filter(function (t) { return t.categoryId === opts.categoryId; });
  if (opts.search) {
    var q = String(opts.search).toLowerCase();
    var hits = {};
    rows.forEach(function (t) {
      if (String(t.memo).toLowerCase().indexOf(q) >= 0) hits[t.txnId] = true;
    });
    rows = rows.filter(function (t) { return hits[t.txnId]; });
  }
  var grouped = groupTxns_(rows);
  var offset = opts.offset || 0, limit = opts.limit || 100;
  return { total: grouped.length, items: grouped.slice(offset, offset + limit) };
}

function getReflect(month) {
  ensureSheets_();
  month = month || todayStr_().slice(0, 7);
  var st = getState(month);

  var spent = 0, budgeted = 0, byCategory = [];
  st.categories.forEach(function (c) {
    if (c.type !== 'normal') return;
    var out = c.activity < 0 ? -c.activity : 0;
    var pool = round2_(c.available + out);          // what was available to spend
    if (out > 0 || c.assigned !== 0 || c.available !== 0) {
      byCategory.push({ id: c.id, name: c.name, group: c.groupName, spent: out,
                        available: c.available, pool: pool,
                        pct: pool > 0 ? Math.round(out / pool * 100) : (out > 0 ? 100 : 0) });
    }
    spent = round2_(spent + out);
    // Only envelopes that saw spending count towards the headline percentage.
    // Long-term savings envelopes would otherwise swamp it and make every month
    // look like 2% no matter what happened.
    if (out > 0) budgeted = round2_(budgeted + pool);
  });
  byCategory.sort(function (a, b) { return b.spent - a.spent; });

  var debt = 0, assets = 0;
  st.accounts.forEach(function (a) {
    if (a.archived) return;
    if (a.type === 'credit') debt = round2_(debt + a.balance);
    else assets = round2_(assets + a.balance);
  });

  var txns = readSheet_('Transactions');
  var trend = [];
  for (var i = 5; i >= 0; i--) {
    var mm = addMonths_(month, -i), s = 0, inc = 0;
    txns.forEach(function (t) {
      if (t.month !== mm || !t.categoryId || t.type === 'transfer') return;
      var amt = Number(t.amount) || 0;
      if (t.categoryId === RTA) inc = round2_(inc + amt);
      else if (amt < 0) s = round2_(s - amt);
    });
    trend.push({ month: mm, spent: s, income: inc });
  }

  return {
    month: month, spent: spent, budgeted: budgeted,
    pct: budgeted > 0 ? Math.round(spent / budgeted * 100) : 0,
    income: st.monthIncome, readyToAssign: st.readyToAssign,
    debt: debt, assets: assets, netWorth: st.netWorth,
    byCategory: byCategory.slice(0, 40), top: byCategory.slice(0, 5), trend: trend
  };
}

// ---------------------------------------------------------------------------
// Write API. Every mutation takes the script lock, invalidates snapshots from
// the affected month forward, and hands back a fresh state so the UI never has
// to guess what happened.
// ---------------------------------------------------------------------------

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('The budget is busy, try again in a moment.');
  try {
    _cache = {};
    ensureSheets_();
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function createAccount(payload) {
  return withLock_(function () {
    var name = String(payload.name || '').trim();
    if (!name) throw new Error('Account needs a name.');
    if (['debit', 'credit', 'tracking'].indexOf(payload.type) < 0) throw new Error('Unknown account type.');
    var clash = readSheet_('Accounts').some(function (a) {
      return String(a.name).toLowerCase() === name.toLowerCase();
    });
    if (clash) throw new Error('An account called "' + name + '" already exists.');

    var id = uid_();
    appendRows_('Accounts', [{ id: id, name: name, type: payload.type, archived: false,
                               note: payload.note || '', createdAt: todayStr_() }]);

    if (payload.type === 'credit') {
      var cats = readSheet_('Categories');
      var maxSort = cats.reduce(function (m, c) { return Math.max(m, Number(c.sortOrder) || 0); }, 0);
      appendRows_('Categories', [{ id: uid_(), groupName: CC_GROUP, name: name, type: 'cc_payment',
                                   linkedAccountId: id, sortOrder: maxSort + 1, hidden: false }]);
    }

    var opening = round2_(payload.startingBalance || 0);
    if (opening !== 0) {
      var date = payload.startingDate || todayStr_();
      // For a budget account the opening cash is real money, so it lands in
      // Ready to Assign. A card's opening debt is not, and neither is tracking.
      writeTxnRows_([{ txnId: uid_(), line: 1, date: date, month: monthOf_(date),
                       type: 'adjustment', accountId: id, toAccountId: '',
                       categoryId: payload.type === 'debit' ? RTA : '',
                       amount: payload.type === 'credit' ? -Math.abs(opening) : opening,
                       memo: 'Starting balance', cleared: true, recurringId: '',
                       createdAt: todayStr_() }]);
      invalidateSnapshotsFrom_(monthOf_(date));
    }
    return getState(payload.month);
  });
}

function adjustAccountBalance(payload) {
  return withLock_(function () {
    var accounts = readSheet_('Accounts');
    var acct = accounts.filter(function (a) { return a.id === payload.accountId; })[0];
    if (!acct) throw new Error('Account not found.');
    var current = computeBalances_(accounts, readSheet_('Transactions'), todayStr_())[acct.id].working;
    var delta = round2_(payload.newBalance - current);
    if (delta === 0) return getState(payload.month);
    var date = payload.date || todayStr_();
    writeTxnRows_([{ txnId: uid_(), line: 1, date: date, month: monthOf_(date), type: 'adjustment',
                     accountId: acct.id, toAccountId: '',
                     categoryId: acct.type === 'debit' ? RTA : '', amount: delta,
                     memo: payload.memo || 'Balance adjustment', cleared: true,
                     recurringId: '', createdAt: todayStr_() }]);
    invalidateSnapshotsFrom_(monthOf_(date));
    return getState(payload.month);
  });
}

function archiveAccount(payload) {
  return withLock_(function () {
    var acct = readSheet_('Accounts').filter(function (a) { return a.id === payload.accountId; })[0];
    if (!acct) throw new Error('Account not found.');
    sheet_('Accounts').getRange(acct._row, SCHEMA.Accounts.indexOf('archived') + 1)
                      .setValue(!isTrue_(acct.archived));
    delete _cache.Accounts;
    return getState(payload.month);
  });
}

function deleteAccount(payload) {
  return withLock_(function () {
    var acct = readSheet_('Accounts').filter(function (a) { return a.id === payload.accountId; })[0];
    if (!acct) throw new Error('Account not found.');
    var used = readSheet_('Transactions').filter(function (t) {
      return t.accountId === acct.id || t.toAccountId === acct.id;
    });
    if (used.length && !payload.force) {
      throw new Error('CONFIRM:"' + acct.name + '" still has ' + used.length +
                      ' transaction lines. Deleting removes them permanently.');
    }
    var first = used.map(function (t) { return String(t.month); }).sort()[0];
    deleteWhere_('Transactions', function (t) {
      return t.accountId === acct.id || t.toAccountId === acct.id;
    });
    deleteWhere_('Recurring', function (r) {
      return r.accountId === acct.id || r.toAccountId === acct.id;
    });
    deleteWhere_('Categories', function (c) {
      return c.type === 'cc_payment' && c.linkedAccountId === acct.id;
    });
    sheet_('Accounts').deleteRow(acct._row);
    delete _cache.Accounts;
    invalidateSnapshotsFrom_(first || '0000-00');
    return getState(payload.month);
  });
}

function createCategory(payload) {
  return withLock_(function () {
    var name = String(payload.name || '').trim();
    var group = String(payload.groupName || '').trim();
    if (!name || !group) throw new Error('Category needs a name and a group.');
    if (group === CC_GROUP) throw new Error('Payment categories are created with their card.');
    var cats = readSheet_('Categories');
    var clash = cats.some(function (c) {
      return c.groupName === group && String(c.name).toLowerCase() === name.toLowerCase();
    });
    if (clash) throw new Error('That category already exists in "' + group + '".');
    var maxSort = cats.reduce(function (m, c) { return Math.max(m, Number(c.sortOrder) || 0); }, 0);
    appendRows_('Categories', [{ id: uid_(), groupName: group, name: name, type: 'normal',
                                 linkedAccountId: '', sortOrder: maxSort + 1, hidden: false }]);
    return getState(payload.month);
  });
}

function setCategoryHidden(payload) {
  return withLock_(function () {
    var c = readSheet_('Categories').filter(function (x) { return x.id === payload.categoryId; })[0];
    if (!c) throw new Error('Category not found.');
    sheet_('Categories').getRange(c._row, SCHEMA.Categories.indexOf('hidden') + 1)
                        .setValue(!!payload.hidden);
    delete _cache.Categories;
    return getState(payload.month);
  });
}

/** Stores which envelopes Home pins, as a JSON array of category ids in Config. */
function setPinnedCategories(payload) {
  return withLock_(function () {
    var value = JSON.stringify((payload.ids || []).map(String));
    var row = readSheet_('Config').filter(function (r) { return r.key === 'pinnedCategories'; })[0];
    if (row) sheet_('Config').getRange(row._row, 2).setValue(value);
    else appendRows_('Config', [{ key: 'pinnedCategories', value: value }]);
    delete _cache.Config;
    return getState(payload.month);
  });
}

function deleteCategory(payload) {
  return withLock_(function () {
    var c = readSheet_('Categories').filter(function (x) { return x.id === payload.categoryId; })[0];
    if (!c) throw new Error('Category not found.');
    if (c.type !== 'normal') throw new Error('Built-in categories cannot be deleted.');
    var used = readSheet_('Transactions').filter(function (t) { return t.categoryId === c.id; });
    if (used.length) {
      throw new Error('"' + c.name + '" is used by ' + used.length +
                      ' transaction lines. Hide it instead.');
    }
    deleteWhere_('Budgets', function (b) { return b.categoryId === c.id; });
    deleteWhere_('Snapshots', function (s) { return s.categoryId === c.id; });
    sheet_('Categories').deleteRow(c._row);
    delete _cache.Categories;
    return getState(payload.month);
  });
}

function setAssigned(payload) {
  return withLock_(function () {
    setAssigned_(payload.month, payload.categoryId, round2_(payload.amount));
    invalidateSnapshotsFrom_(payload.month);
    return getState(payload.month);
  });
}

function setAssigned_(month, categoryId, amount) {
  var existing = readSheet_('Budgets').filter(function (b) {
    return b.month === month && b.categoryId === categoryId;
  })[0];
  if (existing) {
    sheet_('Budgets').getRange(existing._row, SCHEMA.Budgets.indexOf('assigned') + 1).setValue(amount);
    delete _cache.Budgets;
  } else {
    appendRows_('Budgets', [{ month: month, categoryId: categoryId, assigned: amount }]);
  }
}

function assignedFor_(month, categoryId) {
  var b = readSheet_('Budgets').filter(function (x) {
    return x.month === month && x.categoryId === categoryId;
  })[0];
  return b ? Number(b.assigned) || 0 : 0;
}

/** Move budget between envelopes — the day-to-day "I overspent on fun" fix. */
function moveBudget(payload) {
  return withLock_(function () {
    var amt = round2_(payload.amount);
    if (amt <= 0) throw new Error('Enter an amount greater than zero.');
    if (payload.fromCategoryId === payload.toCategoryId) throw new Error('Pick two different categories.');
    setAssigned_(payload.month, payload.fromCategoryId,
                 round2_(assignedFor_(payload.month, payload.fromCategoryId) - amt));
    setAssigned_(payload.month, payload.toCategoryId,
                 round2_(assignedFor_(payload.month, payload.toCategoryId) + amt));
    invalidateSnapshotsFrom_(payload.month);
    return getState(payload.month);
  });
}

/** Applies a recurring income template's split plan as this month's assignments. */
function applyIncomePlan(payload) {
  return withLock_(function () {
    var rec = readSheet_('Recurring').filter(function (r) { return r.id === payload.recurringId; })[0];
    if (!rec) throw new Error('Income plan not found.');
    JSON.parse(rec.splitsJson || '[]').forEach(function (s) {
      if (!s.categoryId || s.categoryId === RTA) return;
      var base = payload.replace ? 0 : assignedFor_(payload.month, s.categoryId);
      setAssigned_(payload.month, s.categoryId, round2_(base + Math.abs(s.amount)));
    });
    invalidateSnapshotsFrom_(payload.month);
    return getState(payload.month);
  });
}

function writeTxnRows_(rows) {
  appendRows_('Transactions', rows);
  var sh = sheet_('Transactions');
  if (sh.getLastRow() > 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, SCHEMA.Transactions.length)
      .sort([{ column: SCHEMA.Transactions.indexOf('date') + 1, ascending: true },
             { column: SCHEMA.Transactions.indexOf('txnId') + 1, ascending: true },
             { column: SCHEMA.Transactions.indexOf('line') + 1, ascending: true }]);
  }
  delete _cache.Transactions;
}

/**
 * The one write path for expenses, income and transfers.
 * `splits` carry positive magnitudes; the sign comes from the type.
 */
function saveTransaction(payload) {
  return withLock_(function () {
    var rows = buildTxnRows_(payload);
    var months = [monthOf_(payload.date)];
    if (payload.txnId) {
      readSheet_('Transactions').forEach(function (t) {
        if (t.txnId === payload.txnId) months.push(String(t.month));
      });
      deleteWhere_('Transactions', function (t) { return t.txnId === payload.txnId; });
    }
    writeTxnRows_(rows);
    if (payload.repeat && payload.repeat.enabled) saveRecurringFrom_(payload);
    invalidateSnapshotsFrom_(months.sort()[0]);
    return getState(payload.month || monthOf_(payload.date));
  });
}

function buildTxnRows_(payload) {
  var date = String(payload.date || todayStr_()).slice(0, 10);
  var month = monthOf_(date);
  var txnId = payload.txnId || uid_();
  var created = todayStr_();
  var cleared = payload.cleared === undefined ? (date <= todayStr_()) : !!payload.cleared;
  var base = { txnId: txnId, date: date, month: month, type: payload.type,
               memo: payload.memo || '', cleared: cleared,
               recurringId: payload.recurringId || '', createdAt: created };

  if (payload.type === 'transfer') {
    var amt = round2_(Math.abs(payload.amount));
    if (!amt) throw new Error('Enter an amount.');
    if (!payload.accountId || !payload.toAccountId) throw new Error('Pick both accounts.');
    if (payload.accountId === payload.toAccountId) throw new Error('Pick two different accounts.');
    return [assign_({}, base, { line: 1, accountId: payload.accountId,
                                toAccountId: payload.toAccountId, categoryId: '', amount: -amt })];
  }

  var splits = (payload.splits || []).filter(function (s) { return round2_(s.amount) !== 0; });
  if (!splits.length) throw new Error('Enter at least one amount.');
  if (!payload.accountId) throw new Error('Pick an account.');
  var sign = payload.type === 'income' ? 1 : -1;

  return splits.map(function (s, i) {
    if (!s.categoryId) throw new Error('Every line needs a category.');
    return assign_({}, base, { line: i + 1, accountId: payload.accountId, toAccountId: '',
                               categoryId: s.categoryId,
                               amount: round2_(sign * Math.abs(s.amount)) });
  });
}

function deleteTransaction(payload) {
  return withLock_(function () {
    var months = [];
    readSheet_('Transactions').forEach(function (t) {
      if (t.txnId === payload.txnId) months.push(String(t.month));
    });
    if (!months.length) throw new Error('Transaction not found.');
    deleteWhere_('Transactions', function (t) { return t.txnId === payload.txnId; });
    invalidateSnapshotsFrom_(months.sort()[0]);
    return getState(payload.month);
  });
}

function setCleared(payload) {
  return withLock_(function () {
    var col = SCHEMA.Transactions.indexOf('cleared') + 1;
    var sh = sheet_('Transactions');
    readSheet_('Transactions').forEach(function (t) {
      if (t.txnId === payload.txnId) sh.getRange(t._row, col).setValue(!!payload.cleared);
    });
    delete _cache.Transactions;
    return getState(payload.month);
  });
}

// ---------------------------------------------------------------------------
// Recurring transactions
// ---------------------------------------------------------------------------

function saveRecurringFrom_(payload) {
  var day = Number(payload.repeat.dayOfMonth) || Number(String(payload.date).slice(8, 10));
  var splits = payload.type === 'transfer' ? [] :
    (payload.splits || []).map(function (s) {
      return { categoryId: s.categoryId, amount: round2_(Math.abs(s.amount)) };
    });
  var total = payload.type === 'transfer' ? round2_(Math.abs(payload.amount)) :
    splits.reduce(function (a, s) { return round2_(a + s.amount); }, 0);

  appendRows_('Recurring', [{
    id: uid_(), type: payload.type, dayOfMonth: Math.min(31, Math.max(1, day)),
    accountId: payload.accountId, toAccountId: payload.toAccountId || '',
    totalAmount: total, memo: payload.memo || '', splitsJson: JSON.stringify(splits),
    active: true, lastRunMonth: monthOf_(payload.date)
  }]);
}

function saveRecurring(payload) {
  return withLock_(function () {
    var existing = payload.id ?
      readSheet_('Recurring').filter(function (r) { return r.id === payload.id; })[0] : null;
    var splits = (payload.splits || []).map(function (s) {
      return { categoryId: s.categoryId, amount: round2_(Math.abs(s.amount)) };
    });
    var row = {
      id: payload.id || uid_(), type: payload.type,
      dayOfMonth: Math.min(31, Math.max(1, Number(payload.dayOfMonth) || 1)),
      accountId: payload.accountId, toAccountId: payload.toAccountId || '',
      totalAmount: payload.type === 'transfer' ? round2_(Math.abs(payload.amount)) :
        splits.reduce(function (a, s) { return round2_(a + s.amount); }, 0),
      memo: payload.memo || '', splitsJson: JSON.stringify(splits),
      active: payload.active === undefined ? true : !!payload.active,
      lastRunMonth: existing ? existing.lastRunMonth : ''
    };
    if (existing) {
      sheet_('Recurring').getRange(existing._row, 1, 1, SCHEMA.Recurring.length)
        .setValues([SCHEMA.Recurring.map(function (c) { return row[c]; })]);
      delete _cache.Recurring;
    } else {
      appendRows_('Recurring', [row]);
    }
    return getState(payload.month);
  });
}

function deleteRecurring(payload) {
  return withLock_(function () {
    deleteWhere_('Recurring', function (r) { return r.id === payload.id; });
    return getState(payload.month);
  });
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runScheduledTransactions') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runScheduledTransactions').timeBased().atHour(3).everyDays(1).create();
  try {
    SpreadsheetApp.getUi().alert('Daily trigger installed. Scheduled transactions post each night.');
  } catch (e) { /* running headless */ }
}

/**
 * Posts any scheduled transaction whose day has arrived this month.
 * A rule set to day 30 fires on the 28th in February — clamped, never skipped.
 * `lastRunMonth` makes it safe to run twice and lets it catch up after a
 * missed trigger day.
 */
function runScheduledTransactions() {
  return withLock_(function () {
    var today = todayStr_();
    var month = today.slice(0, 7);
    var dayNow = +today.slice(8, 10);
    var lastDay = daysInMonth_(month);
    var posted = [];

    readSheet_('Recurring').forEach(function (r) {
      if (!isTrue_(r.active)) return;
      // `>=` not `===`: a rule already posted for this month or a later one
      // (an import can carry a future-dated paycheck) must not fire again.
      if (String(r.lastRunMonth) >= month) return;
      var due = Math.min(Number(r.dayOfMonth) || 1, lastDay);
      if (dayNow < due) return;

      var date = month + '-' + ('0' + due).slice(-2);
      var splits = JSON.parse(r.splitsJson || '[]');
      writeTxnRows_(buildTxnRows_({
        type: r.type, date: date, accountId: r.accountId, toAccountId: r.toAccountId,
        amount: Number(r.totalAmount), memo: r.memo, splits: splits,
        recurringId: r.id, cleared: false
      }));

      if (r.type === 'income') {
        splits.forEach(function (s) {
          if (!s.categoryId || s.categoryId === RTA) return;
          setAssigned_(month, s.categoryId,
                       round2_(assignedFor_(month, s.categoryId) + Math.abs(s.amount)));
        });
      }
      sheet_('Recurring').getRange(r._row, SCHEMA.Recurring.indexOf('lastRunMonth') + 1)
                         .setValue(month);
      delete _cache.Recurring;
      posted.push(r.memo || r.type);
    });

    if (posted.length) invalidateSnapshotsFrom_(month);
    Logger.log('Scheduled transactions posted: ' + (posted.join(', ') || 'none'));
    return posted;
  });
}

// ---------------------------------------------------------------------------
// YNAB import
// ---------------------------------------------------------------------------

var IMPORT_REGISTER = '_ImportRegister';
var IMPORT_PLAN = '_ImportPlan';
var IMPORT_ACCOUNTS = '_ImportAccounts';

function importFromYnab() {
  var ui = SpreadsheetApp.getUi();
  ensureSheets_();
  var reg = SS.getSheetByName(IMPORT_REGISTER), plan = SS.getSheetByName(IMPORT_PLAN);
  if (!reg || !plan) {
    ui.alert('Import the two YNAB CSVs first as sheets named exactly "' + IMPORT_REGISTER +
             '" and "' + IMPORT_PLAN + '" (File > Import > Insert new sheet).');
    return;
  }

  var register = csvSheetToObjects_(reg);
  var planRows = csvSheetToObjects_(plan);

  if (!SS.getSheetByName(IMPORT_ACCOUNTS)) {
    buildAccountMap_(register, planRows);
    ui.alert('Created "' + IMPORT_ACCOUNTS + '". Review each account type ' +
             '(debit / credit / tracking), fix anything wrong, then run Import again.');
    return;
  }

  var resp = ui.alert('This replaces all accounts, categories, transactions, budgets and ' +
                      'snapshots with the YNAB export. Continue?', ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  ui.alert(runImport_(register, planRows, csvSheetToObjects_(SS.getSheetByName(IMPORT_ACCOUNTS))));
}

function csvSheetToObjects_(sh) {
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0].map(function (h) { return String(h).replace(/^﻿/, '').trim(); });
  return values.slice(1).map(function (row) {
    var o = {};
    for (var i = 0; i < head.length; i++) o[head[i]] = row[i];
    return o;
  });
}

function buildAccountMap_(register, planRows) {
  var ccNames = {};
  planRows.forEach(function (r) {
    if (String(r['Category Group']).trim() === CC_GROUP) ccNames[String(r['Category']).trim()] = true;
  });
  // An on-budget account is exactly one that has at least one categorized row —
  // a tracking account cannot have any, by construction.
  var stats = {};
  register.forEach(function (r) {
    var n = String(r['Account']).trim();
    if (!n) return;
    if (!stats[n]) stats[n] = { total: 0, categorized: 0 };
    stats[n].total++;
    if (String(r['Category Group/Category']).trim()) stats[n].categorized++;
  });

  var sh = SS.insertSheet(IMPORT_ACCOUNTS);
  sh.getRange(1, 1, 1, 4).setValues([['name', 'type', 'rows', 'why']]).setFontWeight('bold');
  var rows = Object.keys(stats).sort().map(function (n) {
    var type = ccNames[n] ? 'credit' : (stats[n].categorized === 0 ? 'tracking' : 'debit');
    return [n, type, stats[n].total,
            ccNames[n] ? 'has a Credit Card Payments category' :
            (type === 'tracking' ? 'no categorized transactions' :
             stats[n].categorized + ' categorized rows')];
  });
  sh.getRange(2, 1, rows.length, 4).setValues(rows);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, 4);
}

function ynabMoney_(v) {
  if (typeof v === 'number') return round2_(v);
  var s = String(v || '').replace(/[$,\s]/g, '');
  if (!s) return 0;
  var neg = /^\(.*\)$/.test(s);
  return round2_((neg ? -1 : 1) * (parseFloat(s.replace(/[()]/g, '')) || 0));
}

function ynabDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, SS.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  var s = String(v).trim();
  var mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return mdy[3] + '-' + ('0' + mdy[1]).slice(-2) + '-' + ('0' + mdy[2]).slice(-2);
  return s.slice(0, 10);
}

var MONTH_NAMES = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
                    Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function ynabMonth_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, SS.getSpreadsheetTimeZone(), 'yyyy-MM');
  var s = String(v).trim();
  var m = s.match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (m && MONTH_NAMES[m[1]]) return m[2] + '-' + ('0' + MONTH_NAMES[m[1]]).slice(-2);
  return s.slice(0, 7);
}

function runImport_(register, planRows, accountMap) {
  var log = [];

  // --- accounts ------------------------------------------------------------
  var accounts = [], accIdByName = {};
  accountMap.forEach(function (m) {
    var name = String(m.name).trim();
    if (!name) return;
    var t = String(m.type).trim();
    var type = ['debit', 'credit', 'tracking'].indexOf(t) >= 0 ? t : 'debit';
    var id = uid_();
    accIdByName[name] = id;
    accounts.push({ id: id, name: name, type: type, archived: false, note: '',
                    createdAt: todayStr_() });
  });
  replaceAll_('Accounts', accounts);

  // --- categories, in the order YNAB lists them ----------------------------
  var cats = [{ id: RTA, groupName: 'Inflow', name: 'Ready to Assign', type: 'rta',
                linkedAccountId: '', sortOrder: -1, hidden: false }];
  var catIdByFull = { 'Inflow: Ready to Assign': RTA };
  var order = 0;
  planRows.forEach(function (r) {
    var full = String(r['Category Group/Category']).trim();
    if (!full || catIdByFull[full]) return;
    var group = String(r['Category Group']).trim(), name = String(r['Category']).trim();
    var id = uid_();
    catIdByFull[full] = id;
    var isCC = group === CC_GROUP;
    cats.push({ id: id, groupName: group, name: name, type: isCC ? 'cc_payment' : 'normal',
                linkedAccountId: isCC ? (accIdByName[name] || '') : '',
                sortOrder: order++, hidden: false });
  });
  replaceAll_('Categories', cats);

  // --- transactions --------------------------------------------------------
  var txns = [], skippedTransfer = 0, unknownAcct = {};
  var transferPairs = {}, pairOrder = [], groupKey = {}, lineNo = {};

  register.forEach(function (r) {
    var acctName = String(r['Account']).trim();
    var acctId = accIdByName[acctName];
    if (!acctId) { if (acctName) unknownAcct[acctName] = true; return; }

    var date = ynabDate_(r['Date']);
    var payee = String(r['Payee'] || '').trim();
    var memo = String(r['Memo'] || '').trim();
    var amount = round2_(ynabMoney_(r['Inflow']) - ynabMoney_(r['Outflow']));
    var full = String(r['Category Group/Category']).trim();
    var cleared = String(r['Cleared']).trim() === 'Cleared';

    if (payee.indexOf('Transfer') === 0) {
      // Both legs are exported. Collect them and reconcile afterwards, because
      // only one leg carries the category when the transfer moves money in or
      // out of a tracking account — dropping the wrong leg loses that.
      var otherName = payee.split(':')[1] ? payee.split(':')[1].trim() : '';
      if (!accIdByName[otherName]) { if (otherName) unknownAcct[otherName] = true; return; }
      var pair = [acctName, otherName].sort().join('||') + '|' + date + '|' +
                 Math.abs(amount).toFixed(2);
      if (!transferPairs[pair]) { transferPairs[pair] = []; pairOrder.push(pair); }
      transferPairs[pair].push({ acctId: acctId, otherId: accIdByName[otherName], date: date,
                                 amount: amount, memo: memo, cleared: cleared,
                                 categoryId: catIdByFull[full] || '' });
      return;
    }

    var type = (payee === 'Starting Balance' || payee === 'Manual Balance Adjustment') ? 'adjustment'
             : (amount >= 0 ? 'income' : 'expense');

    // Rejoin split lines: YNAB tags them "Split (n/m)" and keeps them adjacent.
    var split = memo.match(/^Split\s*\((\d+)\/(\d+)\)/);
    var key = acctId + '|' + date + '|' + payee;
    var id;
    if (split) {
      if (+split[1] === 1 || !groupKey[key]) { groupKey[key] = uid_(); lineNo[key] = 0; }
      id = groupKey[key];
      lineNo[key]++;
    } else {
      id = uid_();
      lineNo[key] = 1;
    }

    txns.push({ txnId: id, line: split ? lineNo[key] : 1, date: date, month: monthOf_(date),
                type: type, accountId: acctId, toAccountId: '',
                categoryId: catIdByFull[full] || '', amount: amount,
                memo: memo.replace(/^Split\s*\(\d+\/\d+\)\s*/, ''), cleared: cleared,
                recurringId: '', createdAt: todayStr_() });
  });

  // Emit one transaction per transfer, pairing each outflow leg with its
  // matching inflow leg and keeping whichever leg carried a category.
  pairOrder.forEach(function (pair) {
    var legs = transferPairs[pair];
    var outs = legs.filter(function (l) { return l.amount < 0; });
    var ins = legs.filter(function (l) { return l.amount > 0; });
    // A zero-amount transfer has no sign to tell its legs apart, so pair them
    // off directly rather than letting both land on the same side.
    var zeros = legs.filter(function (l) { return l.amount === 0; });
    while (zeros.length >= 2) { outs.push(zeros.pop()); ins.push(zeros.pop()); }
    var n = Math.min(outs.length, ins.length);
    skippedTransfer += legs.length - n;
    for (var i = 0; i < n; i++) {
      var o = outs[i], inn = ins[i];
      txns.push({ txnId: uid_(), line: 1, date: o.date, month: monthOf_(o.date), type: 'transfer',
                  accountId: o.acctId, toAccountId: inn.acctId,
                  categoryId: o.categoryId || inn.categoryId,
                  amount: -Math.abs(o.amount), memo: o.memo || inn.memo,
                  cleared: o.cleared && inn.cleared, recurringId: '', createdAt: todayStr_() });
    }
    // A leg whose mirror is missing from the export still moved real money.
    var extra = outs.slice(n).concat(ins.slice(n)).concat(zeros);
    extra.forEach(function (l) {
      skippedTransfer--;
      txns.push({ txnId: uid_(), line: 1, date: l.date, month: monthOf_(l.date), type: 'transfer',
                  accountId: l.amount < 0 ? l.acctId : l.otherId,
                  toAccountId: l.amount < 0 ? l.otherId : l.acctId,
                  categoryId: l.categoryId, amount: -Math.abs(l.amount),
                  memo: l.memo, cleared: l.cleared, recurringId: '', createdAt: todayStr_() });
    });
  });

  txns.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.txnId !== b.txnId) return a.txnId < b.txnId ? -1 : 1;
    return a.line - b.line;
  });
  replaceAll_('Transactions', txns);

  // --- sanity-check the dates we just imported ------------------------------
  // A wrong Spreadsheet locale makes Google Sheets read the Register's
  // MM/DD/YYYY dates as DD/MM without ever raising an error — it just scrambles
  // which month every transaction lands in. That doesn't change how many rows
  // get imported (the counts above still look right), so the only way to catch
  // it is to cross-check against a source that's independent of anything this
  // importer derived: YNAB's own Activity column, per (month, category).
  var directActivity = {};
  txns.forEach(function (t) {
    if (!t.categoryId || t.categoryId === RTA) return;
    var key = t.month + '|' + t.categoryId;
    directActivity[key] = round2_((directActivity[key] || 0) + Number(t.amount));
  });
  var dateCheckTotal = 0, dateCheckBad = 0;
  planRows.forEach(function (r) {
    var cid = catIdByFull[String(r['Category Group/Category']).trim()];
    // Credit Card Payments categories have a known, documented divergence from
    // YNAB (see INSTALACION.md) that is unrelated to dates — exclude them here
    // so they don't mask or fake a locale problem.
    if (!cid || String(r['Category Group']).trim() === CC_GROUP) return;
    var mth = ynabMonth_(r['Month']);
    var expected = ynabMoney_(r['Activity']);
    var got = round2_(directActivity[mth + '|' + cid] || 0);
    dateCheckTotal++;
    if (Math.abs(expected - got) > 0.005) dateCheckBad++;
  });
  var dateCheckRate = dateCheckTotal ? dateCheckBad / dateCheckTotal : 0;

  // --- budgets, and the closing snapshot as imported fact ------------------
  // YNAB's own Available column is locked in as the opening carryover, so the
  // app's state matches the export exactly on day one and our engine only ever
  // computes forward from there.
  var budgets = [], available = {}, months = {};
  planRows.forEach(function (r) {
    var cid = catIdByFull[String(r['Category Group/Category']).trim()];
    if (!cid) return;
    var mth = ynabMonth_(r['Month']);
    months[mth] = true;
    var asg = ynabMoney_(r['Assigned']);
    if (asg !== 0) budgets.push({ month: mth, categoryId: cid, assigned: asg });
    available[mth + '|' + cid] = ynabMoney_(r['Available']);
  });
  replaceAll_('Budgets', budgets);

  // Every historical month gets a locked carryover taken straight from YNAB's
  // Available column, so the app opens showing exactly what YNAB showed and the
  // engine only ever computes forward from the last imported month. Ready to
  // Assign is not in the export, so that one number we do compute — feeding
  // YNAB's carryover back in each month keeps the two from drifting apart.
  var monthList = Object.keys(months).sort();
  var lastMonth = monthList[monthList.length - 1];
  var snaps = [], prevState = { carry: {}, rtaCarry: 0 }, lastReadyToAssign = 0;
  var allCats = readSheet_('Categories'), allAccts = readSheet_('Accounts'),
      allTxns = readSheet_('Transactions');

  monthList.forEach(function (mth) {
    var st = computeMonth_(mth, prevState, allCats, budgets, allTxns, allAccts);
    var carry = {};
    cats.forEach(function (c) {
      if (c.type === 'rta') return;
      var v = available[mth + '|' + c.id];
      carry[c.id] = v === undefined ? (st.carry[c.id] || 0) : v;
      snaps.push({ month: mth, categoryId: c.id, carryover: carry[c.id], locked: true });
    });
    snaps.push({ month: mth, categoryId: '__RTA__', carryover: st.rtaCarry, locked: true });
    lastReadyToAssign = st.readyToAssign;
    prevState = { carry: carry, rtaCarry: st.rtaCarry };
  });

  // Six years of reconstruction leave a small residue in Ready to Assign, and
  // the export has no column to check it against. A YNAB budget in good standing
  // sits at zero, so shift the whole series to land there and let the report say
  // by how much. Category availables are untouched: those come from the export.
  var rtaShift = round2_(-lastReadyToAssign);
  if (rtaShift !== 0) {
    snaps.forEach(function (s) {
      if (s.categoryId === '__RTA__') s.carryover = round2_(s.carryover + rtaShift);
    });
  }
  replaceAll_('Snapshots', snaps);

  // --- seed the recurring income plan from the newest future paycheck ------
  var recurring = [];
  var future = txns.filter(function (t) { return t.type === 'income' && t.date > todayStr_(); });
  if (future.length) {
    var newest = future[future.length - 1].txnId;
    var lines = future.filter(function (t) { return t.txnId === newest; });
    recurring.push({
      id: uid_(), type: 'income', dayOfMonth: +lines[0].date.slice(8, 10),
      accountId: lines[0].accountId, toAccountId: '',
      totalAmount: lines.reduce(function (a, t) { return round2_(a + t.amount); }, 0),
      memo: lines[0].memo || 'Monthly income',
      splitsJson: JSON.stringify(lines.map(function (t) {
        return { categoryId: t.categoryId, amount: round2_(Math.abs(t.amount)) };
      })),
      active: true, lastRunMonth: monthOf_(lines[0].date)
    });
  }
  replaceAll_('Recurring', recurring);

  // --- report --------------------------------------------------------------
  log.push('Imported ' + accounts.length + ' accounts, ' + (cats.length - 1) + ' categories, ' +
           txns.length + ' transaction lines, ' + budgets.length + ' budget entries.');
  log.push('Dropped ' + skippedTransfer + ' duplicate transfer legs.');
  log.push('Locked ' + snaps.length + ' carryover rows through ' + lastMonth +
           ' — YNAB is the source of truth for everything up to that month.');
  log.push('Ready to Assign starts at 0 (the export does not include it; the ' +
           'reconstruction was off by ' + Math.abs(rtaShift).toFixed(2) + ').');
  if (Object.keys(unknownAcct).length) {
    log.push('WARNING unmapped accounts: ' + Object.keys(unknownAcct).join(', '));
  }
  if (dateCheckRate > 0.02) {
    log.push('\n⚠️ WARNING: ' + dateCheckBad + ' of ' + dateCheckTotal + ' (month, category) ' +
             'activity totals (' + Math.round(dateCheckRate * 100) + '%) don\'t match the Activity ' +
             'column in your YNAB Plan export. This almost always means Google Sheets read the ' +
             'Register\'s dates as day/month instead of YNAB\'s month/day — check your Spreadsheet\'s ' +
             'locale. Fix: delete _ImportRegister and _ImportPlan, re-import both CSVs with ' +
             '"Convert text to numbers, dates, and formulas" UNCHECKED, then run Import from YNAB again.');
  }

  _cache = {};
  var bal = computeBalances_(readSheet_('Accounts'), readSheet_('Transactions'), todayStr_());
  log.push('\nAccount balances as of today — compare these against YNAB:');
  readSheet_('Accounts').forEach(function (a) {
    log.push('  ' + a.name + ': ' + bal[a.id].working.toFixed(2) +
             (bal[a.id].upcoming ? '  (+ ' + bal[a.id].upcoming.toFixed(2) + ' scheduled)' : ''));
  });

  var msg = log.join('\n');
  Logger.log(msg);
  return msg;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function benchmark() {
  var t0 = new Date().getTime();
  _cache = {};
  getState();
  var t1 = new Date().getTime();
  var n = readSheet_('Transactions').length;
  _cache = {};
  getReflect();
  var t2 = new Date().getTime();
  var msg = 'getState: ' + (t1 - t0) + ' ms over ' + n + ' transaction lines\n' +
            'getReflect: ' + (t2 - t1) + ' ms';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return msg;
}

/** Exercises the compute engine against in-memory fixtures. Run from the editor. */
function selfTest() {
  var out = [], pass = 0, fail = 0;
  function eq(label, got, want) {
    var ok = Math.abs(round2_(got) - round2_(want)) < 0.005;
    out.push((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + round2_(got) + ' want=' + want);
    if (ok) pass++; else fail++;
  }

  var accounts = [
    { id: 'cash', name: 'Efectivo', type: 'debit' },
    { id: 'card', name: 'Card', type: 'credit' },
    { id: 'inv', name: 'Investments', type: 'tracking' }
  ];
  var cats = [
    { id: RTA, name: 'Ready to Assign', type: 'rta' },
    { id: 'trans', name: 'Transportation', type: 'normal' },
    { id: 'fun', name: 'Fun', type: 'normal' },
    { id: 'paycard', name: 'Card', type: 'cc_payment', linkedAccountId: 'card' }
  ];
  var seq = 0;
  function tx(o) {
    return assign_({ txnId: 't' + (++seq), line: 1, month: monthOf_(o.date), toAccountId: '',
                     categoryId: '', memo: '', cleared: true }, o);
  }
  function index(m) {
    var by = {};
    m.rows.forEach(function (r) { by[r.categoryId] = r; });
    return by;
  }

  // 1. The core requirement: a card purchase spends the envelope AND reserves
  //    the same money to pay the card.
  var budgets = [{ month: '2026-01', categoryId: 'trans', assigned: 100 }];
  var txns = [tx({ date: '2026-01-05', type: 'expense', accountId: 'card',
                   categoryId: 'trans', amount: -20 })];
  var by = index(computeMonth_('2026-01', null, cats, budgets, txns, accounts));
  eq('transportation available after $20 on card', by.trans.available, 80);
  eq('card payment envelope funded', by.paycard.available, 20);
  eq('card balance is debt', computeBalances_(accounts, txns).card.working, -20);

  // 2. Paying the card releases the envelope and clears the debt.
  txns.push(tx({ date: '2026-01-20', type: 'transfer', accountId: 'cash',
                 toAccountId: 'card', amount: -20 }));
  var jan = computeMonth_('2026-01', null, cats, budgets, txns, accounts);
  by = index(jan);
  eq('payment envelope emptied by the payment', by.paycard.available, 0);
  var bal = computeBalances_(accounts, txns);
  eq('card back to zero', bal.card.working, 0);
  eq('cash paid for it', bal.cash.working, -20);

  // 3. Rollover: an untouched envelope carries into the next month.
  by = index(computeMonth_('2026-02', { carry: jan.carry, rtaCarry: jan.rtaCarry },
                           cats, budgets, txns, accounts));
  eq('february starts with january leftovers', by.trans.available, 80);

  // 4. Cash overspending does not roll; it comes out of next month's RTA.
  var b4 = [{ month: '2026-01', categoryId: 'fun', assigned: 50 }];
  var t4 = [tx({ date: '2026-01-03', type: 'income', accountId: 'cash', categoryId: RTA, amount: 50 }),
            tx({ date: '2026-01-10', type: 'expense', accountId: 'cash', categoryId: 'fun', amount: -70 })];
  var j4 = computeMonth_('2026-01', null, cats, b4, t4, accounts);
  eq('overspent envelope shows negative', index(j4).fun.available, -20);
  var f4 = computeMonth_('2026-02', { carry: j4.carry, rtaCarry: j4.rtaCarry },
                         cats, b4, t4, accounts);
  eq('overspending does not roll over', index(f4).fun.available, 0);
  eq('it hits next month ready to assign', f4.readyToAssign, -20);

  // 5. Overspending on a card is not silently budgeted for payment.
  var b5 = [{ month: '2026-01', categoryId: 'fun', assigned: 30 }];
  var t5 = [tx({ date: '2026-01-10', type: 'expense', accountId: 'card', categoryId: 'fun', amount: -50 })];
  by = index(computeMonth_('2026-01', null, cats, b5, t5, accounts));
  eq('only the covered part is reserved', by.paycard.available, 30);
  eq('the rest shows as overspending', by.fun.available, -20);

  // 6. Tracking accounts stay out of the budget entirely.
  var t6 = [tx({ date: '2026-01-10', type: 'expense', accountId: 'inv', categoryId: 'fun', amount: -500 })];
  by = index(computeMonth_('2026-01', null, cats, [], t6, accounts));
  eq('tracking spending ignored by the budget', by.fun.available, 0);
  eq('but it moves net worth', computeBalances_(accounts, t6).inv.working, -500);

  // A future-dated paycheck is scheduled, not money in the account yet.
  var t6b = [{ accountId: 'cash', type: 'income', amount: 3800, date: '2026-02-03', cleared: false }];
  var b6b = computeBalances_(accounts, t6b, '2026-01-15');
  eq('future income does not count toward the balance', b6b.cash.working, 0);
  eq('it shows as upcoming instead', b6b.cash.upcoming, 3800);
  eq('once its date arrives it counts', computeBalances_(accounts, t6b, '2026-02-03').cash.working, 3800);

  // 7. Income lands in Ready to Assign, assignments draw it down.
  var t7 = [tx({ date: '2026-01-01', type: 'income', accountId: 'cash', categoryId: RTA, amount: 3000 })];
  var b7 = [{ month: '2026-01', categoryId: 'trans', assigned: 100 },
            { month: '2026-01', categoryId: 'fun', assigned: 400 }];
  eq('ready to assign after budgeting',
     computeMonth_('2026-01', null, cats, b7, t7, accounts).readyToAssign, 2500);

  // 8. A day-30 rule survives February.
  eq('february clamps day 30', Math.min(30, daysInMonth_('2026-02')), 28);
  eq('january keeps day 30', Math.min(30, daysInMonth_('2026-01')), 30);

  var msg = out.join('\n') + '\n\n' + pass + ' passed, ' + fail + ' failed.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return msg;
}
