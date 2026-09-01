/**
 * Merchforce Ops — event recording.
 * The public catalogue endpoints (site, catalog, product) went with the
 * storefront. fnTrack_ stays because request creation still records a
 * per-SKU 'request' event, which analytics reads.
 */

function fnTrack_(p) {
  var events = (p.events || []).filter(function (ev) { return TRACK_TYPES[ev.type]; });
  if (!events.length) return ok_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var day = today_();
    var sh = sheet_('Events');
    var rows = readRows_('Events');
    var index = {};
    rows.forEach(function (r, i) { index[r.date + '|' + r.sku + '|' + r.type] = i + 2; });
    var counts = {};
    events.slice(0, 50).forEach(function (ev) {
      if (!ev.sku || !ev.type) return;
      var key = day + '|' + ev.sku + '|' + ev.type;
      counts[key] = (counts[key] || 0) + 1;
    });
    Object.keys(counts).forEach(function (key) {
      var parts = key.split('|');
      if (index[key]) {
        var cell = sh.getRange(index[key], 4);
        cell.setValue(toNum_(cell.getValue()) + counts[key]);
      } else {
        sh.appendRow([parts[0], parts[1], parts[2], counts[key]]);
      }
    });
  } finally {
    lock.releaseLock();
  }
  return ok_();
}
