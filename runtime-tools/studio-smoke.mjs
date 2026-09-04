import { chromium } from 'playwright-core'

const url = process.argv[2] || 'http://127.0.0.1:8766'
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const browser = await chromium.launch({ executablePath: edgePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
const expectedAborts = []

page.on('pageerror', (error) => errors.push(`page: ${error.stack || error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})
page.on('requestfailed', (request) => {
  const failure = request.failure()?.errorText || 'unknown'
  if (failure === 'net::ERR_ABORTED' && (request.url().startsWith('blob:') || request.url().includes('/api/projects/'))) {
    expectedAborts.push(request.url())
    return
  }
  errors.push(`request: ${failure} ${request.url()}`)
})

function audioResponse(response) {
  return response.url().includes('/api/projects/') && response.url().includes('/audio?') && response.status() === 200
}

async function assertReadyWithoutBanner(stage) {
  await page.waitForFunction(() => {
    const play = document.querySelector('button[aria-label="Play audio"]')
    return play instanceof HTMLButtonElement && !play.disabled
  }, undefined, { timeout: 30_000 })
  const alerts = await page.locator('[role="alert"]').allInnerTexts()
  if (alerts.length) errors.push(`${stage}: ${alerts.join(' | ')}`)
}

try {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('nav button').first().click()
  await assertReadyWithoutBanner('initial load')

  const studio = page.getByRole('button', { name: /Studio sound/ })
  let studioEnabled = (await studio.getAttribute('aria-pressed')) === 'true'
  const initialStudio = studioEnabled

  for (let index = 0; index < 4; index += 1) {
    const audio = page.waitForResponse(audioResponse, { timeout: 30_000 })
    await studio.click()
    studioEnabled = !studioEnabled
    await page.waitForFunction(
      (expected) => document.querySelector('button[title^="Preview EQ"]')?.getAttribute('aria-pressed') === String(expected),
      studioEnabled,
    )
    await audio
    await assertReadyWithoutBanner(`sequential toggle ${index + 1}`)
  }

  for (let index = 0; index < 6; index += 1) {
    await studio.click()
    studioEnabled = !studioEnabled
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(1_500)
  await assertReadyWithoutBanner('rapid toggle series')

  const timeLabel = page.locator('[aria-label*=" of "]').first()
  const before = await timeLabel.getAttribute('aria-label')
  await page.getByRole('button', { name: 'Play audio' }).click()
  await page.waitForTimeout(850)
  const during = await timeLabel.getAttribute('aria-label')
  await page.getByRole('button', { name: 'Pause audio' }).click()

  const result = {
    sequentialToggles: 4,
    rapidToggles: 6,
    initialStudio,
    finalStudio: studioEnabled,
    playbackAdvanced: before !== during,
    expectedAbortCount: expectedAborts.length,
    errors,
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (studioEnabled !== initialStudio || before === during || errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
