// Versioned native navigation and an explicit decline of the separate optional memory offer.
export async function openSettings(page, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout
  const remaining = () => Math.max(1, deadline - Date.now())
  const visible = page.locator(':visible')
  const opened = page.locator('[data-shortcut-modal="settings"][role="dialog"]')
    .or(page.getByRole('dialog', { name: 'Settings', exact: true })).and(visible).first()
  if (await opened.isVisible()) return
  const menu = page.getByRole('button', { name: 'Account menu', exact: true, includeHidden: true }).and(visible)
  const direct = page.getByRole('button', { name: 'Settings', exact: true, includeHidden: true }).and(visible)
  await menu.or(direct).first().waitFor({ timeout: remaining() })
  const settings = page.getByRole('menuitem', { name: 'Settings', exact: true })
  const closedAccount = menu.and(page.locator('[aria-expanded="false"]'))
  // Keep pointer actions outside locator handlers so onboarding handlers can run.
  // If onboarding closes the menu during a retry, resolve the next action from
  // the current DOM again instead of waiting forever for the missing menu item.
  const action = settings.or(closedAccount).or(direct).first()
  let lastTimeout
  while (Date.now() < deadline) {
    if (await opened.isVisible()) return
    try { await action.click({ timeout: Math.min(1000, remaining()) }) }
    catch (error) {
      if (error?.name !== 'TimeoutError') throw error
      lastTimeout = error
    }
  }
  if (await opened.isVisible()) return
  throw lastTimeout ?? new Error('Settings navigation timed out')
}
export async function declineOptionalMemoryOffers(page) {
  const decline = page.getByRole('button', { name: /今回は保存しない/ })
  const state = { declined: 0 }
  await page.addLocatorHandler(decline, async () => {
    await decline.click()
    // Submit only while the question control remains mounted; a global Enter
    // can otherwise send a command that was already typed into the composer.
    if (await decline.isVisible()) await decline.press('Enter')
    state.declined++
  })
  return state
}


// Test drivers answer the actual visible startup controls. No RPC answer injection.
export async function answerTaskStartupForTest(page, selected = 'decision OFF / Lisp OFF') {
  const labels = ['decision ON / Lisp ON', 'decision ON / Lisp OFF', 'decision OFF / Lisp ON', 'decision OFF / Lisp OFF', '取消・作業を保持']
  if (!labels.includes(selected)) throw new Error('Unknown startup fixture selection')
  const card = page.getByRole('region', { name: 'この作業で decision と Lisp を使いますか？', exact: true })
  await card.waitFor({ state: 'visible' })
  const actual = await card.locator('.kiokuko-intake-option strong').allTextContents()
  if (JSON.stringify(actual) !== JSON.stringify(labels.map((label, index) => `${index + 1}. ${label}`)))
    throw new Error('Unexpected startup option contract: ' + JSON.stringify(actual))
  const key = await card.getAttribute('aria-labelledby')
  if (!key?.startsWith('kiokuko-intake-')) throw new Error('Startup card lacks its question binding')
  const option = card.getByRole('button', { name: `${labels.indexOf(selected) + 1}. ${selected}`, exact: true })
  await option.click()
  if (await option.getAttribute('aria-pressed') !== 'true') throw new Error('Startup selection was not rendered')
  await card.getByRole('button', { name: '確定（Enter）', exact: true }).click()
  await card.waitFor({ state: 'hidden' })
  return { key, selected }
}
