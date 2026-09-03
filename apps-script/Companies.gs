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
  return !!(ss.getSheetByName('Companies') && ss.getSheetByName('Contacts'));
}
var NOT_READY_ = 'The Companies and Contacts tabs do not exist in the sheet yet. ' +
  'Open the Apps Script editor and run setupRun once — it appends the new tabs and columns and leaves existing data alone.';

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

  var companies = readRows_('Companies').map(function (r) {
    var id = String(r.company_id);
    return {
      id: id, name: r.name, gstin: r.gstin, phone: r.phone, email: r.email,
      billing_address: r.billing_address, ship_address: r.ship_address,
      state_code: r.state_code, owner: r.owner, notes: r.notes,
      active: isTrue_(r.active), created: String(r.created || ''),
      contacts: byCo[id] || 0, orders: orders[id] || 0, value: Math.round(value[id] || 0)
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
    var rec = {
      company_id: id, name: String(d.name).trim(), gstin: String(d.gstin || '').trim().toUpperCase(),
      phone: d.phone || '', email: d.email || '',
      billing_address: d.billing_address || '', ship_address: d.ship_address || '',
      state_code: String(d.state_code || '').trim(), owner: d.owner || '', notes: d.notes || '',
      active: d.active === false ? 'FALSE' : 'TRUE', updated: now_()
    };
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
