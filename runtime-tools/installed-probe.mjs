import { chromium } from 'playwright-core'

const endpoint = process.argv[2] || 'http://127.0.0.1:19229'
const screenshotPath = process.argv[3]
const requestedProject = process.argv[4] || ''
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

let browser
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    browser = await chromium.connectOverCDP(endpoint)
    break
  } catch {
    await sleep(250)
  }
}
if (!browser) throw new Error(`WebView2 DevTools endpoint did not become ready at ${endpoint}`)

const pages = browser.contexts().flatMap((context) => context.pages())
const page = pages.find((candidate) => candidate.url().startsWith('http://127.0.0.1:')) || pages[0]
if (!page) throw new Error('The ScriptSurgeon WebView page was not found')

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
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'Go to ScriptSurgeon home' }).click()
  await page.getByText('Edit the recording', { exact: false }).waitFor({ timeout: 20_000 })
  const projectButton = requestedProject
    ? page.getByTitle(requestedProject, { exact: true })
    : page.locator('nav button').first()
  await projectButton.click()
  const play = page.getByRole('button', { name: 'Play audio' })
  await play.waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Play audio"]')
    return button instanceof HTMLButtonElement && !button.disabled
  }, undefined, { timeout: 30_000 })

  const waveform = await page.locator('section[aria-label="Audio waveform"] > div.flex-1 > div').evaluate((host) => ({
    canvasCount: host.shadowRoot?.querySelectorAll('canvas').length || 0,
    audioCount: host.shadowRoot?.querySelectorAll('audio').length || 0,
  }))
  const timeLabel = page.locator('[aria-label*=" of "]').first()
  const timeBeforePlay = await timeLabel.getAttribute('aria-label')
  await play.click()
  await page.waitForTimeout(800)
  const timeDuringPlay = await timeLabel.getAttribute('aria-label')
  await page.getByRole('button', { name: 'Pause audio' }).click({ timeout: 10_000 })

  const result = {
    projectName: await page.locator('main h1').innerText(),
    rootChildren: await page.locator('#root > *').count(),
    waveform,
    timeBeforePlay,
    timeDuringPlay,
    errors,
  }
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.rootChildren === 0 || waveform.canvasCount === 0 || timeBeforePlay === timeDuringPlay || errors.length) {
    process.exitCode = 1
  }
} finally {
  await browser.close()
}
