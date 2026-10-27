// The platform screen and CompanyStore admins, in a browser:
//   MF_UI_URL=http://127.0.0.1:8911 node supabase/tests/platform_ui_test.js
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs'), path = require('path');
const BASE = process.env.MF_UI_URL || 'http://127.0.0.1:8911';
const U = JSON.parse(fs.readFileSync(path.join(__dirname, '.test-users.local'), 'utf8'));
const SHOTS = path.join(__dirname, 'ui-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (n, ok, o) => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + 'Platform :: ' + n + (ok ? '' : '  -> ' + String(o).slice(0, 200))); };
const errors = [];
const watch = (pg) => pg.on('pageerror', (e) => errors.push(e.message));

async function signIn(ctx, who) {
  const page = await ctx.newPage(); watch(page);
  await page.goto(BASE + '/platform.html');
  await page.fill('#lEmail', U[who].email); await page.fill('#lPass', U[who].password); await page.click('#loginBtn');
  return page;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  // a vendor admin is not a platform admin
  let ctx = await browser.newContext();
  let page = await signIn(ctx, 'owner');
  await page.waitForFunction(() => document.getElementById('lockErr').textContent.length > 0, null, { timeout: 60000 });
  check('A supplier admin is refused', /not a CompanyStore platform admin/.test(await page.textContent('#lockErr')));
  await ctx.close();

  // ---- editor
  ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  page = await signIn(ctx, 'platform');
  await page.waitForSelector('#console:not([hidden])', { timeout: 60000 });
  check('Editor signs in; role shown', /editor/.test(await page.textContent('#whoami')), await page.textContent('#whoami'));
  check('Editor sees + New supplier and + Add admin', !(await page.$eval('#newVendor', (e) => e.hidden)) && !(await page.$eval('#newAdmin', (e) => e.hidden)));
  const rows = await page.innerText('#rows');
  check('Suppliers listed with Open console', /mftest/.test(rows) && (await page.$$('#rows a:has-text("Open console")')).length >= 2, rows.slice(0, 100));

  await page.click('#tabs .chip[data-t="catalog"]');
  await page.waitForFunction(() => /products/.test(document.getElementById('cCount').textContent), null, { timeout: 60000 });
  await page.fill('#cQ', 'charger');
  await page.waitForFunction(() => /charger/i.test(document.getElementById('cRows').innerText) && /^\d+ of \d+/.test(document.getElementById('cCount').textContent), null, { timeout: 60000 });
  await page.waitForTimeout(1500);   // let any slower, earlier request land: it must not overwrite the search
  const listed = await page.innerText('#cRows');
  check('Catalogue across suppliers is searchable (only matches shown)', /Charger/i.test(listed) && !/Parker Jotter/.test(listed), await page.textContent('#cCount'));
  await page.screenshot({ path: path.join(SHOTS, 'platform-catalogue.png') });

  await page.click('#tabs .chip[data-t="admins"]');
  await page.waitForFunction(() => document.querySelectorAll('#aRows tr').length > 0, null, { timeout: 60000 });
  const adm = await page.innerText('#aRows');
  check('Admins tab lists editors and viewers', /Editor/.test(adm) && /Viewer/.test(adm), adm.slice(0, 160));
  await page.screenshot({ path: path.join(SHOTS, 'platform-admins.png') });

  // open a supplier console from the platform: already signed in, with the banner
  await page.click('#tabs .chip[data-t="vendors"]');
  const [con] = await Promise.all([ctx.waitForEvent('page'), page.click('#rows tr:has-text("mftest2") a:has-text("Open console")')]);
  watch(con);
  await con.waitForSelector('#console:not([hidden])', { timeout: 60000 });
  await con.waitForFunction(() => /CompanyStore/.test(document.getElementById('notices').innerText), null, { timeout: 60000 });
  check('Open console lands signed in to that supplier', /TEST 2/.test(await con.title()), await con.title());
  check('Banner says a CompanyStore admin is working here', /CompanyStore admin/.test(await con.innerText('#notices')), await con.innerText('#notices'));
  await con.screenshot({ path: path.join(SHOTS, 'platform-acting-console.png') });
  await ctx.close();

  // ---- viewer
  ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  page = await signIn(ctx, 'pviewer');
  await page.waitForSelector('#console:not([hidden])', { timeout: 60000 });
  check('Viewer signs in; shown as view-only', /view-only/.test(await page.textContent('#whoami')), await page.textContent('#whoami'));
  check('Viewer has no create buttons', (await page.$eval('#newVendor', (e) => e.hidden)) && (await page.$eval('#newAdmin', (e) => e.hidden)));
  const [vc] = await Promise.all([ctx.waitForEvent('page'), page.click('#rows tr:has-text("Merchforce TEST") >> nth=0 >> a:has-text("Open console")')]);
  watch(vc);
  await vc.waitForSelector('#console:not([hidden])', { timeout: 60000 });
  await vc.waitForFunction(() => /CompanyStore/.test(document.getElementById('notices').innerText), null, { timeout: 60000 });
  check('Viewer opens a supplier console, marked view-only', /view-only/.test(await vc.innerText('#notices')), await vc.innerText('#notices'));
  await vc.click('#tabs .chip[data-t="catalog"]');
  await vc.waitForSelector('#cRows tr.click', { timeout: 60000 });
  await vc.click('#cRows tr.click >> nth=0');
  await vc.waitForSelector('#eSave', { timeout: 30000 });
  await vc.click('#eSave');
  await vc.waitForFunction(() => document.getElementById('mErr') && document.getElementById('mErr').textContent.length > 0, null, { timeout: 60000 });
  check('Viewer trying to save a product is refused', /view-only/.test(await vc.textContent('#mErr')), await vc.textContent('#mErr'));
  await vc.screenshot({ path: path.join(SHOTS, 'platform-viewer-refused.png') });
  await ctx.close();

  check('No JavaScript errors', errors.length === 0, errors.join(' | '));
  console.log(results.filter(Boolean).length + '/' + results.length + ' platform checks passed');
  await browser.close();
})().catch((e) => { console.log('CRASH ' + e.message); process.exit(1); });
