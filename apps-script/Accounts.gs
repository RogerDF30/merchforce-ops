/**
 * Merchforce Ops — account notes and attachments.
 *
 * A company record is thin on purpose; what staff learn about an account over
 * time goes here as dated notes, and the documents that belong to it (GST
 * certificate, rate contract, artwork brief) go to Drive under
 * Merchforce / Accounts / <id name>, with a row per file so the console can
 * list them without walking Drive.
 */

function accountFolder_(company) {
  var root = DriveApp.getFolderById(props_().getProperty('FOLDER_ID'));
  var accounts = ensureChild_(root, 'Accounts');
  return ensureChild_(accounts, String(company.company_id) + ' ' + String(company.name || '').replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60));
}

function companyById_(id) {
  return readRows_('Companies').filter(function (r) { return String(r.company_id) === String(id); })[0] || null;
}

function noteOut_(n) {
  return { id: String(n.note_id), company_id: String(n.company_id), ts: String(n.ts || ''), author: n.author || '', text: String(n.text || '') };
}
function fileOut_(f) {
  return { id: String(f.file_id), company_id: String(f.company_id), name: f.name || '', url: f.url || '', drive_id: f.drive_id || '',
           mime: f.mime || '', size: toNum_(f.size), uploaded_by: f.uploaded_by || '', ts: String(f.ts || '') };
}

function fnAdminAccountNotes_(p) {
  if (!companiesReady_()) return err_(NOT_READY_);
  var id = String(p.company_id || '');
  if (!id) return err_('company_id required');
  return ok_({
    notes: readRows_('AccountNotes').filter(function (n) { return String(n.company_id) === id; }).map(noteOut_).reverse(),
    files: readRows_('AccountFiles').filter(function (f) { return String(f.company_id) === id; }).map(fileOut_).reverse()
  });
}

function fnAdminAccountNoteSave_(p) {
  if (!companiesReady_()) return err_(NOT_READY_);
  var text = String(p.text || '').trim().slice(0, 4000);
  if (!text) return err_('Write something first');
  if (p.id) {
    var rowNum = findRow_('AccountNotes', function (n) { return String(n.note_id) === String(p.id); });
    if (rowNum < 0) return err_('Note not found');
    var rec = readRows_('AccountNotes')[rowNum - 2];
    rec.text = text;
    writeRecord_('AccountNotes', rowNum, rec);
    audit_(p.actor || 'admin', 'account_note_edit', rec.company_id, rec.note_id);
    return ok_({ note: noteOut_(rec) });
  }
  if (!companyById_(p.company_id)) return err_('Account not found');
  var n = { note_id: nextId_('AccountNotes', 'note_id', 'NT'), company_id: String(p.company_id), ts: now_(), author: p.actor || 'admin', text: text };
  appendRecord_('AccountNotes', n);
  audit_(p.actor || 'admin', 'account_note', n.company_id, n.note_id);
  return ok_({ note: noteOut_(n) });
}

function fnAdminAccountNoteDelete_(p) {
  var rowNum = findRow_('AccountNotes', function (n) { return String(n.note_id) === String(p.id); });
  if (rowNum < 0) return err_('Note not found');
  sheet_('AccountNotes').deleteRow(rowNum);
  audit_(p.actor || 'admin', 'account_note_delete', '', String(p.id));
  return ok_({});
}

/** Body: {company_id, filename, mime, data (base64, optional data: prefix)}. 10 MB cap. */
function fnAdminAccountFileUpload_(p) {
  if (!companiesReady_()) return err_(NOT_READY_);
  var co = companyById_(p.company_id);
  if (!co) return err_('Account not found');
  if (!p.data || !p.filename) return err_('data + filename required');
  var bytes = Utilities.base64Decode(String(p.data).replace(/^data:[^;]+;base64,/, ''));
  if (bytes.length > 10 * 1024 * 1024) return err_('File over 10MB');
  var mime = p.mime || 'application/octet-stream';
  var file = accountFolder_(co).createFile(Utilities.newBlob(bytes, mime, String(p.filename).slice(0, 120)));
  var rec = { file_id: nextId_('AccountFiles', 'file_id', 'AF'), company_id: String(co.company_id), name: file.getName(),
              url: publicFileUrl_(file), drive_id: file.getId(), mime: mime, size: bytes.length,
              uploaded_by: p.actor || 'admin', ts: now_() };
  appendRecord_('AccountFiles', rec);
  audit_(p.actor || 'admin', 'account_file', rec.company_id, rec.name);
  return ok_({ file: fileOut_(rec) });
}

function fnAdminAccountFileDelete_(p) {
  var rowNum = findRow_('AccountFiles', function (f) { return String(f.file_id) === String(p.id); });
  if (rowNum < 0) return err_('File not found');
  var rec = readRows_('AccountFiles')[rowNum - 2];
  try { if (rec.drive_id) DriveApp.getFileById(rec.drive_id).setTrashed(true); } catch (e) {}
  sheet_('AccountFiles').deleteRow(rowNum);
  audit_(p.actor || 'admin', 'account_file_delete', rec.company_id, rec.name);
  return ok_({});
}
