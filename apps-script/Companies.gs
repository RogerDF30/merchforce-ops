/**
 * Merchforce Ops — companies and their contacts.
 *
 * With no storefront there is no buyer account, so a customer is a Company
 * record here plus the people at it. Orders attach to a company instead of
 * repeating a free-text company name, which is what makes customer analytics
 * and campaign targeting possible at all.
 *
 * Consent lives on the contact, not the company. A person who appears on an
 * order has a business relationship with us; that is not marketing consent,
 * so imported contacts start without it and campaigns skip them until someone
 * records one. See DPDP Act 2023.
 */

function nextId_(tab, col, prefix) {
  var max = 0;
  readRows_(tab).forEach(function (r) {
    var m = String(r[col] || '').match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + '-' + ('0000' + (max + 1)).slice(-4);
}

function companyKey_(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, '');
}

/* ---------------- read ---------------- */

/** The new tabs reach a live sheet through setup_, so say so rather than throwing. */
function companiesReady_() {
  var ss = db_();
  var co = ss.getSheetByName('Companies');
  if (!co || !ss.getSheetByName('Contacts') || !ss.getSheetByName('AccountNotes') || !ss.getSheetByName('AccountFiles')) return false;
  var hdr = co.getRange(1, 1, 1, Math.max(1, co.getLastColumn())).getValues()[0];
  return hdr.indexOf('ship_country') >= 0;
}
var NOT_READY_ = 'The account tabs and columns do not exist in the sheet yet. ' +
  'Open the Apps Script editor and run setupRun once — it appends the new tabs and columns and leaves existing data alone.';

function addr_(a) {
  return { line1: String(a.line1 || '').trim(), line2: String(a.line2 || '').trim(), city: String(a.city || '').trim(),
           state: String(a.state || '').trim(), pin: String(a.pin || '').trim(), country: String(a.country || '').trim() || 'India' };
}
function addrText_(a) {
  return [a.line1, a.line2, a.city, [a.state, a.pin].filter(String).join(' '), a.country].filter(String).join(', ');
}
function stateCodeByName_(name) {
  var k = String(name || '').trim().toLowerCase();
  if (!k) return '';
  var out = '';
  Object.keys(GST_STATES).forEach(function (code) { if (GST_STATES[code].toLowerCase() === k) out = code; });
  return out;
}
function addrOut_(r, pfx) {
  return { line1: r[pfx + '_line1'] || '', line2: r[pfx + '_line2'] || '', city: r[pfx + '_city'] || '',
           state: r[pfx + '_state'] || '', pin: String(r[pfx + '_pin'] || ''), country: r[pfx + '_country'] || '' };
}

function fnAdminCompanies_(p) {
  if (!companiesReady_()) return err_(NOT_READY_);
  var requests = readRows_('Requests');
  var orders = {}, value = {};
  requests.forEach(function (r) {
    var id = String(r.company_id || '');
    if (!id) return;
    orders[id] = (orders[id] || 0) + 1;
    value[id] = (value[id] || 0) + (toNum_(r.pi_total) || toNum_(r.total_est));
  });

  var contacts = readRows_('Contacts').map(function (c) {
    return {
      id: String(c.contact_id), company_id: String(c.company_id), name: c.name,
      email: c.email, phone: c.phone, role: c.role,
      consent: isTrue_(c.consent), consent_ts: String(c.consent_ts || ''),
      consent_source: c.consent_source || '', unsubscribed: isTrue_(c.unsubscribed),
      created: String(c.created || '')
    };
  });
  var byCo = {};
  contacts.forEach(function (c) { byCo[c.company_id] = (byCo[c.company_id] || 0) + 1; });
  var noteCount = {}, fileCount = {};
  if (db_().getSheetByName('AccountNotes')) readRows_('AccountNotes').forEach(function (n) { noteCount[String(n.company_id)] = (noteCount[String(n.company_id)] || 0) + 1; });
  if (db_().getSheetByName('AccountFiles')) readRows_('AccountFiles').forEach(function (f) { fileCount[String(f.company_id)] = (fileCount[String(f.company_id)] || 0) + 1; });

  var companies = readRows_('Companies').map(function (r) {
    var id = String(r.company_id);
    return {
      id: id, name: r.name, gstin: r.gstin, phone: r.phone, email: r.email,
      billing_address: r.billing_address, ship_address: r.ship_address,
      state_code: r.state_code, owner: r.owner, owner_email: String(r.owner_email || '').toLowerCase(), notes: r.notes,
      bill: addrOut_(r, 'bill'), ship: addrOut_(r, 'ship'), ship_same: r.ship_same === '' || r.ship_same === undefined ? true : isTrue_(r.ship_same),
      active: isTrue_(r.active), created: String(r.created || ''),
      contacts: byCo[id] || 0, orders: orders[id] || 0, value: Math.round(value[id] || 0),
      notes_count: noteCount[id] || 0, files_count: fileCount[id] || 0
    };
  }).sort(function (a, b) { return b.value - a.value || String(a.name).localeCompare(String(b.name)); });

  // Orders raised before companies existed, so the console can offer the import.
  var unlinked = {};
  requests.forEach(function (r) {
    if (String(r.company_id || '')) return;
    var k = companyKey_(r.company);
    if (!k) return;
    unlinked[k] = (unlinked[k] || 0) + 1;
  });

  return ok_({
    companies: companies,
    contacts: contacts,
    unlinked_names: Object.keys(unlinked).length,
    unlinked_orders: Object.keys(unlinked).reduce(function (a, k) { return a + unlinked[k]; }, 0)
  });
}

/* ---------------- write ---------------- */

function fnAdminCompanySave_(p) {
  if (!companiesReady_()) return err_(NOT_READY_);
  var d = p.company || {};
  if (!d.name) return err_('Company name is required');
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var id = d.id || nextId_('Companies', 'company_id', 'CO');
    var rowNum = findRow_('Companies', function (r) { return String(r.company_id) === String(id); });
    var bill = addr_(d.bill || {}), ship = d.ship_same === false ? addr_(d.ship || {}) : bill;
    // Composed strings stay in the legacy columns: the PI and the order page print those.
    var billText = addrText_(bill) || String(d.billing_address || '');
    var shipText = d.ship_same === false ? (addrText_(ship) || String(d.ship_address || '')) : billText;
    var stateCode = String(d.state_code || '').trim() || stateCodeByName_(bill.state) || stateCodeOf_(d.gstin);
    var rec = {
      company_id: id, name: String(d.name).trim(), gstin: String(d.gstin || '').trim().toUpperCase(),
      phone: d.phone || '', email: d.email || '',
      billing_address: billText, ship_address: shipText,
      state_code: stateCode, owner: d.owner || '', notes: d.notes || '',
      active: d.active === false ? 'FALSE' : 'TRUE', updated: now_(),
      owner_email: String(d.owner_email || '').toLowerCase().trim(),
      bill_line1: bill.line1, bill_line2: bill.line2, bill_city: bill.city, bill_state: bill.state, bill_pin: bill.pin, bill_country: bill.country,
      ship_same: d.ship_same === false ? 'FALSE' : 'TRUE',
      ship_line1: ship.line1, ship_line2: ship.line2, ship_city: ship.city, ship_state: ship.state, ship_pin: ship.pin, ship_country: ship.country
    };
    if (rec.owner_email) {
      var ou = readRows_('Users').filter(function (u) { return String(u.email).toLowerCase() === rec.owner_email; })[0];
      if (ou) rec.owner = ou.name || ou.email;
    }
    if (rowNum > 0) {
      rec.created = readRows_('Companies')[rowNum - 2].created;
      writeRecord_('Companies', rowNum, rec);
    } else {
      rec.created = now_();
      appendRecord_('Companies', rec);
    }
    audit_(p.actor || 'admin', 'company_save', id, rec.name);
    return ok_({ id: id });
  } finally { lock.releaseLock(); }
}

function fnAdminCompanyDelete_(p) {
  var used = readRows_('Requests').some(function (r) { return String(r.company_id) === String(p.id); });
  if (used) return err_('This company has orders against it. Deactivate it instead.');
  var rowNum = findRow_('Companies', function (r) { return String(r.company_id) === String(p.id); });
  if (rowNum < 0) return err_('Company not found');
  sheet_('Companies').deleteRow(rowNum);
  // its people go with it
  var sh = sheet_('Contacts');
  var rows = readRows_('Contacts');
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].company_id) === String(p.id)) sh.deleteRow(i + 2);
  }
  audit_(p.actor || 'admin', 'company_delete', p.id, '');
  return ok_({ id: p.id });
}

function fnAdminContactSave_(p) {
  if (!companiesReady_()) return err_(NOT_READY_);
  var d = p.contact || {};
  if (!d.company_id) return err_('A contact must belong to a company');
  if (!d.name && !d.email) return err_('Give the contact a name or an email');
  if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(d.email))) return err_('Invalid email');

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var id = d.id || nextId_('Contacts', 'contact_id', 'CT');
    var rowNum = findRow_('Contacts', function (r) { return String(r.contact_id) === String(id); });
    var existing = rowNum > 0 ? readRows_('Contacts')[rowNum - 2] : null;

    // Consent is only meaningful with a record of when and where it came from.
    var consent = !!d.consent;
    var hadConsent = existing ? isTrue_(existing.consent) : false;
    var rec = {
      contact_id: id, company_id: String(d.company_id), name: d.name || '',
      email: String(d.email || '').trim(), phone: d.phone || '', role: d.role || '',
      consent: consent ? 'TRUE' : 'FALSE',
      consent_ts: consent ? (hadConsent && existing ? existing.consent_ts : now_()) : '',
      consent_source: consent ? (d.consent_source || (hadConsent && existing ? existing.consent_source : 'recorded in console')) : '',
      unsubscribed: d.unsubscribed ? 'TRUE' : 'FALSE'
    };
    if (rowNum > 0) {
      rec.created = existing.created;
      writeRecord_('Contacts', rowNum, rec);
    } else {
      rec.created = now_();
      appendRecord_('Contacts', rec);
    }
    audit_(p.actor || 'admin', 'contact_save', id, rec.email || rec.name);
    return ok_({ id: id });
  } finally { lock.releaseLock(); }
}

function fnAdminContactDelete_(p) {
  var rowNum = findRow_('Contacts', function (r) { return String(r.contact_id) === String(p.id); });
  if (rowNum < 0) return err_('Contact not found');
  sheet_('Contacts').deleteRow(rowNum);
  audit_(p.actor || 'admin', 'contact_delete', p.id, '');
  return ok_({ id: p.id });
}

/* ---------------- import from existing orders ---------------- */

/**
 * Orders raised before this tab existed carry a free-text company name. Group
 * them, create one Company each, stamp company_id back onto every request, and
 * lift the contact from the most recent order at that company.
 *
 * Idempotent: requests that already carry a company_id are left alone, and an
 * existing company with the same normalised name is reused rather than doubled.
 */
function fnAdminCompanyImport_(p) {
  if (!companiesReady_()) return err_(NOT_READY_);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var existing = {};
    readRows_('Companies').forEach(function (c) { existing[companyKey_(c.name)] = String(c.company_id); });

    var requests = readRows_('Requests');
    var groups = {};
    requests.forEach(function (r, i) {
      if (String(r.company_id || '')) return;
      var k = companyKey_(r.company);
      if (!k) return;
      (groups[k] = groups[k] || { rows: [], recs: [] });
      groups[k].rows.push(i + 2);
      groups[k].recs.push(r);
    });

    var sh = sheet_('Requests');
    var iCompanyId = SHEETS.Requests.indexOf('company_id') + 1;
    if (iCompanyId < 1) return err_('Run setup once to add the company_id column');

    var madeCo = 0, madeCt = 0, linked = 0;
    var contactSeen = {};
    readRows_('Contacts').forEach(function (c) {
      contactSeen[String(c.company_id) + '|' + String(c.email).toLowerCase()] = 1;
    });

    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      // most recent order carries the freshest details
      var latest = g.recs.slice().sort(function (a, b) {
        return new Date(b.created).getTime() - new Date(a.created).getTime();
      })[0];

      var id = existing[k];
      if (!id) {
        id = nextId_('Companies', 'company_id', 'CO');
        appendRecord_('Companies', {
          company_id: id, name: String(latest.company).trim(), gstin: latest.gstin || '',
          phone: latest.phone || '', email: latest.email || '',
          billing_address: '', ship_address: latest.ship_address || '',
          state_code: latest.place_of_supply || '', owner: '',
          notes: 'Imported from order history', active: 'TRUE',
          created: now_(), updated: now_()
        });
        existing[k] = id;
        madeCo++;
      }

      g.rows.forEach(function (rowNum) { sh.getRange(rowNum, iCompanyId).setValue(id); linked++; });

      var email = String(latest.email || '').trim();
      if (email && !contactSeen[id + '|' + email.toLowerCase()]) {
        appendRecord_('Contacts', {
          contact_id: nextId_('Contacts', 'contact_id', 'CT'),
          company_id: id, name: latest.contact || '', email: email,
          phone: latest.phone || '', role: '',
          // An order is a business relationship, not marketing consent.
          consent: 'FALSE', consent_ts: '', consent_source: '',
          unsubscribed: 'FALSE', created: now_()
        });
        contactSeen[id + '|' + email.toLowerCase()] = 1;
        madeCt++;
      }
    });

    audit_(p.actor || 'admin', 'company_import', '', madeCo + ' companies, ' + madeCt + ' contacts, ' + linked + ' orders linked');
    return ok_({ companies_created: madeCo, contacts_created: madeCt, orders_linked: linked });
  } finally { lock.releaseLock(); }
}
