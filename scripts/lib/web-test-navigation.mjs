// Versioned native navigation and an explicit decline of the separate optional memory offer.
export async function openSettings(page) {
  // Onboarding can make the shell aria-hidden before its locator handler runs.
  const visible = page.locator(':visible')
  const menu = page.getByRole('button', { name: 'Account menu', exact: true, includeHidden: true }).and(visible)
  const direct = page.getByRole('button', { name: 'Settings', exact: true, includeHidden: true }).and(visible)
  await menu.or(direct).first().waitFor()
  if (await menu.isVisible()) {
    const settings = page.getByRole('menuitem', { name: 'Settings', exact: true })
    // A later onboarding handler can close the popover during this click's
    // actionability checks. Reconcile its current state on every such check.
    await page.addLocatorHandler(menu, async () => {
      if (!(await settings.isVisible())) await menu.click()
    }, { noWaitAfter: true })
    try { await settings.click() }
    finally { await page.removeLocatorHandler(menu) }
  } else await direct.click()
}
export async function declineOptionalMemoryOffers(page) {
  const decline = page.getByRole('button', { name: /今回は保存しない/ })
  const state = { declined: 0 }
  await page.addLocatorHandler(decline, async () => {
    await decline.click()
    await page.keyboard.press('Enter')
    state.declined++
  })
  return state
}
