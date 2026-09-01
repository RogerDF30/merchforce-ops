/** Merchforce — admin console endpoints (all require adminKey) */

function fnAdminUnlock_(p) {
  audit_(p.actor || 'admin', 'admin_unlock', '', '');
  return ok_({ settings: getSettings_(), relay_status: relayStatus_() });
}

function fnAdminCatalog_(p) {
  var tiers = {};
  readRows_('PriceTiers').forEach(function (t) {
    var k = skuKey_(t.sku);
    (tiers[k] = tiers[k] || []).push({
      min: toNum_(t.min_qty), price: toNum_(t.unit_price),
      gst: t.gst === '' || t.gst === undefined ? '' : toNum_(t.gst)
    });
  });
  var products = readRows_('Products').map(function (r) {
    return {
      sku: String(r.sku), name: r.name, brand_id: r.brand_id, category: r.category,
      subcategory: r.subcategory, description: r.description, specs: r.specs,
      images: String(r.image_urls || '').split('|').filter(String),
      moq: toNum_(r.moq), gst_rate: toNum_(r.gst_rate), lead_time: r.lead_time,
      mrp: toNum_(r.mrp) || '',
      hsn: String(r.hsn || ''),
      on_hand: toNum_(r.on_hand), reserved: toNum_(r.reserved),
      safety_stock: toNum_(r.safety_stock), reorder_point: toNum_(r.reorder_point),
      atp: atp_(r), visible: isTrue_(r.visible),
      show_price: isTrue_(r.show_price),
      tiers: (tiers[skuKey_(r.sku)] || []).sort(function (a, b) { return a.min - b.min; })
    };
  });
  var brands = readRows_('Brands').map(function (b) {
    return {
      id: b.brand_id, name: b.name, logo: b.logo_url, desc: b.description,
      active: isTrue_(b.active), sort: toNum_(b.sort)
    };
  });
  return ok_({ products: products, brands: brands });
}

function fnAdminProductSave_(p) {
  var d = p.product || {};
  if (!d.sku || !d.name) return err_('SKU and name are required');
  d.sku = String(d.sku).trim().toUpperCase();
  // RSM discipline: the first tier must start at the MOQ (MOQ 1 for a flat price).
  var moq = toNum_(d.moq) || 1;
  var sortedTiers = (d.tiers || []).slice().sort(function (a, b) { return toNum_(a.min) - toNum_(b.min); });
  if (sortedTiers.length && toNum_(sortedTiers[0].min) !== moq) {
    return err_('The first price tier must start at the MOQ (' + moq + ')');
  }
  d.tiers = sortedTiers;

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rowNum = findRow_('Products', function (r) { return skuKey_(r.sku) === skuKey_(d.sku); });
    var rec = {
      sku: d.sku, name: d.name, brand_id: d.brand_id || '', category: d.category || '',
      subcategory: d.subcategory || '', description: d.description || '',
      specs: d.specs || '', image_urls: (d.images || []).join('|'),
      moq: toNum_(d.moq) || 1, gst_rate: toNum_(d.gst_rate), lead_time: d.lead_time || '',
      mrp: toNum_(d.mrp) || '',
      hsn: String(d.hsn || '').trim(),
      on_hand: toNum_(d.on_hand), reserved: rowNum > 0 ? undefined : 0,
      safety_stock: toNum_(d.safety_stock), reorder_point: toNum_(d.reorder_point),
      visible: d.visible ? 'TRUE' : 'FALSE', show_price: d.show_price ? 'TRUE' : 'FALSE',
      updated: now_()
    };
    if (rowNum > 0) {
      var existing = readRows_('Products')[rowNum - 2];
      rec.reserved = existing.reserved; // stock reservations are lifecycle-owned
      rec.created = existing.created;
      if (toNum_(existing.on_hand) !== rec.on_hand) {
        appendRecord_('StockLog', {
          ts: now_(), sku: d.sku, delta: rec.on_hand - toNum_(existing.on_hand),
          reason: 'manual adjust', actor: p.actor || 'admin'
        });
      }
      writeRecord_('Products', rowNum, rec);
    } else {
      rec.created = now_();
      rec.reserved = 0;
      appendRecord_('Products', rec);
    }

    // replace tiers (per-tier GST optional: blank inherits the product rate)
    replaceChildRows_('PriceTiers', function (r) { return skuKey_(r.sku) === skuKey_(d.sku); },
      (d.tiers || []).map(function (t) {
        return { sku: d.sku, min_qty: toNum_(t.min), unit_price: toNum_(t.price),
                 gst: (t.gst === '' || t.gst === undefined || t.gst === null) ? '' : toNum_(t.gst) };
      }));

    CacheService.getScriptCache().remove('catalog_v1');
    audit_(p.actor || 'admin', 'product_save', d.sku, '');
    return ok_({ sku: d.sku });
  } finally {
    lock.releaseLock();
  }
}

function fnAdminProductDelete_(p) {
  var rowNum = findRow_('Products', function (r) { return skuKey_(r.sku) === skuKey_(p.sku); });
  if (rowNum < 0) return err_('Not found');
  // soft delete: hide, keep history (requests reference the SKU)
  var cols = SHEETS.Products;
  sheet_('Products').getRange(rowNum, cols.indexOf('visible') + 1).setValue('FALSE');
  CacheService.getScriptCache().remove('catalog_v1');
  audit_(p.actor || 'admin', 'product_hide', p.sku, '');
  return ok_();
}

function replaceChildRows_(tab, pred, newRecords) {
  var sh = sheet_(tab);
  var rows = readRows_(tab);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (pred(rows[i])) sh.deleteRow(i + 2);
  }
  newRecords.forEach(function (r) { appendRecord_(tab, r); });
}

function fnAdminBrandSave_(p) {
  var d = p.brand || {};
  if (!d.name) return err_('Brand name required');
  var id = d.id || ('BR-' + String(d.name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8));
  var rowNum = findRow_('Brands', function (r) { return r.brand_id === id; });
  var rec = {
    brand_id: id, name: d.name, logo_url: d.logo || '',
    description: d.desc || '', active: d.active === false ? 'FALSE' : 'TRUE',
    sort: toNum_(d.sort)
  };
  if (rowNum > 0) writeRecord_('Brands', rowNum, rec);
  else appendRecord_('Brands', rec);
  CacheService.getScriptCache().remove('catalog_v1');
  audit_(p.actor || 'admin', 'brand_save', id, '');
  return ok_({ id: id });
}

function fnAdminBrandDelete_(p) {
  var used = readRows_('Products').some(function (r) { return r.brand_id === p.id; });
  if (used) return err_('Brand has products — reassign them first');
  var rowNum = findRow_('Brands', function (r) { return r.brand_id === p.id; });
  if (rowNum < 0) return err_('Not found');
  sheet_('Brands').deleteRow(rowNum);
  audit_(p.actor || 'admin', 'brand_delete', p.id, '');
  return ok_();
}

/** Upload base64 image → Drive Images folder, returns a public thumbnail URL. */
function fnAdminImageUpload_(p) {
  if (!p.data || !p.filename) return err_('data + filename required');
  var bytes = Utilities.base64Decode(String(p.data).replace(/^data:[^;]+;base64,/, ''));
  if (bytes.length > 4 * 1024 * 1024) return err_('Image over 4MB');
  var mime = p.mime || 'image/png';
  var folder = DriveApp.getFolderById(props_().getProperty('IMAGES_FOLDER_ID'));
  var file = folder.createFile(Utilities.newBlob(bytes, mime, p.filename));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var url = 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w1200';
  audit_(p.actor || 'admin', 'image_upload', p.filename, file.getId());
  return ok_({ url: url, file_id: file.getId() });
}

function fnAdminUsers_(p) {
  return ok_({
    users: readRows_('Users').map(function (u) {
      return {
        email: u.email, name: u.name, company: u.company,
        active: isTrue_(u.active),
        created: String(u.created), last_login: String(u.last_login || '')
      };
    })
  });
}

function fnAdminUserSave_(p) {
  var d = p.user || {};
  if (!d.email) return err_('Email required');
  var email = String(d.email).toLowerCase().trim();
  var rowNum = findRow_('Users', function (r) { return String(r.email).toLowerCase() === email; });
  if (rowNum > 0) {
    var u = readRows_('Users')[rowNum - 2];
    u.name = d.name !== undefined ? d.name : u.name;
    u.company = d.company !== undefined ? d.company : u.company;
    if (d.active !== undefined) u.active = d.active ? 'TRUE' : 'FALSE';
    if (d.password) {
      if (String(d.password).length < 10) return err_('Password must be 10+ characters');
      u.salt = randomToken_(12);
      u.pass_hash = hashPassword_(String(d.password), u.salt);
    }
    writeRecord_('Users', rowNum, u);
  } else {
    if (!d.password || String(d.password).length < 10) return err_('Password must be 10+ characters');
    var salt = randomToken_(12);
    appendRecord_('Users', {
      email: email, name: d.name || '', company: d.company || '',
      pass_hash: hashPassword_(String(d.password), salt), salt: salt,
      active: 'TRUE', created: now_(), last_login: ''
    });
  }
  audit_(p.actor || 'admin', 'user_save', email, '');
  return ok_({ email: email });
}

function fnAdminSettings_(p) {
  if (p.save) saveSettings_(p.save);
  return ok_({ settings: getSettings_(), relay_status: relayStatus_() });
}

/** CSV export of any allowed tab (catalog backup / offline edits). */
function fnAdminExportCsv_(p) {
  var allowed = { Products: 1, PriceTiers: 1, Brands: 1, Requests: 1, RequestLines: 1 };
  if (!allowed[p.tab]) return err_('Tab not exportable');
  var cols = SHEETS[p.tab];
  var lines = [cols.join(',')];
  readRows_(p.tab).forEach(function (r) {
    lines.push(cols.map(function (c) {
      var v = String(r[c] === undefined ? '' : r[c]);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(','));
  });
  return ok_({ filename: 'merchforce_' + p.tab.toLowerCase() + '_' + today_() + '.csv', csv: lines.join('\n') });
}

/**
 * Maintenance: collapse duplicate Products rows (same SKU key — Sheets number
 * vs string) keeping the LAST row, and duplicate PriceTiers rows (same
 * sku+min_qty) keeping the last. Idempotent.
 */
function fnAdminDedupe_(p) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var removedP = 0, removedT = 0;
    var sh = sheet_('Products');
    var rows = readRows_('Products');
    var lastIdx = {};
    rows.forEach(function (r, i) { lastIdx[skuKey_(r.sku)] = i; });
    for (var i = rows.length - 1; i >= 0; i--) {
      if (lastIdx[skuKey_(rows[i].sku)] !== i) { sh.deleteRow(i + 2); removedP++; }
    }
    var shT = sheet_('PriceTiers');
    var tRows = readRows_('PriceTiers');
    var lastT = {};
    tRows.forEach(function (t, i) { lastT[skuKey_(t.sku) + '|' + toNum_(t.min_qty)] = i; });
    for (var j = tRows.length - 1; j >= 0; j--) {
      if (lastT[skuKey_(tRows[j].sku) + '|' + toNum_(tRows[j].min_qty)] !== j) { shT.deleteRow(j + 2); removedT++; }
    }
    CacheService.getScriptCache().remove('catalog_v1');
    audit_(p.actor || 'admin', 'dedupe', '', removedP + ' products, ' + removedT + ' tiers removed');
    return ok_({ removed_products: removedP, removed_tiers: removedT });
  } finally {
    lock.releaseLock();
  }
}
