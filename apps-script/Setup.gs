/**
 * Merchforce — one-time bootstrap.
 * POST {action:'setup', key:SETUP_KEY} to the /exec URL (or run setupRun from the editor).
 * Creates the dedicated Drive folder, the backend Sheet with all tabs,
 * generates API_TOKEN / PEPPER / ADMIN_PASS, seeds demo data.
 * Idempotent: refuses to run twice unless {force:true}.
 */

/**
 * Editor-friendly entry point (runs as owner, so pass the stored admin key).
 * seed:false is deliberate. This is a working backend, not a demo, and the
 * guard in setup_ is `p.seed !== false` — omitting it seeds the demo catalogue
 * into any empty Products tab, which is how the first run here ended up with
 * Merchforce's demo products in it.
 */
function setupRun() {
  var res = setup_({ key: SETUP_KEY, force: true, seed: false,
                     adminKey: props_().getProperty('ADMIN_PASS') || '' });
  Logger.log(JSON.stringify(res, null, 2));
}

/**
 * One-shot: clear the demo catalogue seeded on first setup. Leaves headers,
 * settings, users and the audit log alone. Run from the editor.
 */
function purgeSeedData() {
  var ss = SpreadsheetApp.openById(props_().getProperty('SHEET_ID'));
  ['Products', 'PriceTiers', 'Brands', 'Events', 'StockLog'].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh && sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  CacheService.getScriptCache().remove('catalog_v1');
  Logger.log('Seed data cleared. Catalogue is now empty.');
}

function setup_(p) {
  if (!SETUP_KEY || SETUP_KEY === 'CHANGE-ME-BEFORE-SETUP') {
    // still allow, but flag it — the key must be rotated after use
  }
  if (String(p.key) !== SETUP_KEY) return { ok: false, error: 'Bad setup key' };
  if (props_().getProperty('SHEET_ID')) {
    // Once installed, re-running setup (which returns the secrets) requires the
    // admin key too — the repo is public, so SETUP_KEY alone must not unlock it.
    if (!p.force) return { ok: false, error: 'Already set up. Pass force:true plus adminKey to re-run (existing data kept).' };
    if (String(p.adminKey) !== props_().getProperty('ADMIN_PASS')) {
      return { ok: false, error: 'adminKey required to re-run setup' };
    }
  }

  // 1. Drive folder tree
  var folderId = props_().getProperty('FOLDER_ID');
  var root = folderId ? DriveApp.getFolderById(folderId) : DriveApp.createFolder('Merchforce');
  props_().setProperty('FOLDER_ID', root.getId());
  var images = ensureChild_(root, 'Images');
  ensureChild_(root, 'Exports');
  props_().setProperty('IMAGES_FOLDER_ID', images.getId());

  // 2. Backend spreadsheet
  var sheetId = props_().getProperty('SHEET_ID');
  var ss;
  if (sheetId) {
    ss = SpreadsheetApp.openById(sheetId);
  } else {
    ss = SpreadsheetApp.create('Merchforce Backend');
    DriveApp.getFileById(ss.getId()).moveTo(root);
    props_().setProperty('SHEET_ID', ss.getId());
  }
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = SHEETS[name];
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && ss.getSheets().length > 1) ss.deleteSheet(s1);

  // 3. Secrets
  if (!props_().getProperty('API_TOKEN'))
    props_().setProperty('API_TOKEN', 'mf_' + randomToken_(28));
  if (!props_().getProperty('PEPPER'))
    props_().setProperty('PEPPER', randomToken_(24));
  if (!props_().getProperty('ADMIN_PASS'))
    props_().setProperty('ADMIN_PASS', 'mf-' + randomToken_(12));

  // 4. Defaults + demo seed
  var st = ss.getSheetByName('Settings');
  if (st.getLastRow() < 2) {
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      st.appendRow([k, DEFAULT_SETTINGS[k]]);
    });
  }
  if (p.seed !== false && ss.getSheetByName('Products').getLastRow() < 2) seedDemo_();

  audit_('setup', 'setup', '', 'bootstrap complete');
  return {
    ok: true,
    folder: root.getId(),
    sheet: ss.getId(),
    api_token: props_().getProperty('API_TOKEN'),
    admin_pass: props_().getProperty('ADMIN_PASS'),
    note: 'Store these now. Rotate SETUP_KEY in Config.gs and push again.'
  };
}

function ensureChild_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function seedDemo_() {
  SEED_DATA.brands.forEach(function (b) {
    appendRecord_('Brands', {
      brand_id: b.id, name: b.name, logo_url: '', description: '',
      active: 'TRUE', sort: b.sort
    });
  });
  SEED_DATA.products.forEach(function (p) {
    appendRecord_('Products', {
      sku: p.sku, name: p.name, brand_id: p.brand_id, category: p.category,
      subcategory: p.sub || '', description: p.desc,
      specs: (p.specs || []).join('|'), image_urls: p.image || '',
      moq: p.moq, gst_rate: 18, lead_time: p.lead,
      on_hand: p.stock, reserved: 0,
      safety_stock: Math.round(p.stock * 0.03),
      reorder_point: Math.round(p.stock * 0.1),
      visible: 'TRUE', show_price: 'TRUE', created: now_(), updated: now_(),
      mrp: p.mrp || ''
    });
    (p.tiers || []).forEach(function (t) {
      appendRecord_('PriceTiers', { sku: p.sku, min_qty: t[0], unit_price: t[1] });
    });
  });
}

/**
 * One-shot: apply the HSN codes established for the Merchforce catalogue on
 * 1 Sep 2026 to the matching SKUs here. seedDemo_ predates the hsn column and
 * does not populate it, so a seeded catalogue has none, and a GST invoice
 * needs one. Sourced from the CS Product Master, matched on Final SKU Code.
 * Run from the editor. Safe to re-run: it only fills, never overwrites.
 */
function importHsn() {
  var MAP = {
    '1953184': '960810', '5324866819': '8504', '5324866820': '8504',
    '6111990716': '85076000', '8902298161024': '960830', '9000017248': '960810',
    '9578398628': '8504', 'B0560TI01': '73239390', 'B30906': '61091000',
    'BT380BLK130': '73239390', 'BT700BLK104': '73239390', 'BTU0500BLK36': '73239390',
    'CSUN-0064': '96081019', 'CSUN-0124': '96081019', 'CSUN-0276': '482010',
    'CSUN-1552': '61171090', 'DN3093': '61052010', 'DN3224': '61052010',
    'IY3820': '61052010', 'PARK-002': '96081019', 'UG 02': '39241090',
    'UG-DB59': '961700', 'URBAN-294': '73239390', 'URBAN-298': '73239390'
  };
  var norm = {};
  Object.keys(MAP).forEach(function (k) { norm[skuKey_(k)] = MAP[k]; });

  var sh = sheet_('Products');
  var iHsn = SHEETS.Products.indexOf('hsn') + 1;
  if (iHsn < 1) { Logger.log('No hsn column. Run setupRun first.'); return; }

  var rows = readRows_('Products');
  var filled = 0, already = 0, missing = [];
  rows.forEach(function (r, i) {
    var want = norm[skuKey_(r.sku)];
    if (!want) { if (!String(r.hsn || '').trim()) missing.push(String(r.sku)); return; }
    if (String(r.hsn || '').trim()) { already++; return; }
    sh.getRange(i + 2, iHsn).setValue(want);
    filled++;
  });
  CacheService.getScriptCache().remove('catalog_v1');
  Logger.log('HSN filled on ' + filled + ' products, ' + already + ' already had one.');
  Logger.log('Still without an HSN (' + missing.length + '): ' + missing.join(', '));
  Logger.log('NOTE: Sheets stores these as numbers, so a leading-zero code such as 0902 would become 902. Format Products!hsn as plain text before entering one.');
}
