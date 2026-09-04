import { chromium } from 'playwright-core'

const url = process.argv[2] || 'http://127.0.0.1:8766'
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const browser = await chromium.launch({ executablePath: edgePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
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

async function waitForSaved() {
  await page.getByText('Saved locally', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
}

async function waitForPreviewReady() {
  await page.waitForFunction(() => {
    const play = document.querySelector('button[aria-label="Play audio"]')
    return play instanceof HTMLButtonElement && !play.disabled
  }, undefined, { timeout: 30_000 })
}

try {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('nav button').first().click()
  const play = page.getByRole('button', { name: 'Play audio' })
  await play.waitFor({ state: 'visible', timeout: 15_000 })

  const firstWord = page.locator('.word-token[aria-label$=", transcript word"]').first()
  const firstWordLabel = await firstWord.getAttribute('aria-label')
  if (!firstWordLabel) throw new Error('The ready project has no editable transcript word')
  const firstWordText = firstWordLabel.replace(/, transcript word$/, '')
  await firstWord.focus()
  await firstWord.press('Delete')
  await page.getByRole('button', { name: `${firstWordText}, removed; activate to restore`, exact: true }).first().waitFor()
  await waitForSaved()

  await page.getByRole('button', { name: /^Undo/ }).click()
  await page.getByRole('button', { name: firstWordLabel, exact: true }).first().waitFor()
  await waitForSaved()

  let gap = page.locator('button[aria-label^="Shorten "][aria-label$=" second pause"]').first()
  if (await gap.count()) {
    const gapLabel = await gap.getAttribute('aria-label')
    if (!gapLabel) throw new Error('The long pause is missing its accessible label')
    await gap.click()
    await page.getByRole('button', { name: 'Restore original pause' }).first().waitFor()
    await waitForSaved()
    await page.getByRole('button', { name: /^Undo/ }).click()
    await page.getByRole('button', { name: gapLabel, exact: true }).first().waitFor()
    await waitForSaved()
  } else {
    const shortenedGap = page.getByRole('button', { name: 'Restore original pause' }).first()
    if (!(await shortenedGap.count())) throw new Error('The ready project has no editable pause for the pause smoke')
    await shortenedGap.click()
    await waitForSaved()
    gap = page.locator('button[aria-label^="Shorten "][aria-label$=" second pause"]').first()
    await gap.waitFor()
    await gap.click()
    await page.getByRole('button', { name: 'Restore original pause' }).first().waitFor()
    await waitForSaved()
  }

  await page.getByRole('button', { name: 'Clean up' }).click()
  await page.getByRole('dialog', { name: 'Review clean up' }).waitFor()
  await page.getByRole('button', { name: 'Cancel' }).click()

  const studio = page.getByRole('button', { name: /Studio sound/ })
  const initialStudio = (await studio.getAttribute('aria-pressed')) === 'true'
  await studio.click()
  await page.waitForFunction(
    (expected) => document.querySelector('button[title^="Preview EQ"]')?.getAttribute('aria-pressed') === String(expected),
    !initialStudio,
  )
  await waitForPreviewReady()
  await studio.click()
  await page.waitForFunction(
    (expected) => document.querySelector('button[title^="Preview EQ"]')?.getAttribute('aria-pressed') === String(expected),
    initialStudio,
  )
  await waitForPreviewReady()

  const downloadPromise = page.waitForEvent('download', { timeout: 20_000 })
  await page.getByRole('button', { name: 'Export WAV' }).click()
  const download = await downloadPromise
  const failure = await download.failure()
  if (failure) throw new Error(`Export download failed: ${failure}`)
  const suggestedFilename = download.suggestedFilename()

  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByText('Edit the recording', { exact: false }).waitFor()
  await page.locator('nav button').first().click()
  await page.getByRole('button', { name: 'Play audio' }).waitFor({ state: 'visible', timeout: 15_000 })

  const result = {
    textCutAndUndo: true,
    pauseEditRoundTrip: true,
    cleanupReviewAndCancel: true,
    studioSoundRoundTrip: true,
    exportFilename: suggestedFilename,
    closeAndReopen: true,
    errors,
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!suggestedFilename.toLowerCase().endsWith('.wav') || errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
