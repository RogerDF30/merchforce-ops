// The real console against Supabase, in a browser. Serve the repo root locally, then:
//   MF_UI_URL=http://127.0.0.1:8911 node supabase/tests/console_ui_test.js
// Needs playwright and a local Chrome. Signs in as the test vendor's admin.
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs'), path = require('path');
const BASE = process.env.MF_UI_URL || 'http://127.0.0.1:8911';
const USERS = JSON.parse(fs.readFileSync(path.join(__dirname, '.test-users.local'), 'utf8'));
const SHOTS = path.join(__dirname, 'ui-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, obs) => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + 'Console :: ' + name + (ok ? '' : '  -> ' + String(obs).slice(0, 200))); };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const panelOk = async (tab) => {
    await page.click(`#tabs .chip[data-t="${tab}"]`);
    await page.waitForFunction((t) => { const p = document.getElementById('p-' + t); return p && !p.querySelector('.spin') && p.innerText.trim().length > 20; }, tab, { timeout: 60000 });
    const txt = await page.innerText('#p-' + tab);
    // a loaded tab has its heading; a failed load is a bare .empty message with no heading
    const ok = await page.evaluate((t) => !!document.querySelector('#p-' + t + ' .panel-head, #p-' + t + ' h2, #p-' + t + ' .stat-row'), tab);
    return { ok, txt };
  };

  await page.goto(BASE + '/admin.html?vendor=mftest');
  await page.fill('#lEmail', USERS.owner.email);
  await page.fill('#lPass', USERS.owner.password);
  await page.click('#loginBtn');
  await page.waitForSelector('#console:not([hidden])', { timeout: 60000 });
  check('Signs in through Supabase', true);
  check('Shows who is signed in', (await page.textContent('#whoami')).includes('Test Owner'), await page.textContent('#whoami'));
  check('No master-key option on the sign-in screen', (await page.$('#useMaster')) === null);
  await page.waitForFunction(() => document.querySelector('#p-enquiries') && !document.querySelector('#p-enquiries .spin'), null, { timeout: 60000 });
  const notices = await page.innerText('#notices').catch(() => '');
  check('In-app notices shown (sheet products to review, image link failed)', /hidden|could not be imported/.test(notices), notices);
  await page.screenshot({ path: path.join(SHOTS, 'console-1-enquiries.png') });

  for (const tab of ['orders', 'returns', 'accounts', 'stock', 'decks', 'users', 'analytics']) {
    const r = await panelOk(tab);
    check(`Tab "${tab}" loads`, r.ok, r.txt.slice(0, 120));
  }
  const decks = await page.innerText('#p-decks');
  check('Decks tab lists the built deck', /Diwali corporate gifting picks|DK-0001/.test(decks), decks.slice(0, 150));

  // orders: an order with a PI shows a working document link
  await page.click('#tabs .chip[data-t="orders"]');
  await page.click('#ordSeg button[data-v="done"]').catch(() => {});
  const piLink = await page.$('#oRows a[href*="/storage/v1/object/sign/"]');
  check('Orders carry signed PI/PO links', !!piLink);

  // review flow from the notice
  const reviewBtn = await page.$('#notices button[data-notice="products_review"]');
  if (reviewBtn) {
    await reviewBtn.click();
    await page.waitForSelector('#cReview #rvKeep', { timeout: 60000 });
    const bar = await page.innerText('#cReview');
    check('Review opens the catalogue filtered, with Show / Keep hidden', /from your stock sheet/.test(bar), bar);
    await page.screenshot({ path: path.join(SHOTS, 'console-2-review.png') });
    await page.click('#rvKeep');
    await page.waitForFunction(() => !document.querySelector('#notices') || !/new product/.test(document.querySelector('#notices').innerText), null, { timeout: 60000 });
    check('Keeping them hidden clears the review notice', true);
  } else {
    check('Review notice present to test the flow', false, 'no products_review notice');
  }

  // settings: sync card with the service account and the shared-sheet setup
  const st = await panelOk('settings');
  check('Settings loads (admin-only data fetched)', st.ok, st.txt.slice(0, 120));
  check('Sync card names the account to share sheets with', st.txt.includes('merchforce-sheets@merchforce.iam.gserviceaccount.com'));
  check('Sheet setup asks for the vendor\'s own sheet link', !!(await page.$('#yTplSheet')));
  check('No connector / push options left', !(await page.$('button[data-conn]')) && !(await page.$('#yLive')));
  await page.screenshot({ path: path.join(SHOTS, 'console-3-settings.png'), fullPage: false });

  // the customer's order page, signed out
  const token = await page.evaluate(() => (A.requests.find((r) => r.pi_url && r.token) || {}).token);
  const cust = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  cust.on('pageerror', (e) => errors.push('order page: ' + e.message));
  await cust.goto(BASE + '/order.html?t=' + token);
  await cust.waitForFunction(() => document.getElementById('main') && /MF-20/.test(document.getElementById('main').innerText), null, { timeout: 60000 });
  check('Customer order page opens from its link, signed out', true);
  check('Customer page offers the PI download', !!(await cust.$('a[href*="/storage/v1/object/sign/"]')));
  await cust.screenshot({ path: path.join(SHOTS, 'order-page.png') });

  check('No JavaScript errors anywhere', errors.length === 0, errors.join(' | '));
  console.log(results.filter(Boolean).length + '/' + results.length + ' console checks passed');
  await browser.close();
})().catch((e) => { console.log('CRASH ' + e.message); process.exit(1); });
