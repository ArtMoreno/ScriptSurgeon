import { chromium } from 'playwright-core'

const endpoint = process.argv[2] || 'http://127.0.0.1:19229'
const projectName = process.argv[3] || 'Feature Acceptance Fixture'
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
const expectedAborts = []
page.on('pageerror', (error) => errors.push(`page: ${error.stack || error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})
page.on('requestfailed', (request) => {
  const failure = request.failure()?.errorText || 'unknown'
  const supersededAudio = request.url().includes('/api/projects/') && request.url().includes('/audio?')
  if (failure === 'net::ERR_ABORTED' && (request.url().startsWith('blob:') || supersededAudio)) {
    expectedAborts.push(request.url())
    return
  }
  errors.push(`request: ${failure} ${request.url()}`)
})

async function waitForReady(stage) {
  await page.waitForFunction(() => {
    const play = document.querySelector('button[aria-label="Play audio"]')
    return play instanceof HTMLButtonElement && !play.disabled
  }, undefined, { timeout: 30_000 })
  const alerts = await page.locator('[role="alert"]').allInnerTexts()
  if (alerts.length) errors.push(`${stage}: ${alerts.join(' | ')}`)
}

try {
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#root > *').waitFor({ state: 'visible', timeout: 20_000 })
  const activeProject = page.locator('main > header h1')
  if (!await activeProject.isVisible() || (await activeProject.innerText()) !== projectName) {
    await page.getByTitle(projectName, { exact: true }).click()
  }
  await activeProject.filter({ hasText: projectName }).waitFor({ state: 'visible', timeout: 20_000 })
  await waitForReady('initial load')

  const studio = page.getByRole('button', { name: /Studio sound/ })
  let studioEnabled = (await studio.getAttribute('aria-pressed')) === 'true'
  const initialStudio = studioEnabled

  for (let index = 0; index < 4; index += 1) {
    await studio.click()
    studioEnabled = !studioEnabled
    await page.waitForFunction(
      (expected) => document.querySelector('button[title^="Preview EQ"]')?.getAttribute('aria-pressed') === String(expected),
      studioEnabled,
    )
    await waitForReady(`sequential toggle ${index + 1}`)
  }

  for (let index = 0; index < 6; index += 1) {
    await studio.click()
    studioEnabled = !studioEnabled
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(1_500)
  await waitForReady('rapid toggle series')

  const timeLabel = page.locator('[aria-label*=" of "]').first()
  const before = await timeLabel.getAttribute('aria-label')
  await page.getByRole('button', { name: 'Play audio' }).click()
  await page.waitForTimeout(850)
  const during = await timeLabel.getAttribute('aria-label')
  await page.getByRole('button', { name: 'Pause audio' }).click()

  const result = {
    projectName,
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
