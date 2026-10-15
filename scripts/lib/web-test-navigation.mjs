// Versioned native navigation and an explicit decline of the separate optional memory offer.
export async function openSettings(page) {
  const menu = page.getByRole('button', { name: 'Account menu', exact: true })
  if (await menu.isVisible()) {
    await menu.click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  } else await page.getByRole('button', { name: 'Settings', exact: true }).click()
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
