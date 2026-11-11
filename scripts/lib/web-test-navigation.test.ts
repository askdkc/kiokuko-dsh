import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium, type Page } from 'playwright'
import { answerFixtureQuestions, declineOptionalMemoryOffers, declinePendingMemoryOffer, fixtureQuestionCardsVisible, installFixtureQuestionAnswers, openSettings } from './web-test-navigation.mjs'

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
  for (const intercepted of [false, true]) await t.test(`explicit memory decline with auto-handler ${intercepted ? 'installed' : 'absent'}`, async () => {
    const page = await browser.newPage(); page.setDefaultTimeout(1000)
    try {
      await page.setContent(`<section id="offer" role="region" aria-label="Memory offer"><button id="decline">今回は保存しない</button><button id="confirm" disabled>確定（Enter）</button></section>
        <input aria-label="Composer" value="do not send"><button id="next">Next action</button>
        <script>
          window.declines = 0; window.submissions = 0;
          document.querySelector('#decline').onclick = event => { event.target.setAttribute('aria-pressed', 'true'); document.querySelector('#confirm').disabled = false; };
          document.querySelector('#decline').onkeydown = event => { if (event.key === 'Enter') event.preventDefault(); };
          document.querySelector('#confirm').onclick = () => { window.declines++; document.querySelector('#offer').hidden = true; document.querySelector('#confirm').disabled = true; };
          document.querySelector('input').onkeydown = event => { if (event.key === 'Enter') window.submissions++; };
        </script>`)
      const state = intercepted ? await declineOptionalMemoryOffers(page) : undefined
      await declinePendingMemoryOffer(page, { timeout: 2000 })
      assert.equal(await page.locator('#offer').isVisible(), false)
      assert.equal(await page.evaluate(() => (window as any).declines), 1)
      // An explicit answer must leave the automatic handler available for later offers.
      if (state) {
        await page.evaluate(() => { document.querySelector<HTMLElement>('#offer')!.hidden = false })
        await page.getByRole('button', { name: 'Next action' }).click()
        assert.equal(state.declined, 1)
        assert.equal(await page.evaluate(() => (window as any).declines), 2)
      }
      assert.equal(await page.evaluate(() => (window as any).submissions), 0)
    } finally { await page.close() }
  })
})

for (const mode of ['poll', 'handler']) test(`fixture question ${mode} defers an offer covered by the mobile drawer`, { timeout: 35000 }, async t => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(2000)
  await page.setContent(`<main id="frame" data-sidebar-drawer>
    <aside id="drawer" style="position:fixed;inset:0;background:white;z-index:71"><button id="close">Close sidebar</button></aside>
    <section id="offer" role="region" aria-label="作業は完了しました。今回の記憶を整理してよいですか？">
      <button id="decline">今回は保存しない</button><button id="confirm" disabled>確定（Enter）</button>
    </section>
    <button id="next">Next action</button>
    </main><script>
      window.declines = 0;
      document.querySelector('#close').onclick = () => { document.querySelector('#frame').setAttribute('data-sidebar-collapsed', ''); document.querySelector('#drawer').hidden = true; };
      document.querySelector('#decline').onclick = () => { document.querySelector('#confirm').disabled = false; };
      document.querySelector('#confirm').onclick = () => { window.declines++; document.querySelector('#offer').hidden = true; };
    </script>`)
  await installFixtureQuestionAnswers(page)
  assert.equal(await fixtureQuestionCardsVisible(page), 1, 'covered questions still block unrelated digit shortcuts')
  if (mode === 'poll') await answerFixtureQuestions(page)
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).click()
  assert.equal(await page.evaluate(() => (window as any).declines), 0, 'navigation must not answer through an overlay')
  if (mode === 'poll') await answerFixtureQuestions(page)
  else await page.getByRole('button', { name: 'Next action', exact: true }).click()
  assert.equal(await fixtureQuestionCardsVisible(page), 0)
  assert.equal(await page.evaluate(() => (window as any).declines), 1, 'the exposed offer is still answered exactly once')
  await page.evaluate(() => {
    document.querySelector('#frame')!.removeAttribute('data-sidebar-drawer')
    document.querySelector('#frame')!.removeAttribute('data-sidebar-collapsed')
    document.querySelector<HTMLElement>('#offer')!.hidden = false
    document.querySelector<HTMLButtonElement>('#confirm')!.disabled = true
  })
  if (mode === 'poll') await answerFixtureQuestions(page)
  else await page.getByRole('button', { name: 'Next action', exact: true }).click()
  assert.equal(await page.evaluate(() => (window as any).declines), 2, 'an expanded desktop sidebar does not defer answers')
})
