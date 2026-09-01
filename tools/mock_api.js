/**
 * Merchforce local mock — serves the static site plus an in-memory /api
 * that mirrors the Apps Script contract. No Google account needed.
 *
 *   node tools/mock_api.js     → http://localhost:8900
 *   API token: mf-demo-token · Admin key: admin2026
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8900;
const API_TOKEN = 'mf-demo-token';
const ADMIN_PASS = 'admin2026';

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed_products.json'), 'utf8'));

const db = {
  settings: {
    site_name: 'Merchforce', tagline: 'Bulk merchandise, direct from stock',
    access_mode: 'open', show_stock_numbers: 'badge', notify_email: '',
    low_stock_threshold: '25', currency: 'INR', primary_color: '#1a1f36',
    sync_sheet_id: '', sync_tab: '', sync_sku_col: '', sync_stock_col: '', sync_auto: 'off', sync_last: '', sync_maps: '[]',
    mail_mode: 'backend', mail_from_name: '', relay_url: '', relay_secret: ''
  },
  brands: seed.brands.map(b => ({ brand_id: b.id, name: b.name, logo_url: '', description: '', active: 'TRUE', sort: b.sort })),
  products: seed.products.map(p => ({
    sku: p.sku, name: p.name, brand_id: p.brand_id, category: p.category,
    subcategory: p.sub || '', description: p.desc, specs: (p.specs || []).join('|'),
    image_urls: p.image || '', moq: p.moq, gst_rate: 18, hsn: p.hsn || '', mrp: p.mrp || '', lead_time: p.lead,
    on_hand: p.stock, reserved: 0, safety_stock: Math.round(p.stock * 0.03),
    reorder_point: Math.round(p.stock * 0.1), visible: 'TRUE', show_price: 'TRUE'
  })),
  tiers: seed.products.flatMap(p => (p.tiers || []).map(t => ({ sku: p.sku, min_qty: t[0], unit_price: t[1] }))),
  requests: [], lines: [], users: [], events: [], shipments: [], seq: 0
};

// a few demo requests so the admin pipeline isn't empty
(function demoRequests() {
  const mk = (daysAgo, status, company, contact, email, items) => {
    const id = 'MF-2026-' + String(++db.seq).padStart(4, '0');
    const created = new Date(Date.now() - daysAgo * 864e5);
    let total = 0;
    items.forEach(([sku, qty], i) => {
      const price = tierFor(sku, qty);
      total += price * qty;
      db.lines.push({ request_id: id, line: i + 1, sku, name: nameOf(sku), qty, unit_price: price, line_total: price * qty });
    });
    db.requests.push({
      request_id: id, created: created.toISOString(), status, company, contact, email,
      phone: '98' + String(10000000 + daysAgo * 137).slice(0, 8), gstin: '', notes: 'Need branding with our logo.',
      user_email: '', total_est: total, status_dates: JSON.stringify({ New: created.toISOString() }),
      admin_notes: '', updated: created.toISOString(),
      token: 'tok' + id.slice(-4), stock_state: '', folder_id: 'mockfolder',
      pi_number: '', pi_url: '', pi_total: 0, pi_valid_till: '', po_number: '', po_url: '',
      ship_address: '', place_of_supply: ''
    });
    items.forEach(([sku]) => db.events.push({ date: dstr(created), sku, type: 'request', count: 1 }));
  };
  mk(2, 'New', 'Zenith Analytics', 'Priya Sharma', 'priya@zenith.example', [['URBAN-298', 200], ['1953184', 500]]);
  mk(5, 'Accepted', 'Cobalt Systems', 'Arjun Mehta', 'arjun@cobalt.example', [['B30906', 150]]);
  mk(9, 'PI Sent', 'Nimbus Retail', 'Sara Ali', 'sara@nimbus.example', [['BT380BLK130', 300], ['CSUN-0276', 400]]);
  mk(14, 'PI Accepted', 'Vertex Labs', 'Rahul Nair', 'rahul@vertex.example', [['UG 02', 250]]);
  mk(40, 'Delivered', 'Origin Works', 'Dev Patel', 'dev@origin.example', [['DN3224', 500]]);
  mk(70, 'Rejected', 'Halo Fintech', 'Ishita Rao', 'ishita@halo.example', [['PARK-002', 100]]);
  // reserve stock for the confirmed one
  const conf = db.requests.find(r => r.status === 'PI Accepted');
  if (conf) { conf.stock_state = 'reserved';
    db.lines.filter(l => l.request_id === conf.request_id).forEach(l => { prodOf(l.sku).reserved += l.qty; }); }
  // search noise
  ['tumbler','hoodie','power bank','laptop bag','diary'].forEach((t,i)=>{
    for (let d=1; d<60; d+=7+i) db.events.push({ date: dstr(new Date(Date.now()-d*864e5)), sku: t, type: 'search', count: 1+(i%3) });
  });
  ['umbrella','keychain','trophy'].forEach((t,i)=>{
    for (let d=2; d<50; d+=9+i) db.events.push({ date: dstr(new Date(Date.now()-d*864e5)), sku: t, type: 'search_nil', count: 1 });
  });
  // some view/click noise
  db.products.forEach((p, i) => {
    for (let d = 0; d < 80; d += 3 + (i % 5)) {
      db.events.push({ date: dstr(new Date(Date.now() - d * 864e5)), sku: p.sku, type: 'view', count: 1 + ((i * d) % 7) });
    }
  });
})();

function dstr(d) { return d.toISOString().slice(0, 10); }
function prodOf(sku) { return db.products.find(p => p.sku === sku); }
function nameOf(sku) { const p = prodOf(sku); return p ? p.name : sku; }
function tiersOf(sku) { return db.tiers.filter(t => t.sku === sku).map(t => ({ min: t.min_qty, price: t.unit_price, gst: t.gst === undefined ? '' : t.gst })).sort((a, b) => a.min - b.min); }
function tierFor(sku, qty) { let price = 0; tiersOf(sku).forEach(t => { if (qty >= t.min) price = t.price; }); return price || (tiersOf(sku)[0] || {}).price || 0; }
function atp(p) { return Math.max(0, p.on_hand - p.reserved - p.safety_stock); }
function pub(p) {
  const a = atp(p), low = Number(db.settings.low_stock_threshold);
  return {
    sku: p.sku, name: p.name, brand: p.brand_id, category: p.category, subcategory: p.subcategory,
    description: p.description, specs: p.specs.split('|').filter(Boolean),
    images: p.image_urls.split('|').filter(Boolean), moq: p.moq, gst: p.gst_rate,
    lead_time: p.lead_time, mrp: Number(p.mrp) || null, stock: db.settings.show_stock_numbers === 'exact' ? a : null,
    stock_badge: a <= 0 ? 'out' : a <= low ? 'low' : 'in',
    show_price: p.show_price === 'TRUE', tiers: p.show_price === 'TRUE' ? tiersOf(p.sku) : []
  };
}


function orderOut(r) {
  return {
    id: r.request_id, created: r.created, status: r.status, status_dates: JSON.parse(r.status_dates),
    company: r.company, contact: r.contact, email: r.email, phone: r.phone, gstin: r.gstin,
    notes: r.notes, admin_notes: r.admin_notes, ship_address: r.ship_address || '',
    total_est: r.total_est, pi_number: r.pi_number || '', pi_url: r.pi_url || '',
    pi_total: r.pi_total || 0, pi_valid_till: r.pi_valid_till || '',
    po_number: r.po_number || '', po_url: r.po_url || '', token: r.token,
    folder_id: r.folder_id || '', stock_state: r.stock_state || '', place_of_supply: r.place_of_supply || '',
    lines: db.lines.filter(l => l.request_id === r.request_id).map(l => ({
      sku: l.sku, name: l.name, qty: l.qty, unit_price: l.unit_price, line_total: l.line_total,
      list_price: l.list_price || null, gst: l.gst || 0,
      hsn: l.hsn || (prodOf(l.sku) || {}).hsn || '' })),
    shipments: db.shipments.filter(s => s.request_id === r.request_id).map(s => ({
      no: s.shipment_no, date: s.ship_date, carrier: s.carrier, tracking: s.tracking,
      qty: s.qty, note: s.note, status: s.status, delivered_on: s.delivered_on })),
    active: !['Delivered', 'Closed', 'Rejected', 'Declined', 'Expired', 'Cancelled'].includes(r.status)
  };
}

function setStatus(r, status) {
  const want = ['PI Accepted'].includes(status) ? 'reserved'
    : ['PO Received', 'In Production', 'Dispatched', 'Delivered', 'Closed'].includes(status) ? 'deducted'
    : ['Rejected', 'Declined', 'Expired', 'Cancelled'].includes(status) ? '' : null;
  const lines = db.lines.filter(l => l.request_id === r.request_id);
  if (want !== null && want !== r.stock_state) {
    if (want === 'reserved' && r.stock_state === '') {
      const short = lines.filter(l => { const p = prodOf(l.sku); return !p || atp(p) < l.qty; });
      if (short.length) return 'Not enough stock to hold: ' + short.map(l => l.sku).join(', ');
      lines.forEach(l => { prodOf(l.sku).reserved += l.qty; });
    } else if (want === 'deducted' && r.stock_state === 'reserved') {
      lines.forEach(l => { const p = prodOf(l.sku); p.on_hand -= l.qty; p.reserved = Math.max(0, p.reserved - l.qty); });
    } else if (want === '' && r.stock_state === 'reserved') {
      lines.forEach(l => { const p = prodOf(l.sku); p.reserved = Math.max(0, p.reserved - l.qty); });
    }
    r.stock_state = want;
  }
  const d = JSON.parse(r.status_dates); d[status] = new Date().toISOString();
  r.status_dates = JSON.stringify(d); r.status = status;
  return null;
}

const ACTIONS = {
  site: () => ({
    ok: true,
    site: {
      name: db.settings.site_name, tagline: db.settings.tagline, access_mode: db.settings.access_mode,
      show_stock_numbers: db.settings.show_stock_numbers, currency: 'INR', primary_color: db.settings.primary_color
    },
    brands: db.brands.filter(b => b.active === 'TRUE').sort((a, b) => a.sort - b.sort)
      .map(b => ({ id: b.brand_id, name: b.name, logo: b.logo_url, desc: b.description })),
    categories: [...new Set(db.products.filter(p => p.visible === 'TRUE').map(p => p.category))]
      .map(c => ({ name: c, subs: [...new Set(db.products.filter(p => p.category === c && p.subcategory).map(p => p.subcategory))] }))
  }),
  catalog: () => ({ ok: true, products: db.products.filter(p => p.visible === 'TRUE').map(pub) }),
  product: b => { const p = prodOf(b.sku); return p ? { ok: true, product: pub(p) } : { ok: false, error: 'Not found' }; },
  track: b => {
    (b.events || []).forEach(ev => {
      const key = db.events.find(e => e.date === dstr(new Date()) && e.sku === ev.sku && e.type === ev.type);
      if (key) key.count++; else db.events.push({ date: dstr(new Date()), sku: ev.sku, type: ev.type, count: 1 });
    });
    return { ok: true };
  },
  login: b => (b.email && b.password === 'DemoPass2026!')
    ? { ok: true, session: 'mock-session', user: { email: b.email, name: 'Demo Buyer', company: 'Demo Co' } }
    : { ok: false, error: 'Invalid credentials (mock: any email + DemoPass2026!)' },
  request: b => {
    if (!b.company || !b.contact || !b.email) return { ok: false, error: 'Company, contact and email are required' };
    const id = 'MF-2026-' + String(++db.seq).padStart(4, '0');
    let total = 0;
    (b.lines || []).forEach((l, i) => {
      const p = prodOf(l.sku);
      if (!p) return;
      const price = tierFor(l.sku, l.qty);
      total += price * l.qty;
      db.lines.push({ request_id: id, line: i + 1, sku: l.sku, name: p.name, qty: l.qty, unit_price: price,
        line_total: price * l.qty, list_price: price, gst: p.gst_rate, hsn: p.hsn || '' });
    });
    db.requests.push({
      request_id: id, created: new Date().toISOString(), status: 'New', company: b.company,
      contact: b.contact, email: b.email, phone: b.phone || '', gstin: b.gstin || '',
      notes: b.notes || '', user_email: b.user_email || '', total_est: total,
      status_dates: JSON.stringify({ New: new Date().toISOString() }), admin_notes: '', updated: new Date().toISOString()
    });
    return { ok: true, request_id: id, total_est: total };
  },

  adminOrders: () => ({ ok: true, orders: db.requests.map(orderOut).reverse(),
    statuses: ['New','Accepted','PI Sent','PI Accepted','PO Received','In Production','Dispatched','Delivered','Closed'],
    terminal: ['Rejected','Declined','Expired','Cancelled'], site_url: 'http://localhost:8900' }),
  adminRequestDecide: b => {
    const r = db.requests.find(x => x.request_id === b.id);
    if (!r) return { ok: false, error: 'Request not found' };
    setStatus(r, b.accept ? 'Accepted' : 'Rejected');
    return { ok: true, status: r.status };
  },
  adminPiBuild: b => {
    const r = db.requests.find(x => x.request_id === b.id);
    if (!r) return { ok: false, error: 'Request not found' };
    db.lines = db.lines.filter(l => l.request_id !== b.id).concat((b.lines || []).map((l, i) => ({
      request_id: b.id, line: i + 1, sku: l.sku, name: l.name, qty: l.qty,
      unit_price: l.unit_price, line_total: l.qty * l.unit_price,
      list_price: l.list_price || l.unit_price, gst: l.gst,
      hsn: l.hsn || (prodOf(l.sku) || {}).hsn || '' })));
    r.pi_number = r.pi_number || 'PI-2026-' + String(++db.seq).padStart(4, '0');
    r.pi_url = 'https://drive.google.com/file/d/mock-pi/view';
    r.pi_total = Math.round(((b.lines || []).reduce((a, l) => a + l.qty * l.unit_price * (1 + (l.gst || 0) / 100), 0)
      + Number(b.freight || 0) - Number(b.discount || 0)) * 100) / 100;
    r.total_est = r.pi_total;
    r.pi_valid_till = '20 Sep 2026';
    if (b.send !== false) setStatus(r, 'PI Sent');
    return { ok: true, pi_number: r.pi_number, pi_url: r.pi_url, pi_total: r.pi_total, status: r.status };
  },
  adminPiUpload: b => {
    const r = db.requests.find(x => x.request_id === b.id);
    if (!r) return { ok: false, error: 'Request not found' };
    r.pi_number = b.pi_number || 'PI-UP-1'; r.pi_url = 'https://drive.google.com/file/d/mock-pi-up/view';
    if (b.pi_total) { r.pi_total = b.pi_total; r.total_est = b.pi_total; }
    if (b.send !== false) setStatus(r, 'PI Sent');
    return { ok: true, pi_number: r.pi_number, pi_url: r.pi_url };
  },
  adminPoUpload: b => {
    const r = db.requests.find(x => x.request_id === b.id);
    if (!r) return { ok: false, error: 'Request not found' };
    r.po_number = b.po_number || ''; r.po_url = 'https://drive.google.com/file/d/mock-po/view';
    const e = setStatus(r, 'PO Received');
    return e ? { ok: false, error: e } : { ok: true, po_url: r.po_url, status: r.status };
  },
  adminShipmentSave: b => {
    const r = db.requests.find(x => x.request_id === b.id);
    if (!r) return { ok: false, error: 'Request not found' };
    const d = b.shipment || {};
    let no = Number(d.shipment_no) || db.shipments.filter(s => s.request_id === b.id).length + 1;
    const rec = { request_id: b.id, shipment_no: no, ship_date: d.ship_date || dstr(new Date()),
      carrier: d.carrier || '', tracking: d.tracking || '', qty: Number(d.qty || 0),
      note: d.note || '', status: d.status === 'Delivered' ? 'Delivered' : 'Dispatched', delivered_on: '' };
    const i = db.shipments.findIndex(s => s.request_id === b.id && s.shipment_no === no);
    if (i >= 0) db.shipments[i] = rec; else db.shipments.push(rec);
    const all = db.shipments.filter(s => s.request_id === b.id);
    setStatus(r, all.every(s => s.status === 'Delivered') ? 'Delivered' : 'Dispatched');
    return { ok: true, shipments: all, status: r.status };
  },
  adminShipmentDelete: b => {
    db.shipments = db.shipments.filter(s => !(s.request_id === b.id && s.shipment_no === Number(b.shipment_no)));
    return { ok: true, shipments: db.shipments.filter(s => s.request_id === b.id) };
  },
  orderView: b => {
    const r = db.requests.find(x => x.token === b.t);
    if (!r) return { ok: false, error: 'This order link is not valid' };
    return { ok: true, order: orderOut(r), site: { name: db.settings.site_name } };
  },
  orderPiRespond: b => {
    const r = db.requests.find(x => x.token === b.t);
    if (!r) return { ok: false, error: 'This order link is not valid' };
    if (r.status !== 'PI Sent') return { ok: false, error: 'This proforma is not awaiting a decision' };
    const e = setStatus(r, b.accept ? 'PI Accepted' : 'Declined');
    return e ? { ok: false, error: e } : { ok: true, status: r.status };
  },
  orderPoUpload: b => {
    const r = db.requests.find(x => x.token === b.t);
    if (!r) return { ok: false, error: 'This order link is not valid' };
    if (!['PI Accepted', 'PO Received'].includes(r.status)) return { ok: false, error: 'Accept the proforma invoice first' };
    r.po_number = b.po_number || ''; r.po_url = 'https://drive.google.com/file/d/mock-po/view';
    const e = setStatus(r, 'PO Received');
    return e ? { ok: false, error: e } : { ok: true, status: r.status, po_url: r.po_url };
  },
  orderList: () => ({ ok: true, orders: db.requests.map(orderOut).reverse() }),
  adminUnlock: () => ({ ok: true, settings: db.settings, relay_status: db.relayStatus || null }),
  adminRequests: () => ({
    ok: true,
    requests: db.requests.map(r => ({
      id: r.request_id, created: r.created, status: r.status, company: r.company, contact: r.contact,
      email: r.email, phone: r.phone, gstin: r.gstin, notes: r.notes, admin_notes: r.admin_notes,
      total_est: r.total_est, status_dates: JSON.parse(r.status_dates),
      lines: db.lines.filter(l => l.request_id === r.request_id)
    })).reverse()
  }),
  adminRequestUpdate: b => {
    const r = db.requests.find(x => x.request_id === b.id);
    if (!r) return { ok: false, error: 'Request not found' };
    if (b.admin_notes !== undefined) r.admin_notes = b.admin_notes;
    if (b.status && b.status !== r.status) {
      const lines = db.lines.filter(l => l.request_id === b.id);
      if (b.status === 'Confirmed') {
        const short = lines.filter(l => atp(prodOf(l.sku)) < l.qty)
          .map(l => `${l.sku} (need ${l.qty}, ATP ${atp(prodOf(l.sku))})`);
        if (short.length) return { ok: false, error: 'Insufficient stock — offer partial/backorder or requote: ' + short.join(', ') };
        lines.forEach(l => { prodOf(l.sku).reserved += l.qty; });
      }
      if (r.status === 'Confirmed' && (b.status === 'Rejected' || b.status === 'Expired'))
        lines.forEach(l => { prodOf(l.sku).reserved = Math.max(0, prodOf(l.sku).reserved - l.qty); });
      if (b.status === 'Dispatched' && r.status === 'Confirmed')
        lines.forEach(l => { const p = prodOf(l.sku); p.on_hand -= l.qty; p.reserved = Math.max(0, p.reserved - l.qty); });
      const dates = JSON.parse(r.status_dates);
      dates[b.status] = new Date().toISOString();
      r.status_dates = JSON.stringify(dates);
      r.status = b.status;
    }
    return { ok: true, id: b.id, status: r.status };
  },
  adminCatalog: () => ({
    ok: true,
    products: db.products.map(p => ({
      sku: p.sku, name: p.name, brand_id: p.brand_id, category: p.category, subcategory: p.subcategory,
      description: p.description, specs: p.specs, images: p.image_urls.split('|').filter(Boolean),
      moq: p.moq, gst_rate: p.gst_rate, hsn: p.hsn || '', mrp: Number(p.mrp) || '', lead_time: p.lead_time, on_hand: p.on_hand, reserved: p.reserved,
      safety_stock: p.safety_stock, reorder_point: p.reorder_point, atp: atp(p),
      visible: p.visible === 'TRUE', show_price: p.show_price === 'TRUE', tiers: tiersOf(p.sku)
    })),
    brands: db.brands.map(b => ({ id: b.brand_id, name: b.name, logo: b.logo_url, desc: b.description, active: b.active === 'TRUE', sort: b.sort }))
  }),
  adminProductSave: b => {
    const d = b.product;
    if (!d.sku || !d.name) return { ok: false, error: 'SKU and name are required' };
    let p = prodOf(d.sku);
    if (!p) { p = { sku: d.sku, reserved: 0 }; db.products.push(p); }
    Object.assign(p, {
      name: d.name, brand_id: d.brand_id || '', category: d.category || '', subcategory: d.subcategory || '',
      description: d.description || '', specs: d.specs || '', image_urls: (d.images || []).join('|'),
      moq: d.moq || 1, gst_rate: d.gst_rate || 0, hsn: d.hsn || '', mrp: d.mrp || '', lead_time: d.lead_time || '', on_hand: d.on_hand || 0,
      safety_stock: d.safety_stock || 0, reorder_point: d.reorder_point || 0,
      visible: d.visible ? 'TRUE' : 'FALSE', show_price: d.show_price ? 'TRUE' : 'FALSE'
    });
    db.tiers = db.tiers.filter(t => t.sku !== d.sku)
      .concat((d.tiers || []).map(t => ({ sku: d.sku, min_qty: t.min, unit_price: t.price, gst: t.gst === undefined ? '' : t.gst })));
    return { ok: true, sku: d.sku };
  },
  adminProductDelete: b => { const p = prodOf(b.sku); if (!p) return { ok: false, error: 'Not found' }; p.visible = 'FALSE'; return { ok: true }; },
  adminBrandSave: b => {
    const d = b.brand;
    if (!d.name) return { ok: false, error: 'Brand name required' };
    const id = d.id || 'BR-' + d.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    let br = db.brands.find(x => x.brand_id === id);
    if (!br) { br = { brand_id: id }; db.brands.push(br); }
    Object.assign(br, { name: d.name, logo_url: d.logo || '', description: d.desc || '', active: d.active === false ? 'FALSE' : 'TRUE', sort: d.sort || 0 });
    return { ok: true, id };
  },
  adminBrandDelete: b => {
    if (db.products.some(p => p.brand_id === b.id)) return { ok: false, error: 'Brand has products — reassign them first' };
    db.brands = db.brands.filter(x => x.brand_id !== b.id);
    return { ok: true };
  },
  adminImageUpload: b => ({ ok: true, url: 'https://placehold.co/600x600/eef1ff/2447f5?text=' + encodeURIComponent((b.filename || 'img').slice(0, 12)), file_id: 'mock' }),
  adminUsers: () => ({ ok: true, users: db.users }),
  adminUserSave: b => {
    const d = b.user;
    if (!d.email) return { ok: false, error: 'Email required' };
    let u = db.users.find(x => x.email === d.email.toLowerCase());
    if (!u) {
      if (!d.password || d.password.length < 10) return { ok: false, error: 'Password must be 10+ characters' };
      u = { email: d.email.toLowerCase(), created: new Date().toISOString(), last_login: '' };
      db.users.push(u);
    }
    Object.assign(u, { name: d.name || '', company: d.company || '', active: d.active !== false });
    return { ok: true, email: u.email };
  },
  adminAnalytics: b => {
    const days = Number(b.days) || 90, DAY = 864e5, nowMs = Date.now(), cutoff = nowMs - days * DAY;
    const names = Object.fromEntries(db.products.map(p => [p.sku, p.name]));
    const inWin = db.requests.filter(r => new Date(r.created).getTime() >= cutoff);
    const byStatus = {}; let value = 0;
    inWin.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; value += r.total_est; });
    let converted = 0, decided = 0, awaiting = 0, awaitingOld = 0;
    inWin.forEach(r => {
      const conv = ['Confirmed','Dispatched','Closed'].includes(r.status);
      const dead = ['Rejected','Expired'].includes(r.status);
      if (conv) converted++; if (conv || dead) decided++;
      if (r.status === 'New' || r.status === 'Under Review') { awaiting++; if (nowMs - new Date(r.created) > 3*DAY) awaitingOld++; }
    });
    const weeks = {};
    inWin.forEach(r => {
      const d = new Date(r.created); const mon = new Date(d - ((d.getDay()+6)%7)*DAY);
      const k = mon.toISOString().slice(0,10);
      weeks[k] = weeks[k] || { requests: 0, value: 0 };
      weeks[k].requests++; weeks[k].value += r.total_est;
    });
    const trend = Object.keys(weeks).sort().map(k => ({ week: new Date(k).toLocaleDateString('en-IN',{day:'numeric',month:'short'}), requests: weeks[k].requests, value: Math.round(weeks[k].value) }));
    const units = {}, lineValue = {}, ever = {};
    db.lines.forEach(l => {
      ever[l.sku] = 1;
      const r = db.requests.find(x => x.request_id === l.request_id);
      if (!r || new Date(r.created).getTime() < cutoff) return;
      units[l.sku] = (units[l.sku]||0) + l.qty; lineValue[l.sku] = (lineValue[l.sku]||0) + l.line_total;
    });
    const top = obj => Object.keys(obj).map(sku => ({ sku, name: names[sku]||sku, value: obj[sku] })).sort((a,b)=>b.value-a.value).slice(0,8);
    const never = db.products.filter(p => p.visible === 'TRUE' && !ever[p.sku]).map(p => ({ sku: p.sku, name: p.name, category: p.category, moq: p.moq }));
    let views = 0, clicks = 0; const viewed = {}, searches = {}, searchesNil = {};
    db.events.forEach(ev => {
      if (new Date(ev.date).getTime() < cutoff) return;
      if (ev.type === 'view') { views += ev.count; viewed[ev.sku] = (viewed[ev.sku]||0)+ev.count; }
      if (ev.type === 'click') clicks += ev.count;
      if (ev.type === 'search') searches[ev.sku] = (searches[ev.sku]||0)+ev.count;
      if (ev.type === 'search_nil') searchesNil[ev.sku] = (searchesNil[ev.sku]||0)+ev.count;
    });
    const topKeys = obj => Object.keys(obj).map(k => ({ key: k, count: obj[k] })).sort((a,b)=>b.count-a.count).slice(0,10);
    return { ok: true,
      generated_at: new Date().toLocaleString('en-IN'), days,
      requests: { count: inWin.length, value: Math.round(value), average: inWin.length ? Math.round(value/inWin.length) : 0, by_status: byStatus },
      decision: { conversion_rate: decided ? Math.round(converted/decided*100) : null, median_hours_to_quote: 26.4, median_days_to_close: 9.5, awaiting, awaiting_over_3_days: awaitingOld },
      trend,
      products: { top_by_units: top(units), top_by_value: top(lineValue), never_requested: never.slice(0,25), never_requested_total: never.length, catalogue_size: db.products.filter(p=>p.visible==='TRUE').length },
      traffic: { product_views: views, add_to_list: clicks, requests_submitted: inWin.length,
        funnel: [ {step:'Product views',n:views},{step:'Added to request list',n:clicks},{step:'Requests submitted',n:inWin.length},{step:'Confirmed',n:(byStatus.Confirmed||0)+(byStatus.Dispatched||0)+(byStatus.Closed||0)} ],
        top_viewed: topKeys(viewed).map(r => ({ sku: r.key, name: names[r.key]||r.key, count: r.count })),
        top_searches: topKeys(searches), searches_with_nothing: topKeys(searchesNil) } };
  },
  adminSyncPreview: b => (String(b.sheet||'').length > 5
    ? { ok: true, sheet_id: 'mock-sheet-' + String(b.sheet).slice(-6),
        tabs: ['Wenger Stock','Price List'], tab: b.tab || 'Wenger Stock',
        all_tabs: [
          { name: 'Wenger Stock', rows: 3,
            headers: ['WWW','Code','Product Name','MRP','Selling Price Excluding GST','Stock'],
            sample: [['1','611644','MX Cross Body Bag','2100','1000','361']] },
          { name: 'Price List', rows: 25,
            headers: ['Code','Product Name','MRP','DP Excluding GST','Link for photos'],
            sample: [['612264','Wenger MX ECO Waist pack','2200','898','https://drive…'],
                     ['611644','MX Cross Body Bag - 3 Litres','2100','855','https://drive…']] }
        ],
        headers: ['WWW','Code','Product Name','MRP','Selling Price Excluding GST','Stock'],
        sample: [['1','611644','MX Cross Body Bag','2100','1000','361']],
        rows: 3, owner_hint: 'merchforce-backend@companystore.io' }
    : { ok: false, error: 'Paste the supplier sheet link or ID' }),
  adminSyncMapSave: b => {
    const maps = JSON.parse(db.settings.sync_maps || '[]');
    const mode = b.map.mode === 'push' ? 'push' : 'pull';
    const rec = { mode, brand: b.map.brand || '', sheet: b.map.sheet, tab: b.map.tab || '', sku_col: b.map.sku_col || '',
      fields: b.map.fields || (b.map.stock_col ? [{ col: b.map.stock_col, field: 'on_hand' }] : []),
      sources: b.map.sources || [], create_new: !!b.map.create_new,
      push_key: '', headers: null, sample: null, tabs_meta: null, last: null };
    if (mode === 'pull' && !(rec.sources.length || rec.fields.length)) return { ok: false, error: 'Sheet, SKU column and at least one field mapping are required' };
    if (mode === 'push' && !rec.brand) return { ok: false, error: 'A push mapping must be bound to one brand' };
    if (rec.create_new && !rec.brand) return { ok: false, error: 'To auto-create new products, the mapping must be bound to one brand' };
    if (b.index !== undefined && maps[b.index]) {
      rec.last = maps[b.index].last; rec.push_key = maps[b.index].push_key || '';
      rec.headers = maps[b.index].headers || null; rec.sample = maps[b.index].sample || null;
      rec.tabs_meta = maps[b.index].tabs_meta || null;
      maps[b.index] = rec;
    } else maps.push(rec);
    if (mode === 'push' && !rec.push_key) rec.push_key = 'mfp_mock' + Math.random().toString(36).slice(2, 10);
    db.settings.sync_maps = JSON.stringify(maps);
    return { ok: true, maps };
  },
  syncPush: b => {
    const maps = JSON.parse(db.settings.sync_maps || '[]');
    const i = maps.findIndex(x => x.push_key && x.push_key === b.push_key);
    if (i < 0) return { ok: false, error: 'Unknown push key' };
    const tabs = b.tabs && b.tabs.length ? b.tabs : [{ name: '', headers: b.headers || [], rows: b.rows || [] }];
    maps[i].tabs_meta = tabs.map(t => ({ name: String(t.name || ''), headers: (t.headers || []).map(String),
                                         rows: (t.rows || []).length, sample: (t.rows || []).slice(0, 3) }));
    maps[i].headers = maps[i].tabs_meta[0].headers;
    maps[i].sample = maps[i].tabs_meta[0].sample;
    const mapped = ((maps[i].sources || []).length || (maps[i].fields || []).length);
    if (!mapped) {
      maps[i].last = { ts: new Date().toString(), awaiting_mapping: true, error: 'Connected — now map the columns in the admin console', matched: 0, updated: 0, unchanged: 0, created: 0, unknown: 0, off_brand: 0, unknown_skus: [], created_skus: [] };
      db.settings.sync_maps = JSON.stringify(maps);
      return { ok: true, awaiting_mapping: true, tabs: maps[i].tabs_meta.map(t => t.name), headers: maps[i].headers };
    }
    const summary = { ts: new Date().toString(), matched: 3, updated: 1, unchanged: 2, created: 0, unknown: 0, off_brand: 0, unknown_skus: [], created_skus: [], error: null };
    maps[i].last = summary;
    db.settings.sync_maps = JSON.stringify(maps);
    return { ok: true, summary };
  },
  adminSyncMapDelete: b => {
    const maps = JSON.parse(db.settings.sync_maps || '[]');
    maps.splice(b.index, 1);
    db.settings.sync_maps = JSON.stringify(maps);
    return { ok: true, maps };
  },
  adminSyncRun: b => {
    const maps = JSON.parse(db.settings.sync_maps || '[]');
    if (!maps.length) return { ok: false, error: 'No mappings yet — add one first' };
    const idxs = b.index !== undefined ? [b.index] : maps.map((_, i) => i);
    const results = idxs.filter(i => maps[i]).map(i => {
      const summary = { ts: new Date().toString(), matched: 4, updated: 2, unchanged: 2, created: maps[i].create_new ? 2 : 0, created_skus: maps[i].create_new ? ['NEW-101','NEW-102'] : [], unknown: maps[i].create_new ? 0 : 1, off_brand: maps[i].brand ? 1 : 0, unknown_skus: maps[i].create_new ? [] : ['OLD-001'], error: null };
      maps[i].last = summary;
      return { index: i, brand: maps[i].brand, summary };
    });
    db.settings.sync_maps = JSON.stringify(maps);
    return { ok: true, results, maps };
  },
  adminSyncTemplate: () => ({ ok: true, url: 'https://docs.google.com/spreadsheets/d/mock-template', sheet_id: 'mock-template', name: 'Merchforce Stock Template — 31 Aug 2026' }),
  adminSyncSchedule: b => { db.settings.sync_auto = ['live5','hourly','daily'].includes(b.mode) ? b.mode : 'off'; return { ok: true, mode: db.settings.sync_auto }; },
  syncPing: b => ({ ok: true, synced: 1, touched: 2 }),
  adminSettings: b => { if (b.save) Object.assign(db.settings, b.save); return { ok: true, settings: db.settings, relay_status: db.relayStatus || null }; },
  adminMailTest: () => {
    const relay = db.settings.mail_mode === 'relay' && db.settings.relay_url && db.settings.relay_secret;
    db.relayStatus = relay ? { ts: new Date().toString(), ok: true, remaining: 96 } : db.relayStatus || null;
    return { ok: true, to: db.settings.notify_email || 'you@company.com',
             via: relay ? 'relay' : 'backend', status: db.relayStatus };
  },
  adminExportCsv: b => ({ ok: true, filename: 'mock.csv', csv: 'sku,name\n' + db.products.map(p => p.sku + ',' + JSON.stringify(p.name)).join('\n') })
};

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };

http.createServer((req, res) => {
  if (req.url === '/api' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let out;
      try {
        const b = JSON.parse(raw);
        if (b.token !== API_TOKEN) out = { ok: false, error: 'Bad token' };
        else if (b.action && b.action.startsWith('admin') && b.adminKey !== ADMIN_PASS) out = { ok: false, error: 'Bad admin key' };
        else if (ACTIONS[b.action]) out = ACTIONS[b.action](b);
        else out = { ok: false, error: 'Unknown action: ' + b.action };
      } catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const fp = path.join(ROOT, file);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}).listen(PORT, () => console.log(
  `Merchforce mock on http://localhost:${PORT}\n  storefront: /   admin: /admin.html (key: ${ADMIN_PASS})`
));
