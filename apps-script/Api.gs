/**
 * Merchforce — HTTP router.
 * All calls: POST JSON {token, action, ...} to the /exec URL.
 * Public actions need API_TOKEN. Admin actions additionally need adminKey (ADMIN_PASS).
 * There is no public catalogue: this app is the supplier's backend.
 * doGet serves a health check only.
 */

function doGet() {
  return json_({ ok: true, app: APP_NAME, ts: String(now_()) });
}

function doPost(e) {
  var p;
  try { p = JSON.parse(e.postData.contents); }
  catch (err) { return err_('Bad JSON'); }

  try {
    if (p.action === 'setup') return json_(setup_(p));

    if (String(p.token) !== props_().getProperty('API_TOKEN')) return err_('Bad token');

    // No storefront. The only unauthenticated surfaces left are the customer's
    // own order page, which is authorised by that order's 28-char token, and the
    // sheet-sync hooks, which are authorised by their own push key.
    var PUBLIC = {
      syncPing: fnSyncPing_,
      syncPush: fnSyncPush_,
      orderView:      fnOrderView_,
      orderPiRespond: fnOrderPiRespond_,
      orderPoUpload:  fnOrderPoUpload_
    };
    var ADMIN = {
      adminUnlock:        fnAdminUnlock_,
      adminRequests:      fnAdminRequests_,
      adminRequestUpdate: fnAdminRequestUpdate_,
      adminRequestCreate: fnRequestSubmit_,
      adminCatalog:       fnAdminCatalog_,
      adminProductSave:   fnAdminProductSave_,
      adminProductDelete: fnAdminProductDelete_,
      adminBrandSave:     fnAdminBrandSave_,
      adminBrandDelete:   fnAdminBrandDelete_,
      adminImageUpload:   fnAdminImageUpload_,
      adminUsers:         fnAdminUsers_,
      adminUserSave:      fnAdminUserSave_,
      adminAnalytics:     fnAdminAnalytics_,
      adminSettings:      fnAdminSettings_,
      adminExportCsv:     fnAdminExportCsv_,
      adminSyncPreview:   fnAdminSyncPreview_,
      adminSyncRun:       fnAdminSyncRun_,
      adminSyncSchedule:  fnAdminSyncSchedule_,
      adminSyncMapSave:   fnAdminSyncMapSave_,
      adminSyncMapDelete: fnAdminSyncMapDelete_,
      adminSyncTemplate:  fnAdminSyncTemplate_,
      adminDedupe:        fnAdminDedupe_,
      adminMailTest:      fnAdminMailTest_,
      adminOrders:        fnAdminOrders_,
      adminRequestDecide: fnAdminRequestDecide_,
      adminPiBuild:       fnAdminPiBuild_,
      adminPiUpload:      fnAdminPiUpload_,
      adminPoUpload:      fnAdminPoUpload_,
      adminShipmentSave:  fnAdminShipmentSave_,
      adminShipmentDelete: fnAdminShipmentDelete_
    };

    if (PUBLIC[p.action]) return PUBLIC[p.action](p);
    if (ADMIN[p.action]) {
      if (String(p.adminKey) !== props_().getProperty('ADMIN_PASS')) {
        audit_('anon', 'admin_denied', p.action, '');
        return err_('Bad admin key');
      }
      return ADMIN[p.action](p);
    }
    return err_('Unknown action: ' + p.action);
  } catch (ex) {
    return err_(ex.message || String(ex));
  }
}
