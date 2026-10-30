import assert from 'node:assert/strict'

/** Follow the actual create response: blank sessions may be reused. */
export async function newSessionForTest(page, conversation, poll) {
  const previous = await poll(async () => {
    const id = await conversation.getAttribute('data-conversation-session')
    return id && await conversation.getAttribute('data-content-phase') !== 'settling' ? id : undefined
  })
  // A narrow frame presents the sidebar as a closed drawer whose inert content
  // exposes no actionable New Session control. Reveal the drawer through the
  // frame's own opener, and require navigation to close it again afterwards.
  const closedDrawer = page.locator('[data-sidebar-drawer][data-sidebar-collapsed]')
  const revealedDrawer = await closedDrawer.count() > 0
  if (revealedDrawer) {
    await page.locator('[data-sidebar-opener]').click()
    await poll(async () => await closedDrawer.count() === 0)
  }
  const observed=[]
  const observe=response=>{const url=new URL(response.url());if(url.pathname.includes('/api/')) observed.push({path:url.pathname,method:response.request().method(),status:response.status()})}
  page.on('response',observe)
  const created = page.waitForResponse('**/api/session/create').catch(error=>{throw new Error('Session create response absent: '+JSON.stringify(observed),{cause:error})}).finally(()=>page.off('response',observe))
  await page.getByRole('button', { name: 'New session', exact: true }).filter({hasNot:page.locator('[data-copy-version]')}).first().click()
  const response = await created, body = await response.json()
  assert.equal(body.result.ok, true, 'native session creation must succeed')
  const sessionId = body.result.value.sessionId
  assert.equal(typeof sessionId, 'string'); assert.ok(sessionId)
  const requested = response.request().postDataJSON().payload.args.request
  if (requested.sessionId !== undefined) assert.equal(requested.sessionId, sessionId)
  else assert.notEqual(sessionId, previous, 'a new creation without a reuse ID must return a different session')
  if (revealedDrawer) await poll(async () => await closedDrawer.count() > 0)
  await poll(async () => await conversation.getAttribute('data-conversation-session') === sessionId
    && await conversation.getAttribute('data-content-phase') !== 'settling')
  const result = { previous, sessionId, reused: previous === sessionId }
  console.log('Browser session navigation:', JSON.stringify(result))
  return result
}
