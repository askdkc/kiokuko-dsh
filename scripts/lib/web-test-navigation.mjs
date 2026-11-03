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
    try {
      // Transient overlays or rerenders must not eat a whole action deadline
      // or kill the process; bounded attempts let the interception settle.
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await decline.click({ timeout: 8000 }) } catch (error) {
          if (error instanceof Error && error.message.includes('has been closed')) return
          if (attempt === 2) { handlerFailures.push(error instanceof Error ? error.message : String(error)); return }
          continue
        }
        // Submit only while the question control remains mounted; a global Enter
        // can otherwise send a command that was already typed into the composer.
        try { if (await decline.isVisible()) await decline.press('Enter', { timeout: 8000 }) } catch (error) {
          if (error instanceof Error && error.message.includes('has been closed')) return
          handlerFailures.push(error instanceof Error ? error.message : String(error))
          return
        }
        state.declined++
        return
      }
    } catch (error) { handlerFailures.push(error instanceof Error ? error.message : String(error)) }
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

// Explicit test-user answers for checks whose subject is not Akinator or memory.
function fixtureQuestions(page) {
  return [
    ['対象のリポジトリ、ファイル、機能、またはサービスは何ですか？', 'the fixture repository source'],
    ['完了と判断する成功条件は何ですか？', 'the requested fixture result is verified'],
    ['このターンは終了しました。今回の記憶を整理して確認しますか？', null],
    ['作業は完了しました。今回の記憶を整理してよいですか？', null],
  ].map(([name, answer]) => {
    const card = page.getByRole('region', { name, exact: true })
    const confirm = card.getByRole('button', { name: '確定（Enter）', exact: true })
    return { card, async respond() {
      if (answer === null) {
        // A rerender can detach the offer between click attempts; each attempt
        // re-resolves the control against the current card.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await card.getByRole('button', { name: /今回は保存しない/ }).click({ timeout: 8000 })
            if (await confirm.isVisible().catch(() => false)) await confirm.click({ timeout: 8000 })
            await card.waitFor({ state: 'hidden', timeout: 8000 })
            return
          } catch (error) {
            if (error instanceof Error && error.message.includes('has been closed')) return
            if (attempt === 2) throw error
          }
        }
        return
      }
      await card.getByRole('textbox').fill(answer)
      await card.getByRole('button', { name: '確定（Enter）', exact: true }).click()
      await card.waitFor({ state: 'hidden' })
    } }
  })
}

/** Handler-internal answer failures, kept for driver diagnostics. Playwright
 * invokes these handlers outside the awaited action path, so any rejection
 * would otherwise surface as a fatal uncaught promise instead of the real
 * verification failure the drivers already watch through their own checks. */
const handlerFailures = []
export function fixtureQuestionHandlerFailures() { return [...handlerFailures] }

/** An auto-answer can still run while a test disposes its page. Handler-internal
 * failures are recorded, never rethrown: only real driver assertions should
 * fail the verification, with their own actionable messages. */
function addQuestionHandler(page, card, respond) {
  return page.addLocatorHandler(card, async () => {
    try { return await respond() }
    catch (error) { handlerFailures.push(error instanceof Error ? error.message : String(error)) }
  })
}

/** Number of currently mounted memory-review and fixture cards. Keyboard
 * presses bypass locator handlers, so drivers must see zero before sending
 * digit shortcuts that would otherwise land on a pending review instead. */
export async function fixtureQuestionCardsVisible(page) {
  if (!page) return 0
  let count = 0
  for (const { card } of fixtureQuestions(page)) if (await card.isVisible()) count++
  return count
}
export async function answerFixtureQuestions(page) {
  if (!page) return
  for (const { card, respond } of fixtureQuestions(page)) if (await card.isVisible()) {
    // Polls can answer without an actionability check. Temporarily remove the
    // handler so it cannot consume the same card ahead of this explicit answer.
    await page.removeLocatorHandler(card)
    try { await respond() } finally { await addQuestionHandler(page, card, respond) }
  }
}
export async function installFixtureQuestionAnswers(page) {
  for (const { card, respond } of fixtureQuestions(page)) await addQuestionHandler(page, card, respond)
}
