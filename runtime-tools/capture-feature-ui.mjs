import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    'project-name': { type: 'string' },
    output: { type: 'string' },
    'executable-path': { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    'insert-a': { type: 'string' },
    'insert-text': { type: 'string' },
  },
  strict: true,
})

for (const required of ['url', 'project-name', 'output']) {
  if (!values[required]) throw new Error(`Missing required --${required}`)
}

const appUrl = new URL(values.url)
const allowedOrigin = appUrl.origin
const executablePath = values['executable-path'] ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const output = resolve(values.output)
await mkdir(dirname(output), { recursive: true })
if (values['insert-a']) await access(values['insert-a'])
const viewport = {
  width: Number(values.width || 1838),
  height: Number(values.height || 922),
}
if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) ||
    viewport.width < 800 || viewport.height < 600) {
  throw new Error('--width and --height must be integers at least 800 x 600')
}

const failures = []
const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 1,
})
await context.addInitScript(() => {
  window.localStorage.removeItem('scriptcut.timelineCollapsed')
  window.localStorage.removeItem('scriptsurgeon.timelineSize')
  window.localStorage.removeItem('scriptsurgeon.lastOpenTimelineSize')
  window.localStorage.removeItem('scriptsurgeon.workspaceTheme')
})
await context.route('**/*', async (route) => {
  const target = new URL(route.request().url())
  if (['http:', 'https:'].includes(target.protocol) && target.origin !== allowedOrigin) {
    failures.push(`external request: ${target.origin}${target.pathname}`)
    await route.abort('blockedbyclient')
    return
  }
  await route.continue()
})

const page = await context.newPage()
page.setDefaultTimeout(60_000)
page.on('pageerror', (error) => failures.push(`pageerror: ${error.stack || error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') failures.push(`console: ${message.text()}`)
})
page.on('response', (response) => {
  if (response.status() >= 400) {
    const target = new URL(response.url())
    if (target.origin === allowedOrigin) {
      failures.push(`http ${response.status()}: ${response.request().method()} ${target.pathname}`)
    }
  }
})
page.on('requestfailed', (request) => {
  const reason = request.failure()?.errorText || 'unknown'
  const target = new URL(request.url())
  const expectedAbort = reason.includes('ERR_ABORTED') && (
    target.protocol === 'blob:' || target.pathname.includes('/audio')
  )
  if (!expectedAbort) failures.push(`request failed: ${reason} ${target.pathname}`)
})

try {
  await page.goto(values.url, { waitUntil: 'domcontentloaded' })
  await page.getByTitle(values['project-name'], { exact: true }).click()
  const play = page.getByRole('button', { name: 'Play audio', exact: true })
  await play.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Play audio"]')
    return button instanceof HTMLButtonElement && !button.disabled
  })
  await page.getByText('Saved locally', { exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  const toolbarFits = () => page.locator('.workspace-command-bar').evaluate((bar) => bar.scrollWidth <= bar.clientWidth)

  if (values['insert-a']) {
    await page.getByRole('button', { name: 'Record insert', exact: true }).click()
    const insertDialog = page.getByRole('dialog', { name: 'Record an insert', exact: true })
    await insertDialog.waitFor()
    await insertDialog.getByLabel('Import insert audio').setInputFiles(values['insert-a'])
    await insertDialog.getByLabel('Spoken transcript').fill(
      values['insert-text'] || 'Recorded through the packaged microphone flow',
    )
    const rendered = page.waitForResponse((response) => {
      const request = response.request()
      return request.method() === 'POST' && new URL(response.url()).pathname.endsWith('/render') && response.ok()
    })
    await insertDialog.getByRole('button', { name: 'Save insert', exact: true }).click()
    await rendered
    await page.getByText('Saved locally', { exact: true }).waitFor({ state: 'visible' })
    await page.waitForFunction(() => {
      const button = document.querySelector('button[aria-label="Play audio"]')
      return button instanceof HTMLButtonElement && !button.disabled
    })
    await page.waitForTimeout(250)
  }
  const compact = output.replace(/(\.[^.]+)$/, '-compact$1')
  await page.getByRole('button', { name: 'Compact', exact: true }).click()
  await page.locator('#audio-waveform-content').waitFor({ state: 'visible' })
  await page.waitForTimeout(250)
  assert.equal(await toolbarFits(), true, 'the command toolbar must not overflow its workspace')
  await page.screenshot({ path: compact, fullPage: false })

  await page.getByRole('button', { name: 'Light mode', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  assert.equal(await page.evaluate(() => localStorage.getItem('scriptsurgeon.workspaceTheme')), 'dark')
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-ink-inverse').trim()),
    '20 23 27',
  )

  await page.getByRole('button', { name: 'Full', exact: true }).click()
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => localStorage.getItem('scriptsurgeon.timelineSize')), 'normal')
  assert.equal(await page.evaluate(() => localStorage.getItem('scriptsurgeon.lastOpenTimelineSize')), 'normal')
  assert.equal(await toolbarFits(), true, 'the command toolbar must not overflow its workspace')
  await page.screenshot({ path: output, fullPage: false })

  const collapsed = output.replace(/(\.[^.]+)$/, '-collapsed$1')
  await page.getByRole('button', { name: 'Hide', exact: true }).click()
  await page.getByRole('button', { name: 'Show timeline', exact: true }).waitFor()
  await page.waitForTimeout(250)
  await page.screenshot({ path: collapsed, fullPage: false })
  await page.getByRole('button', { name: 'Show timeline', exact: true }).click()
  await page.getByRole('button', { name: 'Full', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('scriptsurgeon.timelineSize')), 'normal')

  const recording = output.replace(/(\.[^.]+)$/, '-recording$1')
  await page.getByRole('button', { name: 'Record insert', exact: true }).click()
  await page.getByRole('dialog', { name: 'Record an insert', exact: true }).waitFor()
  await page.screenshot({ path: recording, fullPage: false })

  assert.deepEqual(failures, [], failures.join('\n'))
  process.stdout.write(`${JSON.stringify({
    viewport: { ...viewport, deviceScaleFactor: 1 },
    expanded: output,
    compact,
    collapsed,
    recording,
    failures,
  }, null, 2)}\n`)
} finally {
  await browser.close()
}
