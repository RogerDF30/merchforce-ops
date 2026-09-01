/**
 * Merchforce Ops — analytics.
 *
 * The storefront funnel (views, searches, conversion from browsing) died with
 * the storefront: nothing writes those events any more. Everything here is
 * derived from orders and stock movement instead.
 *
 * Stock signals are RULES BASED, not predictive. Consumption is measured from
 * StockLog, not forecast. Forecasting needs a season of dispatch history; when
 * that exists it belongs beside these numbers, not instead of them.
 *
 * One call returns everything for a window: {days: 30|90|180|365}.
 */

var DAY_MS = 24 * 60 * 60 * 1000;

/** Stages an order passes through while it is still live work. */
var OPEN_STAGES = ['New', 'Accepted', 'PI Sent', 'PI Accepted', 'PO Received', 'In Production', 'Dispatched'];
/** Days a stage may sit before it is flagged as ageing. */
var STAGE_SLA = {
  'New': 2, 'Accepted': 3, 'PI Sent': 5, 'PI Accepted': 3,
  'PO Received': 7, 'In Production': 21, 'Dispatched': 10
};

function fnAdminAnalytics_(p) {
  var days = toNum_(p.days) || 90;
  if ([30, 90, 180, 365].indexOf(days) < 0) days = 90;
  var nowMs = now_().getTime();
  var cutoff = nowMs - days * DAY_MS;

  var products = readRows_('Products');
  var prod = {}, names = {}, catalogueSize = 0;
  products.forEach(function (r) {
    var k = skuKey_(r.sku);
    prod[k] = r; names[k] = r.name;
    if (isTrue_(r.visible)) catalogueSize++;
  });

  var requests = readRows_('Requests');
  var lines = readRows_('RequestLines');
  var inWin = requests.filter(function (r) { return new Date(r.created).getTime() >= cutoff; });

  return ok_({
    generated_at: Utilities.formatDate(now_(), 'Asia/Kolkata', 'd MMM yyyy, h:mm a'),
    days: days,
    basis: 'orders and stock movement',
    requests: requestStats_(inWin),
    trend: weeklyTrend_(inWin),
    pipeline: pipeline_(requests, nowMs),
    decision: decisionStats_(inWin, nowMs),
    products: productStats_(requests, lines, prod, names, cutoff, catalogueSize),
    customers: customerStats_(inWin),
    stock: stockSignals_(products, lines, requests, cutoff, days, nowMs)
  });
}

/* ---------------- requests ---------------- */

function requestStats_(inWin) {
  var byStatus = {}, value = 0;
  inWin.forEach(function (r) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    value += toNum_(r.total_est);
  });
  return {
    count: inWin.length,
    value: Math.round(value),
    average: inWin.length ? Math.round(value / inWin.length) : 0,
    by_status: byStatus
  };
}

function weeklyTrend_(inWin) {
  var weeks = {};
  inWin.forEach(function (r) {
    var d = new Date(r.created);
    var monday = new Date(d.getTime() - ((d.getDay() + 6) % 7) * DAY_MS);
    var key = Utilities.formatDate(monday, 'Asia/Kolkata', 'yyyy-MM-dd');
    weeks[key] = weeks[key] || { requests: 0, value: 0 };
    weeks[key].requests++;
    weeks[key].value += toNum_(r.total_est);
  });
  return Object.keys(weeks).sort().map(function (k) {
    return {
      week: Utilities.formatDate(new Date(k), 'Asia/Kolkata', 'd MMM'),
      requests: weeks[k].requests, value: Math.round(weeks[k].value)
    };
  });
}

/* ---------------- pipeline: what is open, and how long it has sat ---------- */

function pipeline_(requests, nowMs) {
  var stages = {}, ageing = [], openValue = 0, openCount = 0;
  OPEN_STAGES.forEach(function (s) { stages[s] = { count: 0, value: 0, ageing: 0 }; });

  requests.forEach(function (r) {
    if (OPEN_STAGES.indexOf(r.status) < 0) return;
    var dates = safeJson_(r.status_dates);
    var since = dates[r.status] ? new Date(dates[r.status]).getTime() : new Date(r.created).getTime();
    var ageDays = Math.floor((nowMs - since) / DAY_MS);
    var val = toNum_(r.pi_total) || toNum_(r.total_est);

    stages[r.status].count++;
    stages[r.status].value += val;
    openCount++; openValue += val;

    if (ageDays > (STAGE_SLA[r.status] || 7)) {
      stages[r.status].ageing++;
      ageing.push({
        id: r.request_id, company: r.company, status: r.status,
        days_in_stage: ageDays, sla: STAGE_SLA[r.status] || 7, value: Math.round(val)
      });
    }
  });

  ageing.sort(function (a, b) { return (b.days_in_stage - b.sla) - (a.days_in_stage - a.sla); });
  return {
    stages: stages,
    open_count: openCount,
    open_value: Math.round(openValue),
    ageing: ageing.slice(0, 20),
    ageing_total: ageing.length
  };
}

/* ---------------- decisions: how the PI fared ------------------------------ */

function decisionStats_(inWin, nowMs) {
  var toPi = [], toDeliver = [], accepted = 0, declined = 0, awaiting = 0, awaitingOld = 0;

  inWin.forEach(function (r) {
    var dates = safeJson_(r.status_dates);
    var createdMs = new Date(r.created).getTime();
    if (dates['PI Sent']) toPi.push((new Date(dates['PI Sent']).getTime() - createdMs) / 3600000);
    if (dates.Delivered) toDeliver.push((new Date(dates.Delivered).getTime() - createdMs) / DAY_MS);
    if (dates['PI Accepted']) accepted++;
    if (r.status === 'Declined') declined++;
    if (r.status === 'New') {
      awaiting++;
      if (nowMs - createdMs > 2 * DAY_MS) awaitingOld++;
    }
  });

  var decided = accepted + declined;
  return {
    pi_accepted: accepted,
    pi_declined: declined,
    pi_win_rate: decided ? Math.round(accepted / decided * 100) : null,
    median_hours_to_pi: median_(toPi),
    median_days_to_deliver: median_(toDeliver),
    awaiting_decision: awaiting,
    awaiting_over_2_days: awaitingOld
  };
}

/* ---------------- products: requested vs actually shipped ------------------ */

function productStats_(requests, lines, prod, names, cutoff, catalogueSize) {
  var reqTs = {}, reqStatus = {};
  requests.forEach(function (r) {
    reqTs[r.request_id] = new Date(r.created).getTime();
    reqStatus[r.request_id] = r.status;
  });

  var SHIPPED = ['PO Received', 'In Production', 'Dispatched', 'Delivered', 'Closed'];
  var everRequested = {}, units = {}, lineValue = {}, shipped = {};

  lines.forEach(function (l) {
    var k = skuKey_(l.sku);
    everRequested[k] = 1;
    var ts = reqTs[l.request_id];
    if (!ts || ts < cutoff) return;
    units[k] = (units[k] || 0) + toNum_(l.qty);
    lineValue[k] = (lineValue[k] || 0) + toNum_(l.line_total);
    if (SHIPPED.indexOf(reqStatus[l.request_id]) >= 0) {
      shipped[k] = (shipped[k] || 0) + toNum_(l.qty);
    }
  });

  function top(obj) {
    return Object.keys(obj).map(function (sku) {
      return { sku: sku, name: names[sku] || sku, value: Math.round(obj[sku]) };
    }).sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
  }

  var never = Object.keys(prod).filter(function (k) { return !everRequested[k]; })
    .map(function (k) {
      var r = prod[k];
      return { sku: String(r.sku), name: r.name, category: r.category, on_hand: toNum_(r.on_hand) };
    });

  return {
    top_by_units: top(units),
    top_by_value: top(lineValue),
    top_by_shipped: top(shipped),
    never_requested: never.slice(0, 25),
    never_requested_total: never.length,
    catalogue_size: catalogueSize
  };
}

/* ---------------- customers: who the value is concentrated in -------------- */

function customerStats_(inWin) {
  var byCo = {}, total = 0;
  inWin.forEach(function (r) {
    var key = String(r.company || 'Unnamed').trim();
    var v = toNum_(r.pi_total) || toNum_(r.total_est);
    byCo[key] = byCo[key] || { company: key, requests: 0, value: 0 };
    byCo[key].requests++;
    byCo[key].value += v;
    total += v;
  });
  var list = Object.keys(byCo).map(function (k) { return byCo[k]; })
    .sort(function (a, b) { return b.value - a.value; });
  list.forEach(function (c) {
    c.value = Math.round(c.value);
    c.share = total ? Math.round(c.value / total * 100) : 0;
  });
  var top3 = list.slice(0, 3).reduce(function (a, c) { return a + c.value; }, 0);
  return {
    count: list.length,
    top: list.slice(0, 10),
    top3_share: total ? Math.round(top3 / total * 100) : null
  };
}

/* ---------------- stock: measured, not predicted --------------------------- */

/**
 * Consumption is only what actually left the building. StockLog also carries
 * 'manual adjust' and 'sheet sync' rows, which restate a count rather than
 * record a sale — counting those as demand would inflate every figure here.
 */
function stockSignals_(products, lines, requests, cutoff, days, nowMs) {
  var consumed = {}, lastOut = {};
  readRows_('StockLog').forEach(function (e) {
    var delta = toNum_(e.delta);
    if (delta >= 0) return;
    if (!/^(PO received|dispatch)/i.test(String(e.reason))) return;
    var k = skuKey_(e.sku);
    var ts = new Date(e.ts).getTime();
    if (!lastOut[k] || ts > lastOut[k]) lastOut[k] = ts;
    if (ts < cutoff) return;
    consumed[k] = (consumed[k] || 0) + Math.abs(delta);
  });

  // value ranking for ABC, over the same window
  var reqTs = {};
  requests.forEach(function (r) { reqTs[r.request_id] = new Date(r.created).getTime(); });
  var valueBySku = {}, totalValue = 0;
  lines.forEach(function (l) {
    var ts = reqTs[l.request_id];
    if (!ts || ts < cutoff) return;
    var k = skuKey_(l.sku), v = toNum_(l.line_total);
    valueBySku[k] = (valueBySku[k] || 0) + v;
    totalValue += v;
  });
  var ranked = Object.keys(valueBySku).sort(function (a, b) { return valueBySku[b] - valueBySku[a]; });
  var abc = {}, run = 0;
  ranked.forEach(function (k) {
    run += valueBySku[k];
    var pct = totalValue ? run / totalValue : 1;
    abc[k] = pct <= 0.8 ? 'A' : (pct <= 0.95 ? 'B' : 'C');
  });

  var reorder = [], dead = [], out = 0, low = 0, stockValue = 0;

  products.forEach(function (r) {
    var k = skuKey_(r.sku);
    var atp = atp_(r);
    var onHand = toNum_(r.on_hand);
    var rate = (consumed[k] || 0) / days;                 // units per day
    var cover = rate > 0 ? Math.floor(atp / rate) : null; // days of cover
    var rop = toNum_(r.reorder_point);
    var moq = toNum_(r.moq) || 1;

    stockValue += onHand;
    if (atp <= 0) out++;
    else if (rop && atp <= rop) low++;

    if (rop && atp <= rop) {
      // Cover the lead time plus a 30 day buffer, rounded up to a whole MOQ.
      var lead = toNum_(String(r.lead_time).replace(/[^0-9.]/g, '')) || 14;
      var target = Math.ceil(rate * (lead + 30));
      var need = Math.max(moq, Math.ceil(Math.max(target - atp, moq) / moq) * moq);
      reorder.push({
        sku: String(r.sku), name: r.name, brand: r.brand_id,
        atp: atp, reorder_point: rop, on_hand: onHand,
        rate_per_day: Math.round(rate * 100) / 100,
        days_cover: cover, lead_time: r.lead_time || '',
        suggest_qty: need, abc: abc[k] || 'C'
      });
    }

    if (onHand > 0 && !consumed[k]) {
      dead.push({
        sku: String(r.sku), name: r.name, on_hand: onHand,
        last_dispatch: lastOut[k] ? Utilities.formatDate(new Date(lastOut[k]), 'Asia/Kolkata', 'd MMM yyyy') : 'never',
        days_idle: lastOut[k] ? Math.floor((nowMs - lastOut[k]) / DAY_MS) : null
      });
    }
  });

  // Most urgent first: least cover, then furthest below the reorder point.
  reorder.sort(function (a, b) {
    var ac = a.days_cover === null ? 9999 : a.days_cover;
    var bc = b.days_cover === null ? 9999 : b.days_cover;
    return ac - bc || (a.atp - a.reorder_point) - (b.atp - b.reorder_point);
  });
  dead.sort(function (a, b) { return b.on_hand - a.on_hand; });

  var abcCount = { A: 0, B: 0, C: 0 };
  Object.keys(abc).forEach(function (k) { abcCount[abc[k]]++; });

  return {
    measured_over_days: days,
    out_of_stock: out,
    below_reorder_point: low,
    units_on_hand: stockValue,
    reorder: reorder.slice(0, 30),
    reorder_total: reorder.length,
    dead: dead.slice(0, 25),
    dead_total: dead.length,
    abc: abcCount,
    no_reorder_point: products.filter(function (r) { return !toNum_(r.reorder_point); }).length
  };
}

function median_(arr) {
  if (!arr.length) return null;
  arr.sort(function (a, b) { return a - b; });
  var mid = Math.floor(arr.length / 2);
  var m = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  return Math.round(m * 10) / 10;
}
