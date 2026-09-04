import { chromium } from 'playwright-core'
import { basename, extname, resolve } from 'node:path'

const url = process.argv[2] || 'http://127.0.0.1:8766'
const mediaPath = resolve(process.argv[3] || 'runtime-import-test.wav')
const projectName = basename(mediaPath, extname(mediaPath))
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const browser = await chromium.launch({ executablePath: edgePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []

page.on('pageerror', (error) => errors.push(`page: ${error.stack || error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})
page.on('requestfailed', (request) => {
  const error = request.failure()?.errorText || 'unknown'
  if (request.url().startsWith('blob:') && error === 'net::ERR_ABORTED') return
  errors.push(`request: ${error} ${request.url()}`)
})

try {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Go to ScriptSurgeon home' }).click()
  await page.getByLabel('Choose media to import').first().setInputFiles(mediaPath)
  await page.getByText('Importing your media', { exact: true }).waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Play audio' }).waitFor({ state: 'visible', timeout: 300_000 })

  const waveform = await page.locator('section[aria-label="Audio waveform"] > div.flex-1 > div').evaluate((host) => ({
    canvasCount: host.shadowRoot?.querySelectorAll('canvas').length || 0,
    audioCount: host.shadowRoot?.querySelectorAll('audio').length || 0,
  }))
  const body = await page.locator('body').innerText()
  const result = {
    imported: body.includes(projectName),
    editorReady: /transcript/i.test(body) && /timeline/i.test(body),
    waveform,
    rootChildren: await page.locator('#root > *').count(),
    errors,
  }

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: `Delete ${projectName}`, exact: true }).click()
  await page.getByText('Edit the recording', { exact: false }).waitFor({ timeout: 15_000 })

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.imported || !result.editorReady || waveform.canvasCount === 0 || result.rootChildren === 0 || errors.length) {
    process.exitCode = 1
  }
} finally {
  await browser.close()
}
