import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const playwrightPath = process.env.AI_TERM_PLAYWRIGHT_PATH ?? join(tmpdir(), 'ai-term-ui-tools/node_modules/playwright')
const { chromium } = require(playwrightPath)
const output = mkdtempSync(join(tmpdir(), 'ai-term-chat-playwright-'))
const browser = await chromium.connectOverCDP(process.env.AI_TERM_CDP_URL ?? 'http://127.0.0.1:9231')
const page = await browser.contexts()[0].newPage()
const screenshots = []
try {
  await page.setViewportSize({ width: 1280, height: 1120 })
  await page.goto('http://127.0.0.1:5173/tests/browser/ai-chat.fixture.html')
  await page.waitForFunction(() => window.aiFixtureReady)
  await page.evaluate(() => aiFixture.configure({ width: 554, theme: 'light', zoom: 1 }))
  await page.locator('[data-message-id="long-output"] .tool-step-toggle').click()
  await page.locator('[data-message-id="long-output"] button[aria-label="复制命令"]').click()
  assert.equal(await page.evaluate(() => aiFixture.copied.at(-1)), await page.evaluate(() => aiFixture.state.props.messages.find(m => m.id === 'long-output').agentSteps[0].command))
  await page.locator('[data-message-id="long-output"] button[aria-label="展开输出"]').click()
  await page.getByRole('dialog').waitFor()
  const dialogStyle = await page.getByRole('dialog').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }))
  screenshots.push(join(output, 'output-dialog-light.png'))
  await page.screenshot({ path: screenshots.at(-1) })
  console.log('Dialog styles:', JSON.stringify(dialogStyle))
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('[data-message-id="error-502"]').scrollIntoViewIfNeeded()
  screenshots.push(join(output, 'fixture-light-554.png'))
  await page.screenshot({ path: screenshots.at(-1) })
  await page.evaluate(() => aiFixture.configure({ width: 360, theme: 'dark', zoom: 1.25 }))
  await page.locator('[data-message-id="dispatch-failed"]').scrollIntoViewIfNeeded()
  screenshots.push(join(output, 'fixture-dark-360-125.png'))
  await page.screenshot({ path: screenshots.at(-1) })
  await page.goto('http://127.0.0.1:5173/')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.waitForSelector('.app-shell')
  const aiTab = page.locator('.workspace-tab').filter({ hasText: /^AI$/ })
  if (await aiTab.count()) await aiTab.first().click()
  screenshots.push(join(output, 'main-app-1440.png'))
  await page.screenshot({ path: screenshots.at(-1) })
  const aiPanel = page.locator('.ai-chat-panel')
  if (await aiPanel.count()) {
    const panelMetrics = await aiPanel.evaluate(element => ({ width: element.getBoundingClientRect().width, scrollWidth: element.scrollWidth, height: element.getBoundingClientRect().height }))
    assert.ok(panelMetrics.scrollWidth <= panelMetrics.width + 1, 'Main app AI panel has horizontal overflow')
  }
  console.log(JSON.stringify({ result: 'passed', screenshots }, null, 2))
} finally {
  await page.close()
  await browser.close()
}
