// Drive the Returns flow in the real console against a TEST backend.
// Serve a copy of the site whose CONFIG points at the TEST /exec URL on
// MF_UI_URL (default http://127.0.0.1:8911), then:
//   node tests/returns_ui_test.js <delivered order id>
// Needs the playwright package and a local Chrome. Screenshots land in tests/ui-shots.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const OID = process.argv[2];
const BASE = process.env.MF_UI_URL || 'http://127.0.0.1:8911';
const USER = process.env.MF_STAFF_EMAIL, PASS = process.env.MF_STAFF_PASSWORD;
const SHOTS = path.join(__dirname, 'ui-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, obs) => { results.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + obs)); };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = n => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const toast = async () => (await page.locator('#toast, .toast').first().textContent().catch(() => '')) || '';
  const drawer = page.locator('#mBody');

  await page.goto(BASE + '/admin.html');
  await page.fill('#lEmail', USER);
  await page.fill('#lPass', PASS);
  await page.click('#loginBtn');
  await page.waitForSelector('#console:not([hidden])', { timeout: 60000 });
  check('Staff signs in', true);
  check('Returns tab present', await page.locator('#tabs .chip[data-t="returns"]').count() === 1);

  // open the delivered order from Orders > Completed
  await page.click('#tabs .chip[data-t="orders"]');
  await page.waitForSelector('#ordSeg', { timeout: 60000 });
  await page.click('#ordSeg button[data-v="done"]');
  await page.locator('#oRows tr', { hasText: OID }).click();
  await page.waitForSelector('#oReturn', { timeout: 20000 });
  check('Delivered order shows "Log a return"', true);
  await shot('1-order-drawer');

  await page.click('#oReturn');
  await page.waitForSelector('#rtReason');
  await page.selectOption('#rtReason', 'Damaged');
  await page.fill('#rtQ0', '10');
  await page.fill('#rtNote', 'UI TEST: 10 bottles dented in transit');
  await shot('2-log-return');
  await page.click('#rtSave');
  await page.waitForSelector('#p-returns tr[data-rma]', { timeout: 60000 });
  const row = page.locator('#p-returns tr[data-rma]', { hasText: OID }).first();
  const rid = await row.getAttribute('data-rma');
  check('Return logged and listed on Returns tab as Requested', rid && (await row.textContent()).includes('Requested'), await row.textContent());
  await shot('3-returns-list');

  const reopen = async () => {
    await page.waitForSelector('#p-returns tr[data-rma="' + rid + '"]', { timeout: 60000 });
    await page.waitForTimeout(300);
    await page.click('#p-returns tr[data-rma="' + rid + '"]');
  };
  await reopen();
  await page.waitForSelector('#rtApprove');
  await page.fill('#rtCarrier', 'Delhivery');
  await page.fill('#rtTrack', 'UI-RET-001');
  await page.click('#rtApprove');
  await page.waitForFunction(id => document.querySelector('#p-returns tr[data-rma="' + id + '"]') && document.querySelector('#p-returns tr[data-rma="' + id + '"]').textContent.includes('Approved'), rid, { timeout: 60000 });
  check('Approve moves it to Approved', true);

  await reopen();
  await page.waitForSelector('#rtReceive');
  check('Tracking saved with approval', await page.inputValue('#rtTrack') === 'UI-RET-001', await page.inputValue('#rtTrack'));
  await page.fill('#rvR0', '6');
  await page.fill('#rvS0', '3');
  await page.click('#rtReceive');
  await page.waitForFunction(() => document.querySelector('#mErr') && document.querySelector('#mErr').textContent.length > 0, null, { timeout: 60000 });
  check('Mismatched inspection (6+3 of 10) shows an error', (await page.textContent('#mErr')).includes('must equal'), await page.textContent('#mErr'));
  await page.fill('#rvS0', '4');
  await shot('4-inspection');
  await page.click('#rtReceive');
  await page.waitForFunction(id => document.querySelector('#p-returns tr[data-rma="' + id + '"]') && document.querySelector('#p-returns tr[data-rma="' + id + '"]').textContent.includes('Received'), rid, { timeout: 60000 });
  check('Receive moves it to Received', true);

  await reopen();
  await page.waitForSelector('#rcRes');
  check('Amount hidden until a money resolution is chosen', await page.locator('#rcAmtF').isHidden());
  await page.selectOption('#rcRes', 'Credit note');
  check('Credit note shows amount, reference and document', await page.locator('#rcAmtF').isVisible() && await page.locator('#rcFileF').isVisible());
  await page.click('#rcGo');
  await page.waitForFunction(() => document.querySelector('#mErr').textContent.length > 0, null, { timeout: 60000 });
  check('Closing a credit note without an amount is refused in the UI', (await page.textContent('#mErr')).includes('amount'), await page.textContent('#mErr'));
  await page.fill('#rcAmt', '5280');
  await page.fill('#rcRef', 'CN-UI-001');
  await page.setInputFiles('#rcFile', { name: 'credit-note.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%UI test\n%%EOF') });
  await shot('5-resolve');
  await page.click('#rcGo');
  await page.waitForFunction(id => document.querySelector('#p-returns tr[data-rma="' + id + '"]') === null, rid, { timeout: 60000 });
  check('Closed return leaves the Open view', true);

  await page.click('#retSeg button[data-v="all"]');
  await reopen();
  await page.waitForSelector('text=Resolution');
  const body = await drawer.textContent();
  check('Closed return shows credit note, amount and reference', body.includes('Credit note') && body.includes('5,280') && body.includes('CN-UI-001'), body.slice(0, 300));
  check('Closed return links the document', await page.locator('a', { hasText: 'Open document' }).count() === 1);
  check('Inspection split shown (6 restocked, 4 scrapped)', /6\s*4/.test((await drawer.locator('tbody tr').first().textContent()).replace(/URBAN-294|Ebony|10/g, ' ')));
  await shot('6-closed');

  // order drawer lists its returns
  await page.click('#rtOrder');
  await page.waitForSelector('#oReturns table', { timeout: 60000 });
  check('Order drawer lists its return', (await page.textContent('#oReturns')).includes(rid));
  await shot('7-order-with-return');

  check('No JavaScript errors in the console', errors.length === 0, errors.join(' | '));
  console.log('RID=' + rid);
  console.log(results.filter(r => r.ok).length + '/' + results.length + ' UI checks passed');
  await browser.close();
})().catch(async e => { console.log('CRASH ' + e.message); process.exit(1); });
