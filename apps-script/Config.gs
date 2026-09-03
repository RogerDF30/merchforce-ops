/**
 * Merchforce — Config
 * Single-supplier storefront + admin. GAS backend, Sheet database, Drive assets.
 * Hourglass Essentials Pvt Ltd · CompanyStore.IO
 */

// One-time bootstrap key. Rotate/blank after running setup (see Setup.gs).
var SETUP_KEY = '6a9812e575ac88507aa301aab825c322';

var APP_NAME = 'Merchforce Ops';

// Sheet tab schemas. Column order is the contract — append, never reorder.
var SHEETS = {
  Settings:     ['key', 'value'],
  Brands:       ['brand_id', 'name', 'logo_url', 'description', 'active', 'sort'],
  Products:     ['sku', 'name', 'brand_id', 'category', 'subcategory', 'description',
                 'specs', 'image_urls', 'moq', 'gst_rate', 'lead_time',
                 'on_hand', 'reserved', 'safety_stock', 'reorder_point',
                 'visible', 'show_price', 'created', 'updated', 'mrp', 'hsn',
                 // phase 5 (appended): how the product is replenished
                 'supply_mode', 'vendor', 'vendor_moq', 'batch_qty'],
  PriceTiers:   ['sku', 'min_qty', 'unit_price', 'gst'],
  Requests:     ['request_id', 'created', 'status', 'company', 'contact', 'email',
                 'phone', 'gstin', 'notes', 'user_email', 'total_est',
                 'status_dates', 'admin_notes', 'updated',
                 // order lifecycle (appended — never reorder the columns above)
                 'token', 'folder_id', 'stock_state',
                 'pi_number', 'pi_url', 'pi_file_id', 'pi_total', 'pi_valid_till',
                 'po_number', 'po_url', 'po_file_id', 'ship_address', 'place_of_supply',
                 // phase 2 (appended — never reorder the columns above)
                 'company_id', 'raised_by'],
  Companies:    ['company_id', 'name', 'gstin', 'phone', 'email', 'billing_address',
                 'ship_address', 'state_code', 'owner', 'notes', 'active', 'created', 'updated'],
  Contacts:     ['contact_id', 'company_id', 'name', 'email', 'phone', 'role',
                 'consent', 'consent_ts', 'consent_source', 'unsubscribed', 'created'],
  Decks:        ['deck_id', 'name', 'skus', 'company_id', 'company', 'pdf_url', 'pptx_url',
                 'folder_id', 'created_by', 'created', 'sent_to', 'last_sent'],
  // Supply orders: kind 'make' = a production run, 'buy' = a vendor purchase.
  Supply:       ['so_id', 'kind', 'sku', 'name', 'qty', 'vendor', 'status', 'expected', 'ref',
                 'note', 'created_by', 'created', 'updated', 'received_qty', 'received'],
  RequestLines: ['request_id', 'line', 'sku', 'name', 'qty', 'unit_price', 'line_total',
                 'list_price', 'gst', 'hsn'],
  Shipments:    ['request_id', 'shipment_no', 'ship_date', 'carrier', 'tracking',
                 'qty', 'note', 'status', 'created', 'delivered_on'],
  Users:        ['email', 'name', 'company', 'pass_hash', 'salt', 'active',
                 'created', 'last_login',
                 // staff accounts (appended)
                 'role'],
  Events:       ['date', 'sku', 'type', 'count'],
  StockLog:     ['ts', 'sku', 'delta', 'reason', 'actor'],
  AuditLog:     ['ts', 'actor', 'action', 'ref', 'detail']
};

// Forward-only request lifecycle (industry standard enquiry→confirm flow).
// Rejected/Expired are terminal branches; Confirmed reserves stock,
// Rejected/Expired/Closed release it (see Requests.gs).
/**
 * Order lifecycle. Stock is NOT touched by status alone — see stock_state:
 *   PI Accepted  → reserve (ATP drops, nobody else can be promised it)
 *   PO Received  → deduct  (on hand actually reduces)
 * Any terminal status releases a reservation that was never deducted.
 */
var STATUSES = ['New', 'Accepted', 'PI Sent', 'PI Accepted', 'PO Received',
                'In Production', 'Dispatched', 'Delivered', 'Closed'];
var TERMINAL  = ['Rejected', 'Declined', 'Expired', 'Cancelled'];
var ACTIVE_END = ['Delivered', 'Closed'];   // everything else open = "active order"

var DEFAULT_SETTINGS = {
  site_name: 'Merchforce',
  tagline: 'Bulk merchandise, direct from stock',
  access_mode: 'open',          // open | gated
  show_stock_numbers: 'badge',  // badge | exact
  notify_email: '',             // supplier email for new-request pings
  // Outbound mail: 'backend' = sent by the Merchforce Google account,
  // 'relay' = handed to a small script in the SUPPLIER'S own account so it
  // leaves their address, on their quota (see Mail.gs).
  mail_mode: 'backend',
  mail_from_name: '',
  relay_url: '',
  relay_secret: '',
  low_stock_threshold: '25',
  currency: 'INR',
  // Who issues the proforma invoice — printed on every PI.
  co_name: '', co_address: '', co_state: '', co_state_code: '',
  co_gstin: '', co_pan: '', co_phone: '', co_email: '',
  co_bank: '', co_terms: '', co_logo_url: '', co_sign_url: '',
  pi_prefix: 'PI', pi_validity_days: '15',
  // Deck design: colours as #RRGGBB, layout compact (two products per page or slide) | spacious (one)
  deck_accent: '#2447F5', deck_ink: '#1D1D1F', deck_muted: '#6E6E73', deck_plate: '#F5F5F7', deck_layout: 'compact',
  session_minutes: '30',        // staff sign-in lapses after this much inactivity
  reorder_alert: 'off',         // off | daily: email notify_email when products fall below their reorder point
  site_url: '',   // where order.html lives, for links in emails
  primary_color: '#1a1f36',
  // Supplier stock sync: the supplier keeps managing stock in their OWN
  // Google Sheet; we pull from it (see StockSync.gs).
  sync_sheet_id: '',
  sync_tab: '',
  sync_sku_col: '',
  sync_stock_col: '',
  sync_auto: 'off',             // off | hourly
  sync_last: '',                // JSON summary of the last run (legacy single-sheet)
  sync_maps: '[]'               // JSON array of per-brand mappings (see StockSync.gs)
};

function props_() { return PropertiesService.getScriptProperties(); }

function db_() {
  var id = props_().getProperty('SHEET_ID');
  if (!id) throw new Error('Not set up: SHEET_ID missing. Run setup first.');
  return SpreadsheetApp.openById(id);
}

function getSettings_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('settings');
  if (hit) return JSON.parse(hit);
  var out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  readRows_('Settings').forEach(function (r) { if (r.key) out[r.key] = String(r.value); });
  cache.put('settings', JSON.stringify(out), 300);
  return out;
}

function saveSettings_(patch) {
  var sh = sheet_('Settings');
  var rows = readRows_('Settings');
  Object.keys(patch).forEach(function (k) {
    if (!(k in DEFAULT_SETTINGS)) return;
    var idx = -1;
    rows.forEach(function (r, i) { if (r.key === k) idx = i; });
    if (idx >= 0) sh.getRange(idx + 2, 2).setValue(String(patch[k]));
    else sh.appendRow([k, String(patch[k])]);
  });
  // The catalog payload bakes settings in (stock display, prices), so a
  // settings change must invalidate it too, or the storefront serves the old
  // behaviour for up to 5 minutes.
  var cache = CacheService.getScriptCache();
  cache.remove('settings');
  cache.remove('catalog_v1');
}
