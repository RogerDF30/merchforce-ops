/**
 * Merchforce — one-time bootstrap.
 * POST {action:'setup', key:SETUP_KEY} to the /exec URL (or run setupRun from the editor).
 * Creates the dedicated Drive folder, the backend Sheet with all tabs,
 * generates API_TOKEN / PEPPER / ADMIN_PASS, seeds demo data.
 * Idempotent: refuses to run twice unless {force:true}.
 */

function setupRun() { // editor-friendly entry point (runs as owner, so pass the stored admin key)
  var res = setup_({ key: SETUP_KEY, force: true, adminKey: props_().getProperty('ADMIN_PASS') || '' });
  Logger.log(JSON.stringify(res, null, 2));
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
