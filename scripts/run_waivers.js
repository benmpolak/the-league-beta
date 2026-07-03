// Unattended waiver processing — Draft Fantasy parity for Tue/Fri 10:00 UTC.
// Runs in CI (see .github/workflows/waivers.yml): loads the LIVE site in a
// headless browser, acts as the commissioner's device, and lets the app's own
// processWaivers() do the work — zero duplicated game logic. If a real device
// already ran them, waiverRunDue() is false and this exits quietly.
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const p = await browser.newPage();
  p.on('dialog', d => d.dismiss()); // never confirm restore-local-state prompts from CI
  p.on('console', m => console.log('[page]', m.text().slice(0, 160)));
  await p.goto('https://benmpolak.github.io/the-league/', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000)); // let Firebase sync settle

  const result = await p.evaluate(() => {
    if (typeof state === 'undefined') return { err: 'app did not boot' };
    if (state.phase !== 'season') return { skip: `phase is ${state.phase}` };
    if (waiverControl() !== 'auto') return { skip: `waiver control is ${waiverControl()}` };
    if (!waiverRunDue()) return { skip: 'no run due — a live device beat us to it' };
    whoami = state.managers[0].id; // the commissioner's CI stand-in
    const before = state.transfers.length;
    processWaivers(false);
    return { ran: true, executed: state.transfers.length - before };
  });
  console.log(JSON.stringify(result));
  await new Promise(r => setTimeout(r, 4000)); // let pushShared writes flush
  await browser.close();
  if (result.err) process.exit(1);
})().catch(e => { console.error('waiver runner failed:', e.message); process.exit(1); });
