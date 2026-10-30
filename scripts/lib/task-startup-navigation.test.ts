import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { answerTaskStartupForTest } from './web-test-navigation.mjs'

const labels = ['decision ON / Lisp ON', 'decision ON / Lisp OFF', 'decision OFF / Lisp ON', 'decision OFF / Lisp OFF', '取消・作業を保持']
test('Web startup driver validates all options and submits only the explicitly rendered setting', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  t.after(() => browser.close())
  for (const selected of [labels[2]!, labels[3]!, labels[4]!]) {
    const page = await browser.newPage(); t.after(() => page.close())
    await page.setContent(`<section role="region" aria-labelledby="kiokuko-intake-fixture"><h2 id="kiokuko-intake-fixture">この作業で decision と Lisp を使いますか？</h2>${labels.map((label, i) => `<button class="kiokuko-intake-option" aria-pressed="false" data-choice="${i}"><strong>${i+1}. ${label}</strong></button>`).join('')}<button id="submit" disabled>確定（Enter）</button></section><script>window.answers=[];let selected;for(const b of document.querySelectorAll('[data-choice]'))b.onclick=()=>{for(const old of document.querySelectorAll('[data-choice]'))old.setAttribute('aria-pressed','false');b.setAttribute('aria-pressed','true');selected=Number(b.dataset.choice);document.querySelector('#submit').disabled=false};document.querySelector('#submit').onclick=()=>{window.answers.push(selected);document.querySelector('section').hidden=true}</script>`)
    const answer = await answerTaskStartupForTest(page, selected)
    assert.equal(answer.selected, selected); assert.equal(answer.key, 'kiokuko-intake-fixture')
    assert.deepEqual(await page.evaluate(() => (window as any).answers), [labels.indexOf(selected)])
    await page.close()
  }
  const malformed = await browser.newPage(); t.after(() => malformed.close())
  await malformed.setContent('<section role="region" aria-labelledby="kiokuko-intake-malformed"><h2 id="kiokuko-intake-malformed">この作業で decision と Lisp を使いますか？</h2><button class="kiokuko-intake-option"><strong>1. changed option</strong></button></section>')
  await assert.rejects(answerTaskStartupForTest(malformed), /Unexpected startup option contract/)
  await assert.rejects(answerTaskStartupForTest(malformed, 'unknown'), /Unknown startup fixture selection/)
})
