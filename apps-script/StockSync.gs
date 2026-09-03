/**
 * Merchforce — supplier sheet sync, per brand.
 * The supplier keeps managing their catalog in their OWN Google Sheets — one
 * workbook (or tab) per brand, like the Wenger stock sheet. Each brand gets a
 * mapping {brand, sheet, tab, sku_col, fields:[{col, field}], create_new};
 * any sheet column can feed any syncable product field. A mapping bound to a
 * brand only touches that brand's products.
 *
 * Mappings live in Settings.sync_maps as a JSON array; each carries its own
 * last-run summary. Legacy maps with stock_col are migrated on read.
 */

// Product fields the sheet is allowed to write. 'price' means the FIRST price
// tier's unit price (the base selling price); deeper tiers stay admin-owned,
// as do reserved / safety stock / visibility.
var SYNC_FIELDS = {
  on_hand:   { label: 'Stock (on hand)', numeric: true },
  price:     { label: 'Selling price (first tier)', numeric: true },
  mrp:       { label: 'MRP', numeric: true },
  moq:       { label: 'MOQ', numeric: true },
  gst_rate:  { label: 'GST %', numeric: true },
  hsn:       { label: 'HSN code' },
  name:      { label: 'Product name' },
  lead_time: { label: 'Lead time' },
  description: { label: 'Description' },
  category:  { label: 'Category' },
  subcategory: { label: 'Subcategory' }
};

/** Legacy {stock_col} maps become fields:[{col, field:'on_hand'}]. */
function mapFields_(map) {
  if (map.fields && map.fields.length) return map.fields;
  if (map.stock_col) return [{ col: map.stock_col, field: 'on_hand' }];
  return [];
}

/**
 * A mapping may draw each field from a DIFFERENT TAB of the same workbook —
 * stock in one tab, prices and names in another — joined on each tab's own SKU
 * column. Sources: [{tab, sku_col, fields:[{col, field}]}]. Single-tab maps
 * (the old shape) are migrated on read, so nothing existing breaks.
 */
function mapSources_(map) {
  if (map.sources && map.sources.length) {
    return map.sources.filter(function (src) {
      return src.sku_col && (src.fields || []).length;
    });
  }
  var f = mapFields_(map);
  if (!f.length || !map.sku_col) return [];
  return [{ tab: map.tab || '', sku_col: map.sku_col, fields: f }];
}

function tabKey_(t) { return String(t === undefined || t === null ? '' : t).trim() || '__first__'; }

function sheetIdFrom_(v) {
  var m = String(v || '').match(/\/d\/([A-Za-z0-9_-]{20,})/);
  return m ? m[1] : String(v || '').trim();
}

function getSyncMaps_() {
  try { return JSON.parse(getSettings_().sync_maps || '[]'); } catch (e) { return []; }
}
function saveSyncMaps_(maps) {
  saveSettings_({ sync_maps: JSON.stringify(maps) });
}

function openSupplierSheet_(id, tab) {
  var ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (e) {
    throw new Error('Cannot open that sheet. Check the ID, and share it (Viewer) with ' + ownerEmail_());
  }
  var sh = tab ? ss.getSheetByName(tab) : ss.getSheets()[0];
  if (!sh) throw new Error('Tab "' + tab + '" not found in that sheet');
  return { ss: ss, sh: sh };
}

/** Open the supplier's sheet, return tabs + headers + a sample, for mapping. */
function fnAdminSyncPreview_(p) {
  var id = sheetIdFrom_(p.sheet);
  if (!id) return err_('Paste the supplier sheet link or ID');
  var o = openSupplierSheet_(id, p.tab || '');
  var lastCol = Math.min(o.sh.getLastColumn(), 30);
  var lastRow = o.sh.getLastRow();
  if (lastRow < 2 || lastCol < 1) return err_('That tab looks empty');
  var headers = o.sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var sample = o.sh.getRange(2, 1, Math.min(5, lastRow - 1), lastCol).getDisplayValues();
  // Every tab's columns in one call, so the admin can map across tabs
  // (stock in one, prices in another) without loading them one by one.
  var allTabs = o.ss.getSheets().slice(0, 30).map(function (t) {
    var lc = Math.min(t.getLastColumn(), 30), lr = t.getLastRow();
    if (lr < 1 || lc < 1) return { name: t.getName(), headers: [], sample: [], rows: 0 };
    return {
      name: t.getName(),
      headers: t.getRange(1, 1, 1, lc).getValues()[0].map(String),
      sample: lr > 1 ? t.getRange(2, 1, Math.min(3, lr - 1), lc).getDisplayValues() : [],
      rows: lr - 1
    };
  });
  return ok_({
    sheet_id: id,
    tabs: o.ss.getSheets().map(function (s) { return s.getName(); }),
    all_tabs: allTabs,
    tab: o.sh.getName(),
    headers: headers,
    sample: sample,
    rows: lastRow - 1,
    owner_hint: ownerEmail_()
  });
}

/** Save (add or replace) one brand mapping. */
function fnAdminSyncMapSave_(p) {
  var m = p.map || {};
  var mode = m.mode === 'push' ? 'push' : 'pull';
  m.sheet = sheetIdFrom_(m.sheet);
  var fields = (m.fields || []).filter(function (f) { return f.col && SYNC_FIELDS[f.field]; });
  // Sources = one entry per tab used: {tab, sku_col, fields:[{col, field}]}.
  var sources = (m.sources || []).map(function (src) {
    return {
      tab: src.tab || '',
      sku_col: src.sku_col || '',
      fields: (src.fields || []).filter(function (f) { return f.col && SYNC_FIELDS[f.field]; })
    };
  }).filter(function (src) { return src.sku_col && src.fields.length; });
  if (!sources.length && fields.length && m.sku_col) {
    sources = [{ tab: m.tab || '', sku_col: m.sku_col, fields: fields }];
  }
  if (mode === 'pull' && (!m.sheet || !sources.length)) {
    return err_('Sheet, SKU column and at least one field mapping are required');
  }
  // A field may only be fed by one tab, or two tabs would fight over it.
  var claimed = {};
  for (var si = 0; si < sources.length; si++) {
    for (var fi = 0; fi < sources[si].fields.length; fi++) {
      var fname = sources[si].fields[fi].field;
      if (claimed[fname]) return err_('Field "' + SYNC_FIELDS[fname].label + '" is mapped from more than one tab');
      claimed[fname] = 1;
    }
  }
  // A push mapping may be saved before the supplier's first push, when the
  // columns are not known yet — the connector discovers them for us.
  if (mode === 'push' && !m.brand) {
    return err_('A push mapping must be bound to one brand');
  }
  if (m.create_new && !m.brand) {
    return err_('To auto-create new products, the mapping must be bound to one brand');
  }
  var maps = getSyncMaps_();
  var idx = toNum_(p.index);
  var rec = { mode: mode, brand: m.brand || '', sheet: m.sheet, tab: m.tab || '',
              sku_col: m.sku_col || '', fields: fields, sources: sources,
              create_new: !!m.create_new,
              // pull maps that carry on_hand can have the app write stock back into the sheet
              write_back: mode === 'pull' && m.write_back !== false && m.write_back !== 'false',
              push_key: '', headers: null, sample: null, tabs_meta: null, last: null };
  if (p.index !== undefined && maps[idx]) {
    rec.last = maps[idx].last;
    rec.write_back_last = maps[idx].write_back_last || null;
    rec.push_key = maps[idx].push_key || '';
    rec.headers = maps[idx].headers || null;
    rec.sample = maps[idx].sample || null;
    rec.tabs_meta = maps[idx].tabs_meta || null;
    maps[idx] = rec;
  } else {
    maps.push(rec);
  }
  if (!rec.push_key) rec.push_key = 'mfp_' + randomToken_(24);   // every mapping: push for push maps, stock pull-back for all
  saveSyncMaps_(maps);
  audit_(p.actor || 'admin', 'sync_map_save', rec.brand || 'all', rec.sheet);
  return ok_({ maps: maps });
}

function fnAdminSyncMapDelete_(p) {
  var maps = getSyncMaps_();
  var idx = toNum_(p.index);
  if (!maps[idx]) return err_('Mapping not found');
  maps.splice(idx, 1);
  saveSyncMaps_(maps);
  return ok_({ maps: maps });
}

/** Run one mapping (index given) or every mapping. */
function fnAdminSyncRun_(p) {
  var maps = getSyncMaps_();
  if (!maps.length) return err_('No mappings yet — add one first');
  var toRun = (p.index !== undefined) ? [toNum_(p.index)] : maps.map(function (_, i) { return i; });
  var results = [];
  toRun.forEach(function (i) {
    if (!maps[i]) return;
    var summary = runStockSync_(maps[i], p.actor || 'admin');
    maps[i].last = summary;
    results.push({ index: i, brand: maps[i].brand, summary: summary });
  });
  saveSyncMaps_(maps);
  return ok_({ results: results, maps: maps });
}

function emptySummary_() {
  return { ts: String(now_()), matched: 0, updated: 0, unchanged: 0, created: 0,
           unknown: 0, off_brand: 0, unknown_skus: [], created_skus: [], error: null };
}

/** PULL mode: Merchforce opens the supplier's sheet (needs Viewer access). */
function runStockSync_(map, actor) {
  if (map.mode === 'push') {
    var s = emptySummary_();
    s.error = 'Push mapping — the supplier\'s sheet sends the data; nothing to pull here';
    return s;
  }
  var tabData = {};
  try {
    var sources = mapSources_(map);
    if (!sources.length) throw new Error('No field mappings — edit the mapping');
    var seen = {};
    sources.forEach(function (src) {
      var key = tabKey_(src.tab);
      if (seen[key]) return;           // one read per tab, however many fields use it
      seen[key] = 1;
      var o = openSupplierSheet_(map.sheet, src.tab || '');
      var lastCol = o.sh.getLastColumn();
      var lastRow = o.sh.getLastRow();
      tabData[key] = {
        headers: lastCol ? o.sh.getRange(1, 1, 1, lastCol).getValues()[0] : [],
        rows: lastRow > 1 ? o.sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : []
      };
    });
  } catch (e) {
    var f = emptySummary_();
    f.error = e.message || String(e);
    audit_(actor || 'sync', 'sheet_sync', (map.brand || 'all') + ':' + map.sheet, f.error);
    return f;
  }
  return applySyncData_(map, tabData, actor);
}

/**
 * Shared engine: apply sheet rows to the catalog. Used by pull mode and by
 * PUSH mode, where the connector on the supplier's own sheet POSTs the rows
 * and Merchforce never touches (or needs access to) their file.
 *
 * tabData: { <tab name or __first__>: {headers, rows} }. Every source is read
 * with its own SKU column and merged on the SKU, so a product can take its
 * stock from one tab and its price and name from another.
 */
function applySyncData_(map, tabData, actor) {
  var summary = emptySummary_();
  try {
    var sources = mapSources_(map);
    if (!sources.length) throw new Error('No field mappings — edit the mapping');
    var firstKey = Object.keys(tabData)[0];

    var incoming = {}; // skuKey -> {sku, values:{field: value}} merged across tabs
    sources.forEach(function (src) {
      var label = src.tab || 'first tab';
      var d = tabData[tabKey_(src.tab)] || (tabKey_(src.tab) === '__first__' ? tabData[firstKey] : null);
      if (!d) throw new Error('No data for tab "' + label + '"');
      var headers = (d.headers || []).map(function (h) { return String(h).trim(); });
      var iSku = headers.indexOf(String(src.sku_col).trim());
      if (iSku < 0) throw new Error('SKU column "' + src.sku_col + '" not found in tab "' + label + '"');
      var fIdx = (src.fields || []).map(function (f) {
        var i = headers.indexOf(String(f.col).trim());
        if (i < 0) throw new Error('Column "' + f.col + '" not found in tab "' + label + '"');
        return { i: i, field: f.field, numeric: !!SYNC_FIELDS[f.field].numeric };
      });
      (d.rows || []).forEach(function (row) {
        var rawSku = String(row[iSku]).trim();
        if (!rawSku) return;
        var k = skuKey_(rawSku);
        var rec = incoming[k];
        if (!rec) { rec = { sku: rawSku, values: {} }; incoming[k] = rec; }
        fIdx.forEach(function (f) {
          var v = row[f.i];
          if (f.numeric) {
            var n = Number(v);
            var num = isNaN(n) ? null : Math.max(0, f.field === 'gst_rate' ? n : Math.floor(n * 100) / 100);
            if ((f.field === 'on_hand' || f.field === 'moq') && num !== null) num = Math.floor(num);
            rec.values[f.field] = num;
          } else {
            rec.values[f.field] = String(v === undefined || v === null ? '' : v).trim();
          }
        });
      });
    });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var sh = sheet_('Products');
      var cols = SHEETS.Products;
      var iUpdated = cols.indexOf('updated') + 1;
      var rows = readRows_('Products');

      // first-tier price index for the 'price' field
      var tierRows = readRows_('PriceTiers');
      var firstTierRow = {}; // skuKey -> {rowNum, min, price}
      tierRows.forEach(function (t, i) {
        var k = skuKey_(t.sku);
        if (!firstTierRow[k] || toNum_(t.min_qty) < firstTierRow[k].min) {
          firstTierRow[k] = { rowNum: i + 2, min: toNum_(t.min_qty), price: toNum_(t.unit_price) };
        }
      });
      var shT = sheet_('PriceTiers');

      var known = {}, stockTouched = false;
      rows.forEach(function (r, i) {
        var k = skuKey_(r.sku);
        known[k] = 1;
        var inc = incoming[k];
        if (!inc) return;
        if (map.brand && r.brand_id !== map.brand) { summary.off_brand++; return; }
        summary.matched++;
        var changed = false;
        Object.keys(inc.values).forEach(function (field) {
          var v = inc.values[field];
          if (v === null) return;
          if (field === 'price') {
            var ft = firstTierRow[k];
            if (ft) {
              if (ft.price !== v) { shT.getRange(ft.rowNum, 3).setValue(v); changed = true; }
            } else {
              appendRecord_('PriceTiers', { sku: String(r.sku), min_qty: toNum_(r.moq) || 1, unit_price: v, gst: '' });
              changed = true;
            }
            return;
          }
          var iCol = cols.indexOf(field) + 1;
          if (iCol < 1) return;
          var cur = SYNC_FIELDS[field].numeric ? toNum_(r[field]) : String(r[field] === undefined ? '' : r[field]);
          var next = SYNC_FIELDS[field].numeric ? v : String(v);
          if (field === 'on_hand') {
            // Change detection: the sheet only overrides the app when the SUPPLIER changed
            // the cell. If it still shows what we read last time, the app's own movements
            // (dispatches, receipts) since then stand. Without this, a viewer-only sheet
            // would silently undo every deduction on the next sync.
            var seenCol = cols.indexOf('sync_seen') + 1;
            if (seenCol > sh.getMaxColumns()) seenCol = 0;   // column not on the sheet yet (setupRun pending)
            var seen = seenCol > 0 ? String(r.sync_seen === undefined || r.sync_seen === null ? '' : r.sync_seen) : '';
            if (seen !== '' && toNum_(seen) === next) { summary.kept = (summary.kept || 0) + (cur === next ? 0 : 1); return; }
            if (seenCol > 0) sh.getRange(i + 2, seenCol).setValue(next);
          }
          if (cur === next) return;
          sh.getRange(i + 2, iCol).setValue(next);
          changed = true;
          if (field === 'on_hand') {
            appendRecord_('StockLog', { ts: now_(), sku: String(r.sku), delta: next - cur,
              reason: 'sheet sync' + (map.brand ? ' (' + map.brand + ')' : ''), actor: actor || 'sync' });
            stockTouched = true;
          }
        });
        if (changed) {
          sh.getRange(i + 2, iUpdated).setValue(now_());
          summary.updated++;
        } else {
          summary.unchanged++;
        }
      });

      // rows in the sheet that are not in the catalog
      Object.keys(incoming).forEach(function (k) {
        if (known[k]) return;
        var inc = incoming[k];
        if (map.create_new && map.brand) {
          var v = inc.values;
          var moq = v.moq || 1;
          appendRecord_('Products', {
            sku: String(inc.sku).toUpperCase(), name: v.name || String(inc.sku),
            brand_id: map.brand, category: v.category || '', subcategory: v.subcategory || '',
            description: v.description || '', specs: '', image_urls: '',
            moq: moq, gst_rate: v.gst_rate === undefined || v.gst_rate === null ? 18 : v.gst_rate,
            lead_time: v.lead_time || '', on_hand: v.on_hand || 0, reserved: 0,
            safety_stock: 0, reorder_point: 0,
            visible: 'FALSE', show_price: 'TRUE', created: now_(), updated: now_(),
            mrp: v.mrp || '', hsn: v.hsn || ''
          });
          if (v.price) {
            appendRecord_('PriceTiers', { sku: String(inc.sku).toUpperCase(), min_qty: moq, unit_price: v.price, gst: '' });
          }
          summary.created++;
          if (summary.created_skus.length < 20) summary.created_skus.push(String(inc.sku));
        } else {
          summary.unknown++;
          if (summary.unknown_skus.length < 20) summary.unknown_skus.push(String(inc.sku));
        }
      });
    } finally {
      if (stockTouched) bumpStockVersion_();
      lock.releaseLock();
    }
    CacheService.getScriptCache().remove('catalog_v1');
  } catch (e) {
    summary.error = e.message || String(e);
  }
  audit_(actor || 'sync', 'sheet_sync', (map.brand || 'all') + ':' + map.sheet,
    summary.error || (summary.updated + ' updated, ' + summary.created + ' created, ' + summary.unknown + ' unknown'));
  return summary;
}

/** Scheduled auto-pull of every mapping: off | live5 (every 5 min) | hourly | daily (~06:00 IST). */
function fnAdminSyncSchedule_(p) {
  var mode = ['live5', 'hourly', 'daily'].indexOf(p.mode) >= 0 ? p.mode : 'off';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncTick') ScriptApp.deleteTrigger(t);
  });
  if (mode === 'live5') ScriptApp.newTrigger('syncTick').timeBased().everyMinutes(5).create();
  if (mode === 'hourly') ScriptApp.newTrigger('syncTick').timeBased().everyHours(1).create();
  if (mode === 'daily') ScriptApp.newTrigger('syncTick').timeBased().everyDays(1).atHour(6).create();
  saveSettings_({ sync_auto: mode });
  audit_(p.actor || 'admin', 'sync_schedule', '', mode);
  return ok_({ mode: mode });
}

/**
 * TRUE live sync: a tiny connector script installed on the SUPPLIER'S sheet
 * (see the Live sync panel in Admin → Settings) POSTs {action:'syncPing',
 * sheet:<id>} here the moment a cell is edited. We debounce per sheet (45s)
 * and pull just the mappings for that sheet. Public action — the token
 * authorises it and it can only trigger a pull that admins configured.
 */
function fnSyncPing_(p) {
  var id = sheetIdFrom_(p.sheet);
  if (!id) return err_('sheet required');
  var maps = getSyncMaps_();
  var mine = [];
  maps.forEach(function (m, i) { if (m.sheet === id) mine.push(i); });
  if (!mine.length) return ok_({ synced: 0, note: 'No mapping uses this sheet' });

  var cache = CacheService.getScriptCache();
  if (cache.get('ping_' + id)) return ok_({ synced: 0, throttled: true });
  cache.put('ping_' + id, '1', 45);

  var touched = 0;
  mine.forEach(function (i) {
    var summary = runStockSync_(maps[i], 'live-sync');
    maps[i].last = summary;
    touched += (summary.updated || 0) + (summary.created || 0);
  });
  saveSyncMaps_(maps);
  return ok_({ synced: mine.length, touched: touched });
}

function syncTick() {
  var maps = getSyncMaps_();
  maps.forEach(function (m) { m.last = runStockSync_(m, 'auto-sync'); });
  if (maps.length) saveSyncMaps_(maps);
}

/**
 * PUSH mode — for suppliers who will NOT share their sheet.
 * A connector installed on their own sheet (generated per mapping in the
 * admin console) reads the rows under THEIR account and POSTs them here with
 * the mapping's push_key. Merchforce never opens, and never needs access to,
 * their file: only the columns they mapped ever leave it.
 *
 * The first push also reports the sheet's headers, so the admin can map the
 * columns without ever seeing the sheet.
 */
function fnSyncPush_(p) {
  var key = String(p.push_key || '');
  if (!key) return err_('push_key required');
  var maps = getSyncMaps_();
  var idx = -1;
  maps.forEach(function (m, i) { if (m.push_key && m.push_key === key) idx = i; });
  if (idx < 0) return err_('Unknown push key — re-copy the connector from the admin console');

  // The connector sends every tab it is allowed to read ({name, headers, rows}).
  // Older connectors send a single {headers, rows} — still accepted.
  var tabs = p.tabs;
  if (!tabs || !tabs.length) {
    if (!(p.headers || []).length) return err_('No tabs received (is row 1 of that sheet empty?)');
    tabs = [{ name: '', headers: p.headers, rows: p.rows || [] }];
  }
  var tabData = {}, meta = [];
  tabs.slice(0, 30).forEach(function (t, i) {
    var headers = (t.headers || []).map(function (h) { return String(h).trim(); });
    var rows = (t.rows || []).slice(0, 5000);
    var key2 = tabKey_(t.name);
    tabData[key2] = { headers: headers, rows: rows };
    if (i === 0) tabData['__first__'] = tabData[key2];
    meta.push({
      name: String(t.name || ''),
      headers: headers.slice(0, 30),
      rows: rows.length,
      sample: rows.slice(0, 3).map(function (r) {
        return r.slice(0, 30).map(function (c) { return String(c === null || c === undefined ? '' : c).slice(0, 40); });
      })
    });
  });

  // Remember the shape of their workbook so the mapping UI can offer every
  // tab and column — the admin never opens (or can open) the file itself.
  maps[idx].tabs_meta = meta;
  maps[idx].headers = meta[0] ? meta[0].headers : null;
  maps[idx].sample = meta[0] ? meta[0].sample : null;

  var summary;
  if (!mapSources_(maps[idx]).length) {
    summary = emptySummary_();
    summary.awaiting_mapping = true;
    summary.error = 'Connected — now map the columns in the admin console';
    maps[idx].last = summary;
    saveSyncMaps_(maps);
    audit_('push-sync', 'sheet_push', maps[idx].brand || '', 'awaiting mapping, ' + meta.length + ' tabs');
    return ok_({ awaiting_mapping: true, tabs: meta.map(function (m) { return m.name; }),
                 headers: maps[idx].headers });
  }

  summary = applySyncData_(maps[idx], tabData, 'push-sync');
  maps[idx].last = summary;
  saveSyncMaps_(maps);
  return ok_({ summary: summary });
}

/* ---------------- write-back ----------------
 * The link is normally one way (sheet → app). With write_back on, every stock
 * movement the app makes (PO received, dispatch, supply received, manual
 * adjust) is written into the supplier's sheet as well, so their sheet shows
 * the same on_hand the app holds and the next pull does not undo the movement.
 * Only pull mappings can do this: a push mapping never opens the sheet.
 */

/** skus: array of SKU strings whose on_hand just changed. Best effort; never throws. */
function writeBackStock_(skus, actor) {
  var out = { written: 0, errors: [] };
  bumpStockVersion_();
  try {
    var all = getSyncMaps_();
    var maps = all.filter(function (m) { return m.mode !== 'push' && m.write_back && m.sheet; });
    if (!maps.length || !skus || !skus.length) return out;
    var wanted = {};
    skus.forEach(function (k) { wanted[skuKey_(k)] = 1; });
    var products = readRows_('Products').filter(function (r) { return wanted[skuKey_(r.sku)]; });
    if (!products.length) return out;
    var touched = false;
    maps.forEach(function (m) {
      var written = 0, err = '';
      mapSources_(m).forEach(function (src) {
        var f = (src.fields || []).filter(function (x) { return x.field === 'on_hand'; })[0];
        if (!f) return;
        var mine = products.filter(function (r) { return !m.brand || r.brand_id === m.brand; });
        if (!mine.length) return;
        try {
          var o = openSupplierSheet_(m.sheet, src.tab);
          var last = o.sh.getLastRow(), lastCol = o.sh.getLastColumn();
          if (last < 2) return;
          var headers = o.sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
          var iSku = headers.indexOf(String(src.sku_col).trim()), iStock = headers.indexOf(String(f.col).trim());
          if (iSku < 0 || iStock < 0) throw new Error('column "' + (iSku < 0 ? src.sku_col : f.col) + '" not found in tab "' + (src.tab || 'first') + '"');
          var skuCol = o.sh.getRange(2, iSku + 1, last - 1, 1).getValues();
          var rowOf = {};
          skuCol.forEach(function (row, i) { var k = skuKey_(row[0]); if (k && rowOf[k] === undefined) rowOf[k] = i + 2; });
          mine.forEach(function (r) {
            var rowNum = rowOf[skuKey_(r.sku)];
            if (!rowNum) return;
            var cell = o.sh.getRange(rowNum, iStock + 1);
            var next = toNum_(r.on_hand);
            if (Number(cell.getValue()) === next) return;
            cell.setValue(next);
            markSeen_(r.sku, next);
            written++;
          });
        } catch (e) {
          err = (m.brand || 'all') + ': ' + (e.message || e);
          out.errors.push(err);
        }
      });
      if (written || err) { m.write_back_last = { ts: String(now_()), written: written, error: err }; touched = true; }
      out.written += written;
    });
    if (touched) saveSyncMaps_(all);
    if (out.errors.length) audit_(actor || 'system', 'writeback_fail', skus.slice(0, 10).join(','), out.errors.join(' | '));
  } catch (e) {
    out.errors.push(String(e.message || e));
    try { audit_(actor || 'system', 'writeback_fail', (skus || []).slice(0, 10).join(','), String(e.message || e)); } catch (e2) {}
  }
  return out;
}

/** Remember what the sheet now shows for a SKU so change detection does not treat our own write as a supplier edit. */
function markSeen_(sku, value) {
  try {
    var cols = SHEETS.Products, seenCol = cols.indexOf('sync_seen') + 1, sh = sheet_('Products');
    if (seenCol < 1 || seenCol > sh.getMaxColumns()) return;
    var rowNum = findRow_('Products', function (r) { return skuKey_(r.sku) === skuKey_(sku); });
    if (rowNum > 0) sh.getRange(rowNum, seenCol).setValue(value);
  } catch (e) {}
}

/* ---------------- stock version + pull-back ----------------
 * A counter in script properties moves on every on_hand change, whatever the
 * cause. A connector on the supplier's sheet polls syncStock with the version
 * it last applied; unchanged → tiny reply; changed → the brand's stock list,
 * which the connector writes into its own Stock column. Viewer-only sheets can
 * therefore stay current without the app ever being given edit access.
 */
function stockVersion_() { return toNum_(props_().getProperty('STOCK_VER')); }
function bumpStockVersion_() {
  try { props_().setProperty('STOCK_VER', String(stockVersion_() + 1)); } catch (e) {}
}

/** PUBLIC (push_key authorised): {push_key, since} → {version, unchanged} or {version, stock:[{sku, on_hand}]}. */
function fnSyncStock_(p) {
  var key = String(p.push_key || '');
  if (!key) return err_('push_key required');
  var m = getSyncMaps_().filter(function (x) { return x.push_key && x.push_key === key; })[0];
  if (!m) return err_('Unknown key — re-copy the connector from the admin console');
  var ver = stockVersion_();
  if (toNum_(p.since) === ver && p.since !== undefined && p.since !== '') return ok_({ version: ver, unchanged: true });
  var stock = readRows_('Products').filter(function (r) { return !m.brand || r.brand_id === m.brand; })
    .map(function (r) { return { sku: String(r.sku), on_hand: toNum_(r.on_hand) }; });
  return ok_({ version: ver, stock: stock, brand: m.brand || '' });
}

/** Push every product's on_hand into the linked sheets now (after turning write-back on, or to repair drift). */
function fnAdminSyncWriteBackAll_(p) {
  var skus = readRows_('Products').map(function (r) { return String(r.sku); });
  var res = writeBackStock_(skus, p.actor);
  audit_(p.actor || 'admin', 'writeback_all', '', res.written + ' cells');
  return ok_(res);
}

/* ---------------- standard format ----------------
 * A supplier with no usable sheet gets one in the app's own Drive: one tab per
 * brand in the Merchforce format, shared with them as editor, already mapped
 * (pull, write-back on) so it works the moment they open it.
 */
var TEMPLATE_HEADERS_ = ['Code', 'Product Name', 'HSN', 'GST %', 'MRP', 'Selling Price Excluding GST', 'Stock', 'MOQ', 'Lead Time'];
var TEMPLATE_FIELDS_ = [
  { col: 'Product Name', field: 'name' }, { col: 'HSN', field: 'hsn' }, { col: 'GST %', field: 'gst_rate' },
  { col: 'MRP', field: 'mrp' }, { col: 'Selling Price Excluding GST', field: 'price' }, { col: 'Stock', field: 'on_hand' },
  { col: 'MOQ', field: 'moq' }, { col: 'Lead Time', field: 'lead_time' }
];

/** Build the standard-format sheet. p.link: also create mappings; p.editor_email: share with the supplier; p.brand: one brand only. */
function fnAdminSyncTemplate_(p) {
  var root = DriveApp.getFolderById(props_().getProperty('FOLDER_ID'));
  var name = String(p.name || '').trim() || ('Merchforce Stock Sheet — ' + Utilities.formatDate(now_(), 'Asia/Kolkata', 'd MMM yyyy'));
  var ss = SpreadsheetApp.create(name);
  DriveApp.getFileById(ss.getId()).moveTo(root);

  var brands = readRows_('Brands').sort(function (a, b) { return toNum_(a.sort) - toNum_(b.sort); });
  if (p.brand) brands = brands.filter(function (b) { return b.brand_id === p.brand; });
  if (!brands.length) return err_('No brands to build tabs for');
  var products = readRows_('Products');
  var firstTier = {};
  readRows_('PriceTiers').forEach(function (t) {
    var cur = firstTier[t.sku];
    if (!cur || toNum_(t.min_qty) < cur.min) firstTier[t.sku] = { min: toNum_(t.min_qty), price: toNum_(t.unit_price) };
  });

  var HEADERS = TEMPLATE_HEADERS_;
  brands.forEach(function (b) {
    var rows = products.filter(function (pr) { return pr.brand_id === b.brand_id; })
      .map(function (pr) {
        return [String(pr.sku), pr.name, String(pr.hsn || ''), toNum_(pr.gst_rate) || '',
                toNum_(pr.mrp) || '', firstTier[pr.sku] ? firstTier[pr.sku].price : '',
                toNum_(pr.on_hand), toNum_(pr.moq) || '', pr.lead_time || ''];
      });
    var sh = ss.insertSheet(b.name);
    sh.getRange(1, 1, Math.max(2, rows.length + 1), 1).setNumberFormat('@');   // codes stay text
    sh.getRange(1, 3, Math.max(2, rows.length + 1), 1).setNumberFormat('@');   // HSN keeps leading zeros
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#eef1ff');
    sh.setFrozenRows(1);
    if (rows.length) sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
    sh.autoResizeColumns(1, HEADERS.length);
  });
  var guide = ss.insertSheet('How to use', 0);
  guide.getRange(1, 1, 8, 1).setValues([
    ['Merchforce stock sheet'],
    ['One tab per brand. Keep the header row exactly as it is; the app finds columns by name.'],
    ['Code is the SKU the app knows. Do not rename a code; add a new row for a new product.'],
    ['Stock is on hand. The app reads it, and writes it back after every order, dispatch and receipt, so it always matches the console.'],
    ['Selling Price Excluding GST sets the first price tier. Deeper tiers are managed in the console.'],
    ['Leave a cell blank to leave that field alone in the app.'],
    ['Do not add rows above the header, and do not merge cells.'],
    ['Sync runs on the schedule set in the console (Settings → Sheet sync), or instantly with the connector.']
  ]);
  guide.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  guide.setColumnWidth(1, 900);
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 1) ss.deleteSheet(s1);

  var file = DriveApp.getFileById(ss.getId());
  var shared = '';
  var editor = String(p.editor_email || '').trim();
  if (editor) {
    try { file.addEditor(editor); shared = editor; }
    catch (e) { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT); shared = 'anyone with the link (could not add ' + editor + ': ' + e.message + ')'; }
  } else {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }

  var linked = 0;
  if (p.link) {
    var maps = getSyncMaps_();
    brands.forEach(function (b) {
      maps = maps.filter(function (m) { return !(m.mode !== 'push' && m.brand === b.brand_id); });   // replace any pull map for this brand
      maps.push({ mode: 'pull', brand: b.brand_id, sheet: ss.getId(), tab: b.name, sku_col: 'Code',
                  fields: TEMPLATE_FIELDS_, sources: [{ tab: b.name, sku_col: 'Code', fields: TEMPLATE_FIELDS_ }],
                  create_new: true, write_back: true, push_key: '', headers: null, sample: null, tabs_meta: null, last: null });
      linked++;
    });
    saveSyncMaps_(maps);
  }
  audit_(p.actor || 'admin', 'sync_template', ss.getId(), brands.length + ' brand tabs' + (linked ? ', linked' : '') + (shared ? ', shared with ' + shared : ''));
  return ok_({ url: ss.getUrl(), sheet_id: ss.getId(), name: name, linked: linked, shared: shared, maps: getSyncMaps_() });
}

/** getEffectiveUser needs the userinfo.email scope — fall back gracefully. */
function ownerEmail_() {
  try { return Session.getEffectiveUser().getEmail() || 'the Merchforce backend account'; }
  catch (e) { return 'the Merchforce backend account'; }
}
