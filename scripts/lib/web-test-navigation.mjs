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
