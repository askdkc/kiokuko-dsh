import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium, type Page } from 'playwright'
import { openSettings } from './web-test-navigation.mjs'

// A real browser drives the shell contract that failed in CI: a late onboarding
// close dismisses an already-open account menu before Settings can be clicked.
async function shell(page: Page, options: { interruptions?: number; initialGuide?: boolean; menuOpen?: boolean; legacy?: boolean; missingItem?: boolean; hiddenShell?: boolean; hoverGuide?: boolean; settingsOpen?: boolean } = {}) {
  await page.setContent(`<button id="account" aria-label="Account menu" aria-expanded="${options.menuOpen ? 'true' : 'false'}" ${options.legacy ? 'hidden' : ''} ${options.hiddenShell ? 'aria-hidden="true"' : ''}>Account</button>
    <div id="menu" role="menu" ${options.menuOpen ? '' : 'hidden'}>
      ${options.missingItem ? '' : '<button role="menuitem" id="settings">Settings</button>'}
    </div>
    <button id="legacy" ${options.legacy ? '' : 'hidden'}>Settings</button>
    <div id="guide" role="dialog" aria-label="Get started" ${options.initialGuide ? '' : 'hidden'}
      style="position:fixed;inset:0;background:white;z-index:100"><button id="close" ${options.hoverGuide ? 'style="position:absolute;right:8px;top:8px"' : ''}>Close</button></div>
    <section id="opened" role="dialog" aria-label="Settings" data-shortcut-modal="settings" ${options.settingsOpen ? '' : 'hidden'}>Settings panel</section>
    <script>
      window.navigation = { accountClicks: 0, guideCloses: 0, settingsOpens: ${options.settingsOpen ? 1 : 0} };
      let remaining = ${options.interruptions ?? 0};
      const account = document.querySelector('#account'), menu = document.querySelector('#menu'), guide = document.querySelector('#guide');
      let hoverGuide = ${options.hoverGuide ? 'true' : 'false'};
      account.onpointerover = () => { if (hoverGuide) { hoverGuide = false; guide.hidden = false; } };
      account.onclick = () => {
        window.navigation.accountClicks++;
        menu.hidden = !menu.hidden; account.setAttribute('aria-expanded', String(!menu.hidden));
        if (!menu.hidden && remaining > 0) { remaining--; queueMicrotask(() => { guide.hidden = false }); }
      };
      document.querySelector('#close').onclick = () => {
        window.navigation.guideCloses++; guide.hidden = true; menu.hidden = true; account.setAttribute('aria-expanded', 'false'); account.removeAttribute('aria-hidden');
      };
      for (const button of document.querySelectorAll('#settings, #legacy')) button.onclick = () => {
        window.navigation.settingsOpens++; menu.hidden = true; account.setAttribute('aria-expanded', 'false'); document.querySelector('#opened').hidden = false;
      };
    </script>`)
  const guide = page.getByRole('dialog', { name: 'Get started', exact: true })
  await page.addLocatorHandler(guide, () => guide.getByRole('button', { name: 'Close', exact: true }).click())
}

test('Settings navigation reconciles onboarding and account-menu state', { timeout: 60000 }, async t => {
  const parentExecutable = process.env.KIOKUKO_BROWSER_PARENT_EXECUTABLE
  // This is a subprocess contract fixture; models-web supplies the caller binding.
  assert.ok(parentExecutable, 'models-web must bind the caller browser discovery before spawning its regression')
  assert.equal(chromium.executablePath(), parentExecutable,
    'Browser regression changed caller Playwright cache discovery; a disposable DSH HOME must not hide bundled Chromium')
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  t.after(() => browser.close())
  for (const value of [
    { name: 'late Get started closes the first menu', options: { interruptions: 1 }, clicks: 2, closes: 1 },
    { name: 'successive onboarding interruptions reopen the current menu', options: { interruptions: 2 }, clicks: 3, closes: 2 },
    { name: 'an already-open menu is used without toggling it closed', options: { menuOpen: true }, clicks: 0, closes: 0 },
    { name: 'an already-open Settings dialog needs no account-menu action', options: { settingsOpen: true }, clicks: 0, closes: 0 },
    { name: 'onboarding appearing during the account click stays actionable', options: { hoverGuide: true }, clicks: 1, closes: 1 },
    { name: 'an initially visible guide finishes before Settings', options: { initialGuide: true }, clicks: 1, closes: 1 },
    { name: 'the aria-hidden shell is restored after onboarding', options: { initialGuide: true, hiddenShell: true }, clicks: 1, closes: 1 },
    { name: 'the direct Settings button remains supported', options: { legacy: true, initialGuide: true }, clicks: 0, closes: 1 },
  ]) await t.test(value.name, async () => {
    const page = await browser.newPage(); page.setDefaultTimeout(5000)
    try {
      await shell(page, value.options)
      await openSettings(page, { timeout: 5000 })
      assert.equal(await page.getByRole('dialog', { name: 'Settings', exact: true }).isVisible(), true)
      assert.deepEqual(await page.evaluate(() => (window as any).navigation),
        { accountClicks: value.clicks, guideCloses: value.closes, settingsOpens: 1 })
      if (!value.options.legacy) {
        await page.getByRole('button', { name: 'Account menu', exact: true }).click()
        assert.equal((await page.evaluate(() => (window as any).navigation)).accountClicks, value.clicks + 1, 'navigation handler is removed after success')
      }
    } finally { await page.close() }
  })
  await t.test('a missing Settings entry fails within the action budget', async () => {
    const page = await browser.newPage(); page.setDefaultTimeout(1000)
    try {
      await shell(page, { missingItem: true }); await assert.rejects(openSettings(page, { timeout: 1000 }), /Timeout/)
      const before = (await page.evaluate(() => (window as any).navigation)).accountClicks
      await page.getByRole('button', { name: 'Account menu', exact: true }).click()
      assert.equal((await page.evaluate(() => (window as any).navigation)).accountClicks, before + 1, 'navigation handler is removed after failure')
    }
    finally { await page.close() }
  })
})
