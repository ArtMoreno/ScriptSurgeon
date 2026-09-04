import { chromium } from 'playwright-core'

const endpoint = process.argv[2] || 'http://127.0.0.1:19236'
const projectName = process.argv[3] || 'Feature Acceptance Fixture'
const replacement = process.argv[4] || 'Texas CLOSE-SAVE'
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

await page.waitForLoadState('domcontentloaded')
await page.getByTitle(projectName, { exact: true }).click()
await page.waitForFunction(() => {
  const play = document.querySelector('button[aria-label="Play audio"]')
  return play instanceof HTMLButtonElement && !play.disabled
}, undefined, { timeout: 30_000 })

const word = page.locator('[data-word-id="a6338c74c0"]')
await word.click({ button: 'right' })
await page.getByRole('menuitem', { name: 'Edit word', exact: true }).click()
const correction = page.getByRole('textbox', { name: /Correct/ })
await correction.fill(replacement)
await correction.press('Enter')

// Exit the controller immediately—without closing the CDP browser and without
// waiting for the 300 ms save debounce. The PowerShell harness sends WM_CLOSE
// to the native window as its very next operation.
process.stdout.write(`${JSON.stringify({ editQueued: true, replacement })}\n`)
process.exit(0)
