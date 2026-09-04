import { chromium } from 'playwright-core'

const url = process.argv[2] || 'http://127.0.0.1:8766'
const screenshotPath = process.argv[3]
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true,
  args: ['--no-first-run', '--disable-background-mode'],
})

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const diagnostics = {
  pageErrors: [],
  consoleErrors: [],
  requestFailures: [],
  responses: [],
}

page.on('pageerror', (error) => diagnostics.pageErrors.push(error.stack || error.message))
page.on('console', (message) => {
  if (message.type() === 'error') diagnostics.consoleErrors.push(message.text())
})
page.on('requestfailed', (request) => {
  const error = request.failure()?.errorText || 'unknown'
  // WaveSurfer decodes fetched audio into WebAudio and then deliberately
  // abandons its temporary media-element Blob URL. Edge reports that as an
  // aborted request even though the decoded waveform and playback are ready.
  if (request.url().startsWith('blob:') && error === 'net::ERR_ABORTED') return
  diagnostics.requestFailures.push({ url: request.url(), error })
})
page.on('response', (response) => {
  if (response.status() >= 400) diagnostics.responses.push({ url: response.url(), status: response.status() })
})

try {
  await page.goto(url, { waitUntil: 'networkidle' })
  const before = await page.locator('body').innerText()
  const projectButton = page.locator('nav button').first()
  const projectButtonCount = await projectButton.count()
  if (projectButtonCount === 0) throw new Error('No project button was rendered')

  await projectButton.click()
  await page.getByRole('button', { name: 'Play audio' }).waitFor({ state: 'visible' })
  await page.waitForTimeout(500)

  const waveform = await page.locator('section[aria-label="Audio waveform"] > div.flex-1 > div').evaluate((host) => ({
    hasShadowRoot: Boolean(host.shadowRoot),
    canvasCount: host.shadowRoot?.querySelectorAll('canvas').length || 0,
    audioCount: host.shadowRoot?.querySelectorAll('audio').length || 0,
  }))

  const zoom = page.getByLabel('Timeline zoom')
  await zoom.fill('100')
  const timeLabel = page.locator('[aria-label*=" of "]').first()
  const timeBeforePlay = await timeLabel.getAttribute('aria-label')
  await page.getByRole('button', { name: 'Play audio' }).click()
  await page.waitForTimeout(900)
  const timeDuringPlay = await timeLabel.getAttribute('aria-label')
  await page.getByRole('button', { name: 'Pause audio' }).click()

  const diagnosticsResponse = await page.evaluate(async () => {
    const response = await fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'browser-smoke', name: 'SmokeCheck', message: 'Frontend diagnostic route check' }),
    })
    return response.status
  })

  const root = page.locator('#root')
  const bodyText = await page.locator('body').innerText()
  const result = {
    welcomeRendered: before.includes('Edit the recording'),
    projectRendered: /transcript/i.test(bodyText) && /timeline/i.test(bodyText),
    rootChildren: await root.locator(':scope > *').count(),
    waveform,
    zoom: await zoom.inputValue(),
    timeBeforePlay,
    timeDuringPlay,
    diagnosticsResponse,
    url: page.url(),
    diagnostics,
  }

  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (
    !result.welcomeRendered || !result.projectRendered || result.rootChildren === 0 ||
    !waveform.hasShadowRoot || waveform.canvasCount === 0 || result.zoom !== '100' ||
    timeBeforePlay === timeDuringPlay || diagnosticsResponse !== 200 ||
    diagnostics.pageErrors.length || diagnostics.consoleErrors.length ||
    diagnostics.requestFailures.length || diagnostics.responses.length
  ) {
    process.exitCode = 1
  }
} finally {
  await browser.close()
}
