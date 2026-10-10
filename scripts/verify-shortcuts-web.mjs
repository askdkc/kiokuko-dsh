// Real DSH Web + packed Kiokuko + a no-model question producer, in a disposable profile.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
const exec = promisify(execFile), repository = resolve(import.meta.dirname, '..')
const fixtureName = process.env.KIOKUKO_SHORTCUT_RUNTIME ?? 'dsh-runtime'
const reuse = process.env.KIOKUKO_SHORTCUT_REUSE
const base = reuse ?? await realpath(await mkdtemp(join(tmpdir(), 'kiokuko-shortcuts-')))
const project = join(base, 'project'), answers = join(base, 'answers.jsonl')
const dsh = process.env.DSH_BIN ?? join(repository, `tests/fixtures/${fixtureName}/node_modules/.bin/dsh`)
const env = { ...process.env, HOME: join(base, 'home'), DSH_HOME: join(base, 'dsh'), KIOKUKO_DATA_DIR: join(base, 'data'), npm_config_cache: join(base, 'npm-cache') }
let child, browser, page, logs = ''
try {
  const patch = join(base, 'patch.yml')
  let archive = 'installed fixture'
  if (!reuse) {
  for (const name of ['project', 'home', 'dsh', 'data']) await mkdir(join(base, name))

  // The fixture owns this repository; never initialize or modify the host checkout.
  await exec('git', ['init', '-q'], { cwd: project })
  await writeFile(join(project, 'sample.txt'), 'before\n')
  await exec('git', ['add', 'sample.txt'], { cwd: project })
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline'], { cwd: project })
  await writeFile(join(project, 'sample.txt'), 'after\n')
  await writeFile(join(project, 'untracked.txt'), 'untracked\n')
  const pack = await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', base, '--json'], { env, cwd: repository, maxBuffer: 8 * 1024 ** 2 })
  archive = join(base, JSON.parse(pack.stdout)[0].filename)
  console.log(`Installing ${fixtureName}: ${archive}`)
  await exec(dsh, ['plugin', '--profile', 'web', 'add', archive, '--force'], { env, cwd: project, maxBuffer: 8 * 1024 ** 2 })
  const fixture = join(base, 'questions.mjs')
  await writeFile(fixture, `import {appendFile} from 'node:fs/promises';
export const name='shortcut-fixture'; export const inject=['workspaceRegistry','commands','userQuestions'];
export async function apply(ctx) {
  await ctx.workspaceRegistry.create(${JSON.stringify(project)}, 'Shortcut verification');
  ctx.commands.register({name:'shortcut-fixture',description:'No-model shortcut regression',input:{hint:'1 | 9 | 10 | 24 | multi | batch | empty | search | value | review'},handler:async request=>{
    const mode=request.rawInput.trim(); const count=Number(mode)||24;
    if(mode==='seed') {
      request.agent.session.append('user/message',{id:'shortcut-fixture-seed',role:'user',content:[{type:'text',text:'Shortcut fixture (no model execution)'}],source:{kind:'user'}},{surfaceOp:'append'});
      return {kind:'success',text:'Fixture history ready'};
    }
    const q={id:mode==='search'?'enno-model-zenki':mode==='value'?'deep-budget-value':'unknown-shortcut',header:mode==='search'?'実行方式とモデル':mode==='value'?'Deep planning':'Shortcut verification',question:'Shortcut fixture '+mode,
      options:mode==='empty'?[]:Array.from({length:count},(_,i)=>({label:'Choice '+(i+1)+' — 長い候補名も表示する',description:'Keyboard verification'})),...(mode==='multi'?{multiSelect:true}:{})};
    if(mode==='intake'){q.id='taskType';q.header='Kiokuko · 作業の選択';q.question='今回は何をしてほしいですか？';q.options=['実装・変更','不具合調査、情報調査','文章作成','質問、相談、会話'].map(label=>({label}));}
    if(mode==='review'){q.options=[{label:'Approve'},{label:'Reject'}];q.intent={kind:'plan-review',approve:'Approve'};q.detail='# Review fixture';}
    try {const answer=await ctx.userQuestions.ask({agent:request.agent,signal:request.signal,questions:mode==='batch'?[q,{...q,id:'second',question:'Second question',options:[{label:'Second A'},{label:'Second B'}]}]:[q]});
      await appendFile(${JSON.stringify(answers)},JSON.stringify({mode,answer})+'\\n'); return {kind:'success',text:'Recorded '+mode};
    } catch(e){await appendFile(${JSON.stringify(answers)},JSON.stringify({mode,error:e.code??e.message})+'\\n');return {kind:'success',text:'Dismissed '+mode};}
  }});
}`)
  await writeFile(patch, `- id: kiokuko-dsh\n  config:\n    enabled: true\n    orca: {enabled: false}\n- insert:\n    - id: shortcut-fixture\n      name: ${JSON.stringify(fixture)}\n      inject: [workspaceRegistry, commands, userQuestions]\n`)
  }
  child = spawn(dsh, ['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], { env, cwd: project, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += chunk.toString() })
  const url = await poll(async () => logs.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0], 90_000)
  console.log(`Running ${new URL(url).origin} (${base})`)
  if (process.env.KIOKUKO_SHORTCUT_MANUAL === '1') { await new Promise(resolve => { process.on('SIGINT', resolve); process.on('SIGTERM', resolve) }); }
  else {
    await writeFile(answers, '')
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', e => console.error('Browser error:', e.message))
    await page.goto(url)
    // Both onboarding stages load asynchronously. A one-shot visibility check can
    // miss the credential dialog and let its autofocus capture the seed command.
    // Reused profiles may already have acknowledged the welcome notice.
    const welcome = page.getByRole('button', { name: 'Continue', exact: true })
    const credentials = page.getByRole('dialog', { name: 'Add an API key to get started', exact: true })
    await welcome.or(credentials).first().waitFor()
    if (await welcome.isVisible()) await welcome.click()
    await credentials.getByRole('button', { name: 'Configure later', exact: true }).click()
    await credentials.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const editor = page.locator('[contenteditable="true"]').first()
    await editor.waitFor()
    await page.screenshot({ path: join(base, 'initial.png') })
    await editor.fill('/shortcut-fixture seed'); await editor.press('Enter')
    await page.getByRole('button',{name:'Diff レビュー',exact:true}).waitFor()
    const records = async () => (await readFile(answers, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const ask = async mode => { await editor.fill('/shortcut-fixture '+mode); await editor.press('Enter'); await page.locator('.kiokuko-intake').waitFor(); await page.locator('.kiokuko-intake').focus() }
    await ask('intake')
    await page.keyboard.press('ControlOrMeta+4')
    await page.screenshot({path:join(base,'intake-shortcuts.png')})
    await page.keyboard.press('Enter')
    assert.deepEqual((await poll(async ()=>(await records()).find(r=>r.mode==='intake'))).answer.answers[0].selected,['質問、相談、会話'])
    await page.locator('.kiokuko-intake').waitFor({state:'hidden'})
    for (const count of [1, 9, 10, 24]) {
      await ask(String(count)); const card = page.locator('.kiokuko-intake')
      assert.equal(await card.locator('kbd').count(), count)
      await page.keyboard.type(String(count)); await page.keyboard.press('Enter')
      const result = await poll(async () => (await records()).find(r => r.mode === String(count)))
      assert.deepEqual(result.answer.answers[0].selected, [`Choice ${count} — 長い候補名も表示する`])
      await card.waitFor({ state: 'hidden' })
    }
    await ask('multi'); const card = page.locator('.kiokuko-intake')
    await page.keyboard.type('10'); assert.equal(await card.locator('[aria-checked="true"]').count(), 0)
    await page.keyboard.press('Space'); await page.keyboard.press('ControlOrMeta+2')
    await page.keyboard.press('ControlOrMeta+Enter')
    assert.deepEqual((await poll(async () => (await records()).find(r => r.mode === 'multi'))).answer.answers[0].selected, ['Choice 10 — 長い候補名も表示する','Choice 2 — 長い候補名も表示する'])
    await card.waitFor({ state: 'hidden' })
    await ask('batch'); await page.keyboard.type('20'); await page.keyboard.press('Enter')
    await card.getByRole('button', {name:'前の質問',exact:true}).click()
    assert.equal(await card.locator('[aria-pressed="true"]').count(), 1)
    await card.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('2'); await page.keyboard.press('Enter')
    assert.equal((await poll(async () => (await records()).find(r => r.mode === 'batch'))).answer.answers.length, 2)
    await card.waitFor({ state: 'hidden' })
    for (const mode of ['empty','search','value']) {
      await ask(mode); await card.locator('textarea').fill(mode==='empty'?'自由入力':'120000'); await card.locator('textarea').press('Enter')
      assert.equal((await poll(async () => (await records()).find(r => r.mode===mode))).answer.answers[0].custom, mode==='empty'?'自由入力':'120000')
      await card.waitFor({state:'hidden'})
    }
    await ask('review'); await page.keyboard.press('3'); await page.keyboard.press('Enter')
    assert.deepEqual((await poll(async () => (await records()).find(r => r.mode==='review'))).answer.answers[0].selected, ['Approve'])
    await card.waitFor({state:'hidden'})
    await ask('cancel'); await page.keyboard.press('Escape')
    assert.ok((await poll(async () => (await records()).find(r => r.mode==='cancel'))).error)
    await page.getByRole('button',{name:'Diff レビュー',exact:true}).click()
    const review = page.locator('.kiokuko-review')
    await review.getByRole('button',{name:'比較対象: 未コミット全体',exact:true}).waitFor()
    // A modal fallback owns focus on older DSH; open the question before reopening it.
    if (await page.locator('dialog.kiokuko-review-fallback').isVisible()) await page.locator('dialog.kiokuko-review-fallback').getByRole('button',{name:'閉じる',exact:true}).click()
    await ask('simultaneous')
    if (!await review.isVisible()) await page.getByRole('button',{name:'Diff レビュー',exact:true}).click()
    await review.getByRole('button',{name:'比較対象: 未コミット全体',exact:true}).click()
    const comparison = review.getByRole('dialog',{name:'比較対象',exact:true})
    await comparison.focus(); await page.keyboard.press('3'); await page.keyboard.press('Enter')
    await review.getByRole('button',{name:'比較対象: 未ステージ',exact:true}).waitFor()
    assert.equal(await card.locator('[aria-pressed="true"]').count(),0,'Diff key must not select a question option')
    const untracked = review.getByRole('group',{name:'未追跡ファイル（明示選択）',exact:true})
    await untracked.focus(); await page.keyboard.press('1'); await page.keyboard.press('Space')
    assert.equal(await untracked.getByRole('checkbox').first().isChecked(),true)
    await review.getByRole('button',{name:'差分を取得',exact:true}).click()
    // Exercise the collapsed file list in both the sidebar and legacy dialog.
    await page.setViewportSize({width:780,height:900})
    const files = review.getByRole('group',{name:'変更ファイル',exact:true})
    await review.getByRole('button',{name:'変更ファイル一覧',exact:true}).click()
    await files.waitFor()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await files.evaluate(element => element === document.activeElement),true,'opening the file list must focus its keyboard group')
    await page.keyboard.press('1')
    const checkbox = files.getByRole('checkbox').first(), before = await checkbox.isChecked()
    await page.keyboard.press('Space'); assert.equal(await checkbox.isChecked(),!before)
    await files.getByRole('button').first().focus(); await page.keyboard.press('Space')
    assert.equal(await checkbox.isChecked(),before,'Space on the focused file button also toggles the analysis target')
    assert.equal(await card.locator('[aria-pressed="true"]').count(),0)
    assert.equal(await review.getByRole('button',{name:'分析する',exact:true}).isEnabled(),false,'selection must not start analysis or choose a model')
    if (await page.locator('dialog.kiokuko-review-fallback').isVisible()) await page.locator('dialog.kiokuko-review-fallback').getByRole('button',{name:'閉じる',exact:true}).click()
    await card.focus(); await page.keyboard.press('4')
    await page.screenshot({path:join(base,'shortcuts.png')})
    if (await page.getByRole('tab',{name:'Diff review Close',exact:true}).isVisible()) await page.getByRole('tab',{name:'Diff review Close',exact:true}).getByRole('button',{name:'Close',exact:true}).click()
    if (await page.getByRole('button',{name:'Collapse right sidebar',exact:true}).isVisible()) await page.getByRole('button',{name:'Collapse right sidebar',exact:true}).click()
    await page.setViewportSize({width:420,height:800})
    if (await page.getByRole('button',{name:'Collapse right sidebar',exact:true}).isVisible()) await page.getByRole('button',{name:'Collapse right sidebar',exact:true}).click()
    await card.focus(); await page.keyboard.press('Backspace'); await page.keyboard.type('24')
    await card.getByRole('button',{name:'確定（Enter）',exact:true}).click({trial:true})
    const cardBounds = await card.boundingBox()
    assert.ok(cardBounds && cardBounds.width>=300 && cardBounds.x>=0 && cardBounds.x+cardBounds.width<=420,'question does not collapse inside a narrow host pane')
    const footer = await card.locator('footer').boundingBox()
    assert.ok(footer && footer.x>=0 && footer.x+footer.width<=420 && footer.y>=0 && footer.y+footer.height<=800,'confirmation remains visible in narrow layout')
    await page.screenshot({path:join(base,'shortcuts-narrow.png')})
    // A 640×450 CSS viewport exercises the layout available at 200% zoom on 1280×900.
    await page.setViewportSize({width:640,height:450})
    await card.getByRole('button',{name:'確定（Enter）',exact:true}).click({trial:true})
    const zoomFooter = await card.locator('footer').boundingBox()
    assert.ok(zoomFooter && zoomFooter.x>=0 && zoomFooter.x+zoomFooter.width<=640 && zoomFooter.y>=0 && zoomFooter.y+zoomFooter.height<=450)
    await page.keyboard.press('Enter')
    assert.deepEqual((await poll(async ()=>(await records()).find(r=>r.mode==='simultaneous'))).answer.answers[0].selected,['Choice 24 — 長い候補名も表示する'])
    await card.waitFor({state:'hidden'})
    console.log(JSON.stringify({fixtureName, packed: archive, passed: true, caseCount: (await records()).length, screenshots: [join(base,'shortcuts.png'),join(base,'shortcuts-narrow.png')]}))
  }
} catch (error) { if(page){console.error(await page.locator('body').ariaSnapshot());await page.screenshot({path:join(base,'failure.png')})} console.error(logs.slice(-8000).replace(/token=[^\s]+/g, 'token=[redacted]')); console.error('Evidence:',base); throw error }
finally { await browser?.close(); if(child){child.kill('SIGTERM'); await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,5000).unref()})} if(process.env.KIOKUKO_KEEP_SHORTCUT_EVIDENCE!=='1')await rm(base,{recursive:true,force:true}) }
async function poll(read, timeout=15_000) { const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100))}throw new Error('Required browser fixture condition timed out') }
