import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const url = process.argv[2] || 'http://127.0.0.1:8767'
const projectId = process.argv[3] || '44632f0b8f85'
const projectName = process.argv[4] || 'Feature Acceptance Fixture'
const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const retakeIds = [
  '37d7b685bf', 'e6376186cd', 'c1eadbab6c', '1b6b3ff244', '91c44ee18d',
  'f221772644', '8614471c87', 'cc68a9b7e6', '6dc6f915ed', 'a9797fdfab',
  '0ad95fdfca', 'f48b0b6d75', '9b8c8f14d0',
]
const editableWordId = 'a6338c74c0'
const gapWordId = '55c6ff4138'
const cdpEndpoint = process.env.CDP_ENDPOINT || ''

let browser
let page
if (cdpEndpoint) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      browser = await chromium.connectOverCDP(cdpEndpoint)
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (!browser) throw new Error(`WebView2 DevTools endpoint did not become ready at ${cdpEndpoint}`)
  const pages = browser.contexts().flatMap((context) => context.pages())
  page = pages.find((candidate) => candidate.url().startsWith('http://127.0.0.1:')) || pages[0]
  if (!page) throw new Error('The ScriptSurgeon WebView page was not found')
} else {
  browser = await chromium.launch({ executablePath: edgePath, headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
}
const errors = []
const expectedAborts = []
let renderResponseCount = 0

page.on('pageerror', (error) => errors.push(`page: ${error.stack || error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})
page.on('response', (response) => {
  if (response.request().method() === 'POST' && response.url().includes(`/api/projects/${projectId}/render`) && response.status() === 200) {
    renderResponseCount += 1
  }
  if (response.url().includes('/api/') && response.status() >= 400) {
    errors.push(`http: ${response.status()} ${response.request().method()} ${response.url()}`)
  }
})
page.on('requestfailed', (request) => {
  const failure = request.failure()?.errorText || 'unknown'
  const audio = request.url().startsWith('blob:') || (
    request.url().includes('/api/projects/') && request.url().includes('/audio?')
  )
  if (failure === 'net::ERR_ABORTED' && audio) {
    expectedAborts.push(request.url())
    return
  }
  errors.push(`request: ${failure} ${request.url()}`)
})

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function wordById(id) {
  return page.locator(`[data-word-id="${id}"]`)
}

async function getProjectState() {
  return page.evaluate(async ({ id }) => {
    const token = new URL(window.location.href).searchParams.get('token')
    const headers = token ? { 'X-ScriptCut-Token': token } : {}
    const response = await fetch(`/api/projects/${id}`, { headers })
    if (!response.ok) throw new Error(`State read failed with ${response.status}`)
    return (await response.json()).state
  }, { id: projectId })
}

async function waitReady(stage) {
  await page.waitForFunction(() => {
    const play = document.querySelector('button[aria-label="Play audio"]')
    return play instanceof HTMLButtonElement && !play.disabled
  }, undefined, { timeout: 30_000 })
  await page.getByText('Saved locally', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  const alerts = await page.locator('[role="alert"]').allInnerTexts()
  if (alerts.length) throw new Error(`${stage}: ${alerts.join(' | ')}`)
}

function isStateSave(response) {
  return response.request().method() === 'PUT' &&
    response.url().includes(`/api/projects/${projectId}/state`) && response.status() === 200
}

async function performEdit(stage, action) {
  const before = await getProjectState()
  await action()
  // Store persistence is intentionally debounced by 300 ms, so installing the
  // response watcher after the synchronous menu action still cannot miss it.
  // This also keeps an action/locator failure from being masked by a dangling
  // response promise when the browser is closed in finally.
  const saved = page.waitForResponse(isStateSave, { timeout: 30_000 })
  await saved
  await waitReady(stage)
  const after = await getProjectState()
  check(after.revision > before.revision, `${stage}: revision did not advance`)
  return after
}

async function chooseContextAction(trigger, actionName) {
  await trigger.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await menu.waitFor({ state: 'visible' })
  await menu.getByRole('menuitem', { name: actionName, exact: true }).click()
}

try {
  if (cdpEndpoint) await page.waitForLoadState('domcontentloaded')
  else await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByTitle(projectName, { exact: true }).click()
  await waitReady('initial project open')

  let texas = wordById(editableWordId)
  await texas.focus()
  await texas.press('Shift+F10')
  const keyboardMenu = page.getByRole('menu')
  await keyboardMenu.waitFor({ state: 'visible' })
  check((await keyboardMenu.getAttribute('aria-label'))?.includes('Texas'), 'Keyboard menu did not identify Texas')
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem')
  check((await page.locator(':focus').innerText()).trim() === 'Edit word', 'First menu item was not focused')
  await keyboardMenu.press('End')
  await keyboardMenu.press('Home')
  check((await page.locator(':focus').innerText()).trim() === 'Edit word', 'Home did not focus the first menu item')
  await keyboardMenu.press('Escape')
  check((await page.locator(':focus').getAttribute('aria-label'))?.startsWith('Texas,'), 'Escape did not return word focus')

  await chooseContextAction(texas, 'Edit word')
  let correction = page.getByRole('textbox', { name: /Correct/ })
  await correction.fill('x'.repeat(510))
  check((await correction.inputValue()).length === 500, 'Transcript correction exceeded 500 characters')
  await correction.press('Escape')

  await performEdit('correct word', async () => {
    texas = wordById(editableWordId)
    await chooseContextAction(texas, 'Edit word')
    correction = page.getByRole('textbox', { name: /Correct/ })
    await correction.fill('Texas QA')
    await correction.press('Enter')
  })
  let state = await getProjectState()
  check(state.words.find((word) => word.id === editableWordId)?.text === 'Texas QA', 'Correction did not persist')

  await performEdit('remove word', async () => {
    await chooseContextAction(wordById(editableWordId), 'Remove word')
  })
  state = await getProjectState()
  check(state.words.find((word) => word.id === editableWordId)?.isRemoved, 'Word was not removed')

  await performEdit('restore word', async () => {
    await chooseContextAction(wordById(editableWordId), 'Restore word')
  })
  state = await getProjectState()
  check(!state.words.find((word) => word.id === editableWordId)?.isRemoved, 'Word was not restored')
  check(state.cleanupKeepWordIds.includes(editableWordId), 'Restored word was not protected from cleanup')

  const retakePill = page.locator(`[data-retake-group="${retakeIds[0]}"]`)
  await performEdit('restore retake', async () => {
    await chooseContextAction(retakePill, 'Restore retake (13 words)')
  })
  state = await getProjectState()
  check(retakeIds.every((id) => !state.words.find((word) => word.id === id)?.isRemoved), 'Retake was not fully restored')
  check(retakeIds.every((id) => state.cleanupKeepWordIds.includes(id)), 'Restored retake was not protected from cleanup')

  await page.getByRole('button', { name: 'Clean up' }).click()
  let cleanup = page.getByRole('dialog', { name: 'Review clean up' })
  await cleanup.waitFor({ state: 'visible' })
  const trophy = wordById('c1eadbab6c')
  check(!(await trophy.getAttribute('class')).includes('bg-violet-500/16'), 'Protected retake was proposed again')
  await cleanup.getByRole('button', { name: 'Cancel' }).click()

  await performEdit('remove retake again', async () => {
    await chooseContextAction(wordById('c1eadbab6c'), 'Remove retake (13 words)')
  })
  state = await getProjectState()
  check(retakeIds.every((id) => state.words.find((word) => word.id === id)?.isRemoved), 'Retake was not fully removed')
  check(retakeIds.every((id) => !state.cleanupKeepWordIds.includes(id)), 'Retake removal did not clear cleanup protection')

  await performEdit('restore retake again', async () => {
    await chooseContextAction(page.locator(`[data-retake-group="${retakeIds[0]}"]`), 'Restore retake (13 words)')
  })

  const team = wordById(gapWordId)
  await performEdit('restore full pause from word menu', async () => {
    await chooseContextAction(team, 'Restore full pause after word')
  })
  state = await getProjectState()
  check(!state.shortenedGapIds.includes(gapWordId), 'Full pause was not restored')
  check(state.cleanupKeepGapIds.includes(gapWordId), 'Restored pause was not protected from cleanup')

  await page.getByRole('button', { name: 'Clean up' }).click()
  cleanup = page.getByRole('dialog', { name: 'Review clean up' })
  await cleanup.waitFor({ state: 'visible' })
  const gapAfterTeam = page.locator(`[data-gap-after-word-id="${gapWordId}"]`)
  check(!(await gapAfterTeam.getAttribute('aria-label')).includes('in preview'), 'Protected pause was proposed again')
  await cleanup.getByRole('button', { name: 'Cancel' }).click()

  await performEdit('shorten pause from word menu', async () => {
    await chooseContextAction(team, 'Shorten pause after word')
  })
  state = await getProjectState()
  check(state.shortenedGapIds.includes(gapWordId), 'Pause was not shortened')
  check(!state.cleanupKeepGapIds.includes(gapWordId), 'Shortening did not clear pause cleanup protection')

  await performEdit('restore pause from gap menu', async () => {
    await chooseContextAction(gapAfterTeam, 'Restore full gap')
  })
  state = await getProjectState()
  check(!state.shortenedGapIds.includes(gapWordId), 'Gap menu did not restore the full pause')

  const first = wordById(editableWordId)
  const third = wordById('b2bdbc75c2')
  const firstBox = await first.boundingBox()
  const thirdBox = await third.boundingBox()
  check(firstBox && thirdBox, 'Could not locate words for drag selection')
  await performEdit('multi-word keyboard delete', async () => {
    await page.mouse.move(firstBox.x + 2, firstBox.y + firstBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(thirdBox.x + thirdBox.width - 2, thirdBox.y + thirdBox.height / 2, { steps: 8 })
    await page.mouse.up()
    await first.press('Delete')
  })
  state = await getProjectState()
  check(['a6338c74c0', 'b81c6f8418', 'b2bdbc75c2'].every((id) =>
    state.words.find((word) => word.id === id)?.isRemoved), 'Delete did not remove the full selection')

  await performEdit('undo multi-word delete', async () => {
    await page.getByRole('button', { name: /Undo/ }).click()
  })

  await page.reload({ waitUntil: 'networkidle' })
  await page.getByTitle(projectName, { exact: true }).click()
  await waitReady('reload persistence')
  state = await getProjectState()
  check(state.words.find((word) => word.id === editableWordId)?.text === 'Texas QA', 'Correction was lost after reload')
  check(retakeIds.every((id) => !state.words.find((word) => word.id === id)?.isRemoved), 'Retake restore was lost after reload')
  check(state.cleanupKeepGapIds.includes(gapWordId), 'Pause restore policy was lost after reload')
  check(await page.getByRole('button', { name: /Undo/ }).isDisabled(), 'Undo history should reset after reload')

  const exportResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().includes(`/api/projects/${projectId}/export`) && response.status() === 200,
  { timeout: 30_000 })
  const downloadEvent = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Export WAV' }).click()
  await exportResponse
  const download = await downloadEvent
  const downloadPath = await download.path()
  check(download.suggestedFilename() === `${projectName}_clean.wav`, 'Export filename was incorrect')
  check(Boolean(downloadPath), 'Export did not create a downloadable file')
  const exported = await readFile(downloadPath)
  check(exported.length > 44, 'Exported WAV was empty')
  check(exported.subarray(0, 4).toString('ascii') === 'RIFF', 'Export was not a RIFF file')
  check(exported.subarray(8, 12).toString('ascii') === 'WAVE', 'Export was not a WAVE file')

  const result = {
    keyboardContextMenu: true,
    correctionAndLimit: true,
    removeRestoreWord: true,
    reversibleRetakeGroup: true,
    durableCleanupOverrides: true,
    wordAndGapPauseActions: true,
    multiWordDeleteAndUndo: true,
    reloadPersistence: true,
    exportBytes: exported.length,
    renderResponseCount,
    expectedAbortCount: expectedAborts.length,
    errors,
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (errors.length) process.exitCode = 1
} finally {
  await browser.close()
}
