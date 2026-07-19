// Unattended waiver processing — Draft Fantasy parity for Tue/Fri 10:00 UTC.
// The runner uses the live app's game logic, but only reports success after the
// new waiver timestamp has round-tripped through Firebase. A prerequisite or
// write failure must fail the Action loudly; a green-but-skipped run is worse.
const puppeteer = require('puppeteer-core');

const chromePath = process.env.CHROME_BIN
  || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox'],
  });
  try {
    const p = await browser.newPage();
    p.on('dialog', d => d.dismiss());
    p.on('console', m => console.log('[page]', m.text().slice(0, 160)));
    await p.goto('https://benmpolak.github.io/the-league/', {
      waitUntil: 'networkidle2', timeout: 60000,
    });

    try {
      await p.waitForFunction(
        () => typeof cloudKnown !== 'undefined' && cloudKnown
          && state.lastSync
          && Object.keys(state.matchStats || {}).length > 0,
        { timeout: 45000, polling: 1000 });
    } catch {
      throw new Error('cloud state or score feed did not become ready');
    }

    const start = await p.evaluate(() => {
      if (typeof state === 'undefined') return { error: 'app did not boot' };
      if (state.phase !== 'season') return { legitimateSkip: `phase is ${state.phase}` };
      if (waiverControl() !== 'auto') return { legitimateSkip: `waiver control is ${waiverControl()}` };
      if (!waiverRunDue()) return { legitimateSkip: 'no run due — a live device beat us to it' };
      if (typeof cloudKnown === 'undefined' || !cloudKnown) return { error: 'cloud not loaded' };
      if (!Object.keys(state.matchStats || {}).length) return { error: 'score feed empty' };

      whoami = state.managers[0].id;
      const beforeRun = state.waiverMeta?.lastRun || null;
      const beforeTransfers = state.transfers.length;
      processWaivers(false);
      return { started: true, beforeRun, beforeTransfers };
    });

    if (start.error) throw new Error(start.error);
    if (start.legitimateSkip) {
      console.log(JSON.stringify(start));
      return;
    }

    try {
      await p.waitForFunction(
        before => !!state.waiverMeta?.lastRun && state.waiverMeta.lastRun !== before,
        { timeout: 20000, polling: 250 }, start.beforeRun);
    } catch {
      throw new Error('waiver write did not commit within 20 seconds');
    }

    const finish = await p.evaluate(beforeTransfers => ({
      ran: true,
      lastRun: state.waiverMeta.lastRun,
      executed: Math.max(0, state.transfers.length - beforeTransfers),
    }), start.beforeTransfers);
    console.log(JSON.stringify(finish));
  } finally {
    await browser.close();
  }
})().catch(e => {
  console.error('waiver runner failed:', e.message);
  process.exit(1);
});
