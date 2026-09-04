import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    'project-id': { type: 'string' },
    'project-name': { type: 'string' },
    'insert-a': { type: 'string' },
    'insert-b': { type: 'string' },
    'executable-path': { type: 'string' },
    'timeout-ms': { type: 'string' },
  },
  strict: true,
})

for (const required of ['url', 'project-id', 'project-name', 'insert-a', 'insert-b']) {
  if (!values[required]) throw new Error(`Missing required --${required}`)
}

const appUrl = new URL(values.url)
if (!['http:', 'https:'].includes(appUrl.protocol)) throw new Error('--url must be HTTP(S)')
const sessionToken = appUrl.searchParams.get('token')?.trim()
if (!sessionToken) throw new Error('--url must include the desktop session token query parameter')
const allowedOrigin = appUrl.origin
const projectId = values['project-id']
const projectName = values['project-name']
const firstInsertPath = values['insert-a']
const secondInsertPath = values['insert-b']
if (!/^[0-9a-f]{12}$/.test(projectId)) throw new Error('--project-id must be 12 lowercase hex characters')
await Promise.all([access(firstInsertPath), access(secondInsertPath)])

const timeout = Number(values['timeout-ms'] || 60_000)
if (!Number.isFinite(timeout) || timeout < 5_000) throw new Error('--timeout-ms must be at least 5000')
const executablePath = values['executable-path'] || process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const IDS = {
  filler: '0000000002',
  retake: ['0000000003', '0000000004', '0000000005'],
  gaps: ['0000000005'],
  anchor: '0000000009',
}
const INITIAL_INSERT_TEXT = 'Inserted six sixty passage'
const EDITED_INSERT_TEXT = 'Edited inserted passage'
const REPLACEMENT_INSERT_TEXT = 'Replacement eight eighty passage'
const EXPECTED_EXPORT_DURATION = 6.58

const runtimeFailures = []
const expectedAborts = []
const network = { saves: 0, renders: 0, recordingUploads: 0, exports: 0 }
let closing = false

function safeUrl(raw) {
  try {
    const parsed = new URL(raw)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return String(raw).split('?', 1)[0]
  }
}

function endpoint(responseOrRequest, method, pathname) {
  const request = typeof responseOrRequest.request === 'function'
    ? responseOrRequest.request()
    : responseOrRequest
  return request.method() === method && new URL(request.url()).pathname === pathname
}

function counts() {
  return { ...network }
}

function withoutRevision(state) {
  const clone = structuredClone(state)
  delete clone.revision
  // Opening an older fixture legitimately normalizes these persisted defaults
  // on its first save. Compare the semantic project state, not omitted legacy
  // fields versus their canonical local values.
  clone.noiseReduction ??= 'off'
  clone.normalizeLoudness ??= Boolean(clone.studioSound)
  clone.speakers ??= []
  clone.speakerByWord ??= {}
  clone.insertClips ??= []
  clone.collapsedRetakes ??= []
  clone.cleanupKeepWordIds ??= []
  clone.cleanupKeepGapIds ??= []
  // The backend serializes the optional ASR field as null for older fixture
  // rows. It is review metadata, not an editing mutation.
  clone.words = clone.words.map((word) => ({ ...word, asrConfidence: word.asrConfidence ?? null }))
  return clone
}

function assertRuntimeClean(stage) {
  assert.deepEqual(runtimeFailures, [], `${stage}: browser/runtime failures:\n${runtimeFailures.join('\n')}`)
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
await context.addInitScript(() => {
  window.localStorage.removeItem('scriptcut.timelineCollapsed')
  window.localStorage.removeItem('scriptcut.timelineSize')
})
await context.route('**/*', async (route) => {
  const target = new URL(route.request().url())
  if (['http:', 'https:'].includes(target.protocol) && target.origin !== allowedOrigin) {
    runtimeFailures.push(`external: ${target.origin}${target.pathname}`)
    await route.abort('blockedbyclient')
    return
  }
  await route.continue()
})
const page = await context.newPage()
page.setDefaultTimeout(timeout)

page.on('pageerror', (error) => runtimeFailures.push(`pageerror: ${error.stack || error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') runtimeFailures.push(`console: ${message.text()}`)
})
page.on('response', (response) => {
  const request = response.request()
  let parsed
  try { parsed = new URL(response.url()) } catch { return }
  if (parsed.origin !== allowedOrigin) return
  if (response.status() >= 400) {
    runtimeFailures.push(`http: ${response.status()} ${request.method()} ${safeUrl(response.url())}`)
  }
  if (response.status() !== 200) return
  if (endpoint(response, 'PUT', `/api/projects/${projectId}/state`)) network.saves += 1
  if (endpoint(response, 'POST', `/api/projects/${projectId}/render`)) network.renders += 1
  if (endpoint(response, 'POST', `/api/projects/${projectId}/recordings`)) network.recordingUploads += 1
  if (endpoint(response, 'POST', `/api/projects/${projectId}/export`)) network.exports += 1
})
page.on('requestfailed', (request) => {
  if (closing) return
  const failure = request.failure()?.errorText || 'unknown request failure'
  let parsed
  try { parsed = new URL(request.url()) } catch {
    runtimeFailures.push(`requestfailed: ${failure} ${safeUrl(request.url())}`)
    return
  }
  const expectedAudioAbort = failure.includes('ERR_ABORTED') && (
    parsed.protocol === 'blob:' ||
    (parsed.origin === allowedOrigin && parsed.pathname.startsWith(`/api/projects/${projectId}/audio`))
  )
  if (expectedAudioAbort) {
    expectedAborts.push(safeUrl(request.url()))
    return
  }
  runtimeFailures.push(`requestfailed: ${failure} ${safeUrl(request.url())}`)
})

async function getProjectState() {
  return page.evaluate(async ({ id }) => {
    const token = new URL(window.location.href).searchParams.get('token')
    if (!token) throw new Error('Desktop token is missing from the page URL')
    const response = await fetch(`/api/projects/${id}`, {
      headers: { 'X-ScriptCut-Token': token },
    })
    if (!response.ok) throw new Error(`Project state request failed (${response.status})`)
    const payload = await response.json()
    if (!payload.state) throw new Error('Project state is missing')
    return payload.state
  }, { id: projectId })
}

async function waitReady(stage) {
  const play = page.getByRole('button', { name: 'Play audio', exact: true })
  await play.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Play audio"]')
    return button instanceof HTMLButtonElement && !button.disabled
  })
  await page.getByText('Saved locally', { exact: true }).waitFor({ state: 'visible' })
  const alerts = await page.locator('[role="alert"]').allInnerTexts()
  assert.deepEqual(alerts, [], `${stage}: visible application alerts: ${alerts.join(' | ')}`)
  assertRuntimeClean(stage)
}

async function openFixtureProject(stage) {
  const project = page.getByTitle(projectName, { exact: true })
  await project.waitFor({ state: 'visible' })
  await project.click()
  await waitReady(stage)
}

function stateResponse(response) {
  return endpoint(response, 'PUT', `/api/projects/${projectId}/state`)
}

function renderResponse(response) {
  return endpoint(response, 'POST', `/api/projects/${projectId}/render`)
}

function recordingResponse(response) {
  return endpoint(response, 'POST', `/api/projects/${projectId}/recordings`)
}

async function runMutation(stage, action, { render = true, upload = false } = {}) {
  const beforeCounts = counts()
  const saved = page.waitForResponse(stateResponse)
  const rendered = render ? page.waitForResponse(renderResponse) : null
  const uploaded = upload ? page.waitForResponse(recordingResponse) : null
  try {
    await action()
  } catch (error) {
    // A selector/action error should remain visible. Otherwise browser.close()
    // rejects these deliberately armed observers and obscures the real cause.
    void saved.catch(() => undefined)
    if (rendered) void rendered.catch(() => undefined)
    if (uploaded) void uploaded.catch(() => undefined)
    throw error
  }
  if (uploaded) assert.equal((await uploaded).status(), 200, `${stage}: recording upload failed`)
  assert.equal((await saved).status(), 200, `${stage}: state save failed`)
  if (rendered) assert.equal((await rendered).status(), 200, `${stage}: render failed`)
  await waitReady(stage)
  assert.equal(network.saves, beforeCounts.saves + 1, `${stage}: expected exactly one state save`)
  assert.equal(network.renders, beforeCounts.renders + (render ? 1 : 0), `${stage}: unexpected render count`)
  assert.equal(network.recordingUploads, beforeCounts.recordingUploads + (upload ? 1 : 0), `${stage}: unexpected recording upload count`)
  return getProjectState()
}

async function chooseContextAction(trigger, name) {
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await menu.waitFor({ state: 'visible' })
  await menu.getByRole('menuitem', { name, exact: true }).click()
}

function wordById(id) {
  return page.locator(`[data-word-id="${id}"]`)
}

function insertById(id) {
  return page.locator(`[data-insert-id="${id}"]`)
}

function assertCleanupIsolation(kind, baseline, applied) {
  assert.deepEqual(applied.cleanupKeepWordIds, baseline.cleanupKeepWordIds, `${kind}: word keep policy changed`)
  assert.deepEqual(applied.cleanupKeepGapIds, baseline.cleanupKeepGapIds, `${kind}: gap keep policy changed`)
  assert.deepEqual(applied.insertClips, baseline.insertClips, `${kind}: inserts changed`)
  assert.equal(applied.studioSound, baseline.studioSound, `${kind}: Studio Sound changed`)

  if (kind === 'fillers') {
    const expectedWords = baseline.words.map((word) => word.id === IDS.filler
      ? { ...word, isFiller: true, isRemoved: true }
      : word)
    assert.deepEqual(applied.words, expectedWords, 'fillers: changed a non-filler word')
    assert.deepEqual(applied.shortenedGapIds, baseline.shortenedGapIds, 'fillers: changed gaps')
    assert.deepEqual(applied.collapsedRetakes, baseline.collapsedRetakes, 'fillers: changed retake groups')
    return
  }
  if (kind === 'gaps') {
    assert.deepEqual(applied.words, baseline.words, 'gaps: changed words')
    assert.deepEqual(applied.shortenedGapIds, IDS.gaps, 'gaps: wrong gaps were shortened')
    assert.deepEqual(applied.gapEdits, [{ afterWordId: IDS.gaps[0], targetGapMs: 250 }], 'gaps: exact pacing target was not persisted')
    assert.deepEqual(applied.collapsedRetakes, baseline.collapsedRetakes, 'gaps: changed retake groups')
    return
  }
  const retakeSet = new Set(IDS.retake)
  const expectedWords = baseline.words.map((word) => retakeSet.has(word.id)
    ? { ...word, isRetake: true, isRemoved: true }
    : word)
  assert.deepEqual(applied.words, expectedWords, 'retakes: changed words outside the earlier take')
  assert.deepEqual(applied.shortenedGapIds, baseline.shortenedGapIds, 'retakes: changed gaps')
  assert.deepEqual(applied.collapsedRetakes, [IDS.retake], 'retakes: wrong collapsed group')
}

const cleanupModes = [
  {
    kind: 'fillers',
    button: 'Remove fillers',
    dialog: 'Review filler removal',
    apply: 'Remove 1 filler word',
  },
]

async function exerciseCleanupMode(mode) {
  const baseline = await getProjectState()
  const beforePreviewCounts = counts()
  await page.getByRole('button', { name: mode.button, exact: true }).click()
  // The workbench's accessible label has a stable product prefix. Match the
  // requested review title rather than freezing a full label that is allowed
  // to evolve with the UI.
  let dialog = page.getByRole('dialog', { name: new RegExp(mode.dialog) })
  await dialog.waitFor({ state: 'visible' })
  if (mode.selectReviewOnly) await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: mode.apply, exact: true }).waitFor({ state: 'visible' })
  await page.waitForTimeout(900)
  assert.deepEqual(await getProjectState(), baseline, `${mode.kind}: preview mutated persisted state`)
  assert.deepEqual(counts(), beforePreviewCounts, `${mode.kind}: preview caused save/render traffic`)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForTimeout(900)
  assert.deepEqual(await getProjectState(), baseline, `${mode.kind}: Cancel mutated persisted state`)
  assert.deepEqual(counts(), beforePreviewCounts, `${mode.kind}: Cancel caused save/render traffic`)

  await page.getByRole('button', { name: mode.button, exact: true }).click()
  dialog = page.getByRole('dialog', { name: new RegExp(mode.dialog) })
  await dialog.waitFor({ state: 'visible' })
  if (mode.selectReviewOnly) await dialog.getByRole('checkbox').check()
  const applied = await runMutation(`apply ${mode.kind}`, async () => {
    await dialog.getByRole('button', { name: mode.apply, exact: true }).click()
  })
  assertCleanupIsolation(mode.kind, baseline, applied)

  const undone = await runMutation(`undo ${mode.kind}`, async () => {
    await page.getByRole('button', { name: /Undo/ }).click()
  })
  assert.deepEqual(withoutRevision(undone), withoutRevision(baseline), `${mode.kind}: Undo did not restore baseline`)
}

async function exerciseReviewControls() {
  const baseline = await getProjectState()
  const before = counts()

  await page.getByRole('button', { name: 'Original', exact: true }).click()
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button[aria-pressed="true"]'))
    .some((button) => button.textContent?.trim() === 'Original'))
  await page.getByRole('button', { name: 'Edited', exact: true }).click()
  await waitReady('return to edited A/B preview')
  assert.deepEqual(await getProjectState(), baseline, 'A/B preview mutated project state')
  assert.deepEqual(counts(), before, 'A/B preview caused save/render traffic')

  const speakerTrigger = wordById('0000000001')
  await speakerTrigger.focus()
  await speakerTrigger.press('Shift+S')
  const speakerDialog = page.getByRole('dialog', { name: 'Name this speaker', exact: true })
  await speakerDialog.waitFor({ state: 'visible' })
  await speakerDialog.getByLabel('Speaker name').fill('QA speaker')
  await speakerDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await speakerDialog.waitFor({ state: 'hidden' })
  assert.deepEqual(await getProjectState(), baseline, 'Speaker dialog Cancel mutated project state')
  assert.deepEqual(counts(), before, 'Speaker dialog Cancel caused save/render traffic')

  await page.getByRole('button', { name: 'Remove fillers', exact: true }).click()
  const review = page.getByRole('dialog', { name: /Review filler removal/ })
  await review.waitFor({ state: 'visible' })
  await review.getByRole('button', { name: 'Audition cut', exact: true }).click()
  await review.getByRole('button', { name: 'Cancel', exact: true }).click()
  await review.waitFor({ state: 'hidden' })
  assert.deepEqual(await getProjectState(), baseline, 'Cleanup audition/Cancel mutated project state')
  assert.deepEqual(counts(), before, 'Cleanup audition/Cancel caused save/render traffic')

  await page.getByRole('button', { name: 'Remove fillers', exact: true }).click()
  const keepReview = page.getByRole('dialog', { name: /Review filler removal/ })
  await keepReview.waitFor({ state: 'visible' })
  const kept = await runMutation('keep cleanup suggestion', async () => {
    await keepReview.getByRole('button', { name: 'Keep / ignore', exact: true }).click()
  }, { render: false })
  assert.deepEqual(kept.cleanupKeepWordIds, [IDS.filler], 'Keep / ignore did not persist the filler decision')
  const restored = await runMutation('undo keep cleanup suggestion', async () => {
    await page.getByRole('button', { name: /Undo/ }).click()
  })
  assert.deepEqual(withoutRevision(restored), withoutRevision(baseline), 'Undo did not restore the ignored cleanup suggestion')
}

async function exercisePacingPersistence() {
  const baseline = await getProjectState()
  await page.getByRole('button', { name: /^Pacing/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Pacing and gap editor', exact: true })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByLabel('Detect pauses at or over (ms)').fill('900')
  await dialog.getByLabel('Keep room tone (ms)').fill('250')
  const saved = await runMutation('set custom pacing', async () => {
    await dialog.getByRole('button', { name: 'Use this pacing', exact: true }).click()
  }, { render: false })
  assert.deepEqual(saved.gapPacing, { preset: 'custom', detectionThresholdMs: 900, targetGapMs: 250 }, 'Pacing values did not persist exactly')
  assert.deepEqual(saved.gapEdits, baseline.gapEdits ?? [], 'Pacing settings rewrote existing per-gap edits')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await openFixtureProject('reopen persisted pacing')
  const reopened = await getProjectState()
  assert.deepEqual(reopened.gapPacing, saved.gapPacing, 'Pacing values did not survive reopen')
}

async function assertWavExport(stage, revision) {
  const before = counts()
  const exported = await authenticatedExport(revision)
  assert.equal(exported.riff, 'RIFF', `${stage}: export RIFF header is missing`)
  assert.equal(exported.wave, 'WAVE', `${stage}: export WAVE header is missing`)
  assert.ok(exported.byteLength > 44, `${stage}: exported WAV is empty`)
  assert.match(exported.contentType || '', /^audio\/wav/i, `${stage}: export content type is not audio/wav`)
  assert.equal(network.exports, before.exports + 1, `${stage}: expected exactly one WAV export request`)
  return exported
}

async function exerciseAppliedGapWorkflow() {
  const baseline = await getProjectState()
  await page.getByRole('button', { name: 'Shorten gaps', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Review gap shortening/ })
  await dialog.waitFor({ state: 'visible' })
  const suggestions = dialog.getByLabel(/Select cleanup suggestion at/)
  assert.ok(await suggestions.count() >= 1, 'Custom pacing did not produce a reviewable gap suggestion')
  await suggestions.first().check()
  const applied = await runMutation('apply custom pacing gap', async () => {
    await dialog.getByRole('button', { name: /^Shorten \d+ gap/ }).click()
  })
  assert.deepEqual(applied.gapPacing, baseline.gapPacing, 'Applying a gap changed the selected pacing policy')
  assert.deepEqual(applied.shortenedGapIds, IDS.gaps, 'Custom pacing applied the wrong gap')
  assert.deepEqual(applied.gapEdits, [{ afterWordId: IDS.gaps[0], targetGapMs: 250 }], 'Custom target gap was not persisted with the applied edit')
  assert.deepEqual(applied.words, baseline.words, 'Gap shortening changed transcript words')

  const activeExport = await assertWavExport('active custom pacing gap', applied.revision)
  assert.ok(activeExport.duration < 5.9, `Active gap export (${activeExport.duration.toFixed(3)}s) did not include the pause reduction`)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await openFixtureProject('reopen applied custom pacing gap')
  const reopened = await getProjectState()
  assert.deepEqual(reopened.gapPacing, baseline.gapPacing, 'Custom pacing policy did not survive applied-gap reopen')
  assert.deepEqual(reopened.shortenedGapIds, applied.shortenedGapIds, 'Applied gap did not survive reopen')
  assert.deepEqual(reopened.gapEdits, applied.gapEdits, 'Applied exact gap target did not survive reopen')

  const gapPill = page.locator(`[data-gap-after-word-id="${IDS.gaps[0]}"]`)
  await gapPill.waitFor({ state: 'visible' })
  const restored = await runMutation('restore applied custom pacing gap', async () => {
    await gapPill.click()
  })
  assert.deepEqual(restored.shortenedGapIds, baseline.shortenedGapIds, 'Restoring the applied gap did not clear the legacy projection')
  assert.deepEqual(restored.gapEdits, baseline.gapEdits ?? [], 'Restoring the applied gap did not clear the exact target')
  assert.deepEqual(restored.gapPacing, baseline.gapPacing, 'Restoring a gap changed the selected pacing policy')
}

async function retakeCandidateCount(stage) {
  const baseline = await getProjectState()
  const before = counts()
  await page.getByRole('button', { name: 'Remove retakes', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Review retake removal/ })
  await dialog.waitFor({ state: 'visible' })
  const count = await dialog.locator('input[type="radio"]').count()
  assert.ok(count >= 2 && count % 2 === 0, `${stage}: retake review did not expose paired candidate takes`)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(await getProjectState(), baseline, `${stage}: retake detection preview mutated persisted state`)
  assert.deepEqual(counts(), before, `${stage}: retake detection preview caused save/render traffic`)
  return count
}

async function markerTitleField(dialog, expectedTitle) {
  const inputs = dialog.locator('input')
  const index = await inputs.evaluateAll((nodes, title) => nodes.findIndex((node) => (
    node instanceof HTMLInputElement && node.value === title
  )), expectedTitle)
  assert.ok(index >= 0, `Marker title field was not found: ${expectedTitle}`)
  return inputs.nth(index)
}

async function exerciseRetakeAlternateWorkflow() {
  const baseline = await getProjectState()
  const beforePreviewCounts = counts()
  await page.getByRole('button', { name: 'Remove retakes', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Review retake removal/ })
  await dialog.waitFor({ state: 'visible' })
  const candidates = dialog.locator('input[type="radio"]')
  assert.equal(await candidates.count(), 2, 'Fixture retake review did not expose exactly two alternate takes')
  const recommendedIndex = await candidates.evaluateAll((nodes) => nodes.findIndex((node) => node.getAttribute('title') === 'Recommended take'))
  assert.ok(recommendedIndex >= 0, 'Retake review did not identify a recommended take')
  const alternateIndex = recommendedIndex === 0 ? 1 : 0

  const audition = dialog.getByRole('button', { name: 'Audition', exact: true }).nth(alternateIndex)
  await audition.click()
  await page.waitForFunction(() => Boolean(document.querySelector('button[aria-label="Pause audio"]')), undefined, { timeout: Math.min(timeout, 3_000) })
  const pause = page.locator('button[aria-label="Pause audio"]')
  if (await pause.isVisible()) await pause.click()
  await page.waitForTimeout(100)
  assert.deepEqual(await getProjectState(), baseline, 'Candidate audition mutated persisted retake state')
  assert.deepEqual(counts(), beforePreviewCounts, 'Candidate audition caused save/render traffic')

  await candidates.nth(alternateIndex).check()
  await page.waitForTimeout(100)
  assert.deepEqual(await getProjectState(), baseline, 'Choosing an alternate in review mutated persisted state before Apply')
  assert.deepEqual(counts(), beforePreviewCounts, 'Choosing an alternate in review caused save/render traffic before Apply')

  const applied = await runMutation('apply nonrecommended retake alternate', async () => {
    await dialog.getByRole('button', { name: /^Remove \d+ retake words$/ }).click()
  })
  const durable = applied.retakeGroups.at(-1)
  assert.ok(durable, 'Applied retake did not persist a durable alternate-take group')
  assert.notEqual(durable.selectedKeepIndex, durable.recommendedKeepIndex, 'Applied retake did not retain the explicitly chosen nonrecommended take')
  const keptIds = new Set(durable.candidates[durable.selectedKeepIndex])
  const removedIds = durable.candidates
    .filter((_candidate, index) => index !== durable.selectedKeepIndex)
    .flat()
  assert.ok(removedIds.length > 0, 'Alternate retake choice did not identify a removed take')
  for (const id of durable.candidates.flat()) {
    const word = applied.words.find((candidate) => candidate.id === id)
    assert.ok(word, `Applied retake lost candidate word ${id}`)
    assert.equal(word.isRemoved, !keptIds.has(id), 'Applied retake did not keep exactly the chosen alternate')
  }
  assert.ok(
    applied.collapsedRetakes.some((group) => group.length === removedIds.length && group.every((id) => removedIds.includes(id))),
    'Applied retake did not preserve its legacy removed-word projection',
  )
  assert.deepEqual(applied.markers, baseline.markers, 'Applying a retake changed existing marker anchors')

  const activeExport = await assertWavExport('active nonrecommended retake', applied.revision)
  assert.ok(activeExport.duration < 5.9, `Active retake export (${activeExport.duration.toFixed(3)}s) did not include the chosen removal`)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await openFixtureProject('reopen applied nonrecommended retake')
  const reopened = await getProjectState()
  const reopenedGroup = reopened.retakeGroups.find((group) => group.id === durable.id)
  assert.deepEqual(reopenedGroup, durable, 'Applied alternate-take choice did not survive reopen')
  for (const id of durable.candidates.flat()) {
    const word = reopened.words.find((candidate) => candidate.id === id)
    assert.equal(word?.isRemoved, !keptIds.has(id), 'Reopened retake did not retain the chosen alternate')
  }

  const retakePill = page.locator(`[data-retake-group="${durable.id}"]`)
  await retakePill.waitFor({ state: 'visible' })
  const restored = await runMutation('restore durable alternate retake group', async () => {
    await retakePill.click()
  })
  assert.deepEqual(
    restored.retakeGroups.find((group) => group.id === durable.id),
    durable,
    'Restoring a retake discarded the durable alternate-take choice',
  )
  for (const id of durable.candidates.flat()) {
    const word = restored.words.find((candidate) => candidate.id === id)
    assert.equal(word?.isRemoved, false, 'Restoring the retake group did not restore every take')
  }
  assert.ok(!restored.collapsedRetakes.some((group) => group.some((id) => durable.candidates.flat().includes(id))), 'Restoring the retake group left a removed legacy projection')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await openFixtureProject('reopen restored durable retake group')
  const reopenedRestored = await getProjectState()
  assert.deepEqual(
    reopenedRestored.retakeGroups.find((group) => group.id === durable.id),
    durable,
    'Restored retake group lost its alternate-take choice after reopen',
  )
  for (const id of durable.candidates.flat()) {
    assert.equal(reopenedRestored.words.find((candidate) => candidate.id === id)?.isRemoved, false, 'Restored retake word did not survive reopen')
  }
}

async function exerciseMarkers() {
  const baseline = await getProjectState()
  await page.getByRole('button', { name: 'Markers', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Markers and chapters', exact: true })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByPlaceholder('Optional title at playhead').fill('QA marker')
  const created = await runMutation('create marker', async () => {
    await dialog.getByRole('button', { name: 'Add marker', exact: true }).click()
  }, { render: false })
  const marker = created.markers.find((item) => item.title === 'QA marker')
  assert.ok(marker, 'Created marker was not persisted')

  const undoneCreate = await runMutation('undo marker creation', async () => {
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click()
  })
  assert.deepEqual(undoneCreate.markers, baseline.markers ?? [], 'Undo did not remove the newly created marker')
  const redoneCreate = await runMutation('redo marker creation', async () => {
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)').click()
  })
  assert.deepEqual(redoneCreate.markers, created.markers, 'Redo did not restore the newly created marker')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openFixtureProject('reopen redone marker')
  dialog = page.getByRole('dialog', { name: 'Markers and chapters', exact: true })
  // Reopen the marker panel after the project reload; the save/reopen check
  // deliberately exercises the persisted state rather than the local history.
  await page.getByRole('button', { name: 'Markers', exact: true }).click()
  await dialog.waitFor({ state: 'visible' })
  const redoneReopened = await getProjectState()
  assert.deepEqual(redoneReopened.markers, created.markers, 'Redone marker did not survive reopen')

  const renamedTitle = 'QA marker renamed'
  const renamed = await runMutation('rename marker', async () => {
    const title = dialog.getByLabel(/Title for marker at/, { exact: false })
    await title.first().fill(renamedTitle)
    await title.first().press('Enter')
  }, { render: false })
  const renamedMarker = renamed.markers.find((item) => item.id === marker.id)
  assert.equal(renamedMarker?.title, renamedTitle, 'Marker rename did not persist')

  const positionInput = dialog.getByLabel(`Edited position in seconds for ${renamedTitle}`, { exact: true })
  const positioned = await runMutation('move marker by exact edited time', async () => {
    await positionInput.fill('2.000')
    await positionInput.press('Enter')
  }, { render: false })
  const positionedMarker = positioned.markers.find((item) => item.id === marker.id)
  assert.ok(positionedMarker, 'Exact-position move removed the marker')
  assert.ok(Math.abs(positionedMarker.anchor.sourceTime - 2) < 0.001, 'Exact-position move did not preserve a source-time anchor')

  const seekBefore = counts()
  await dialog.getByTitle('Seek to this marker').first().click()
  const seekReadout = page.locator('[aria-label*=" of "]')
  await seekReadout.waitFor({ state: 'visible' })
  const seekText = await seekReadout.getAttribute('aria-label')
  const seekMatch = seekText?.match(/^(\d+):(\d{2})\.(\d{2}) of/)
  assert.ok(seekMatch, `Marker seek did not expose a readable transport position (${seekText || 'missing'})`)
  const seekSeconds = Number(seekMatch[1]) * 60 + Number(seekMatch[2]) + Number(seekMatch[3]) / 100
  assert.ok(Math.abs(seekSeconds - 2) <= 0.05, `Marker seek missed its anchor by more than 50 ms (${seekSeconds.toFixed(3)}s)`)
  assert.deepEqual(counts(), seekBefore, 'Marker seek unexpectedly saved or rendered the project')

  await dialog.getByPlaceholder('Optional title at playhead').fill('QA marker same time')
  const duplicated = await runMutation('create equal-time marker', async () => {
    await dialog.getByRole('button', { name: 'Add marker', exact: true }).click()
  }, { render: false })
  const equalTimeMarker = duplicated.markers.find((item) => item.title === 'QA marker same time')
  assert.ok(equalTimeMarker, 'Equal-time marker was not persisted')
  assert.ok(Math.abs(equalTimeMarker.anchor.sourceTime - 2) < 0.001, 'Equal-time marker did not use the current marker playhead')
  const markerOrder = duplicated.markers.filter((item) => item.anchor.sourceTime === 2).map((item) => item.id)
  assert.deepEqual(markerOrder, [marker.id, equalTimeMarker.id], 'Markers at the same time did not retain their saved order')

  const annotation = page.locator(`[part~="annotation-${marker.id}"]`)
  await annotation.waitFor({ state: 'visible' })
  const annotationBox = await annotation.boundingBox()
  const waveformBox = await page.locator('#audio-waveform-content').boundingBox()
  assert.ok(annotationBox && waveformBox, 'Marker annotation is not rendered in the waveform')
  // Use a relative move: project state deliberately stores immutable edit data,
  // not display duration. A 15% waveform drag is enough to prove the live
  // region handler maps the drop back to a durable source anchor.
  const dragDistance = waveformBox.width * 0.15
  const dragged = await runMutation('drag marker in waveform', async () => {
    await page.mouse.move(annotationBox.x + Math.max(1, annotationBox.width / 2), annotationBox.y + Math.max(2, annotationBox.height / 2))
    await page.mouse.down()
    await page.mouse.move(annotationBox.x + Math.max(1, annotationBox.width / 2) + dragDistance, annotationBox.y + Math.max(2, annotationBox.height / 2), { steps: 6 })
    await page.mouse.up()
  }, { render: false })
  // Equal-time annotations intentionally overlap. The topmost annotation is
  // the one that receives the pointer event, so prove that exactly one of the
  // two durable anchors moved instead of assuming a paint-order-specific ID.
  const draggedEqualTimeMarkers = [marker.id, equalTimeMarker.id]
    .map((id) => dragged.markers.find((item) => item.id === id))
    .filter(Boolean)
  const movedByDrag = draggedEqualTimeMarkers.filter((item) => Math.abs(item.anchor.sourceTime - 2) > 0.1)
  assert.equal(movedByDrag.length, 1, 'Waveform drag did not update exactly one equal-time marker anchor')
  assert.ok(movedByDrag[0].anchor.sourceTime > 2.5, 'Waveform drag did not update the marker anchor by the expected direction')

  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  const baselineRetakeCandidates = await retakeCandidateCount('baseline noise retake detection')
  // Noise cleanup is a render-layer preference. Exercising every strength here
  // proves it neither changes canonical transcript words nor re-anchors a
  // marker that was just moved in the waveform or changes retake detection.
  for (const level of ['light', 'medium', 'strong', 'off']) {
    const noiseState = await runMutation(`set noise cleanup ${level}`, async () => {
      await page.getByLabel('Background noise cleanup', { exact: true }).selectOption(level)
    })
    assert.equal(noiseState.noiseReduction, level, `Noise cleanup ${level} did not persist`)
    assert.deepEqual(noiseState.words, dragged.words, `Noise cleanup ${level} changed canonical transcript words`)
    assert.deepEqual(noiseState.markers, dragged.markers, `Noise cleanup ${level} changed marker anchors`)
    assert.equal(await retakeCandidateCount(`noise cleanup ${level}`), baselineRetakeCandidates, `Noise cleanup ${level} changed retake candidate detection`)
  }

  await page.reload({ waitUntil: 'domcontentloaded' })
  await openFixtureProject('reopen moved marker')
  const reopened = await getProjectState()
  assert.deepEqual(reopened.markers, dragged.markers, 'Dragged marker anchors did not survive reopen')

  await page.getByRole('button', { name: 'Markers', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Markers and chapters', exact: true })
  await dialog.waitFor({ state: 'visible' })
  let deleted = await runMutation('delete dragged marker', async () => {
    const title = await markerTitleField(dialog, renamedTitle)
    await title.locator('xpath=..').getByRole('button', { name: 'Delete', exact: true }).click()
  }, { render: false })
  deleted = await runMutation('delete equal-time marker', async () => {
    const title = await markerTitleField(dialog, 'QA marker same time')
    await title.locator('xpath=..').getByRole('button', { name: 'Delete', exact: true }).click()
  }, { render: false })
  assert.deepEqual(deleted.markers, baseline.markers ?? [], 'Marker delete did not restore the original marker state')
}

async function exerciseTimelineVisibility() {
  const baseline = await getProjectState()
  const before = counts()
  const sizeControls = page.getByRole('group', { name: 'Timeline size', exact: true })
  const full = sizeControls.getByRole('button', { name: 'Full', exact: true })
  const hide = sizeControls.getByRole('button', { name: 'Hide', exact: true })
  assert.equal(await hide.isEnabled(), true, 'Hide timeline is not available')

  // Full -> Hide -> Show must restore Full, rather than silently shrinking the
  // editor. The same control also covers the user-facing Compact alternative.
  await full.click()
  assert.equal(await full.getAttribute('aria-pressed'), 'true', 'Full timeline did not activate')
  await hide.click()
  const show = page.getByRole('button', { name: 'Show timeline', exact: true })
  await show.waitFor({ state: 'visible' })
  assert.equal(await show.getAttribute('aria-expanded'), 'false', 'Timeline did not collapse')
  assert.equal(await page.locator('#audio-waveform-content').getAttribute('aria-hidden'), 'true', 'Waveform remained exposed')
  assert.equal(await page.getByRole('button', { name: 'Play audio', exact: true }).isEnabled(), true, 'Playback became unavailable while hidden')
  await page.waitForTimeout(900)
  assert.deepEqual(await getProjectState(), baseline, 'Hide timeline mutated project state')
  assert.deepEqual(counts(), before, 'Hide timeline caused save/render traffic')

  await show.click()
  await full.waitFor({ state: 'visible' })
  assert.equal(await full.getAttribute('aria-pressed'), 'true', 'Show did not restore the prior full timeline size')
  assert.equal(await page.locator('#audio-waveform-content').getAttribute('aria-hidden'), 'false', 'Waveform remained hidden')
  assert.equal(await page.getByRole('button', { name: 'Play audio', exact: true }).isEnabled(), true, 'Playback was not ready after showing timeline')
  await page.waitForTimeout(900)
  assert.deepEqual(await getProjectState(), baseline, 'Show timeline mutated project state')
  assert.deepEqual(counts(), before, 'Show timeline caused save/render traffic')
}

async function importInsertAfterAnchor() {
  const state = await runMutation('import insert', async () => {
    await chooseContextAction(wordById(IDS.anchor), 'Record after this word')
    const dialog = page.getByRole('dialog', { name: 'Record an insert', exact: true })
    await dialog.waitFor({ state: 'visible' })
    assert.match(await dialog.innerText(), /after.+finish/is, 'Recording dialog did not identify the exact anchor word')
    await dialog.getByLabel('Import insert audio', { exact: true }).setInputFiles(firstInsertPath)
    await dialog.getByRole('textbox', { name: /Spoken transcript/ }).fill(INITIAL_INSERT_TEXT)
    await dialog.getByRole('button', { name: 'Save insert', exact: true }).click()
  }, { upload: true })

  assert.equal(state.insertClips.length, 1, 'Insert was not added')
  const clip = state.insertClips[0]
  assert.match(clip.id, /^[0-9a-f]{12}$/, 'Logical insert ID is invalid')
  assert.match(clip.clipId, /^[0-9a-f]{12}$/, 'Uploaded clip ID is invalid')
  assert.equal(clip.afterWordId, IDS.anchor, 'Insert anchor word was not persisted')
  assert.ok(Math.abs(clip.sourceTime - 4.7) < 0.001, 'Insert source boundary is wrong')
  assert.ok(Math.abs(clip.duration - 0.6) < 0.01, 'First insert duration is wrong')
  assert.equal(clip.text, INITIAL_INSERT_TEXT, 'Typed insert transcript was not persisted')
  assert.equal(clip.isRemoved, false, 'New insert started removed')
  return clip
}

async function reloadAndAssertInsert(expected) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openFixtureProject('reload inserted recording')
  const state = await getProjectState()
  const clip = state.insertClips.find((item) => item.id === expected.id)
  assert.deepEqual(clip, expected, 'Inserted recording did not survive reload')
  await insertById(expected.id).waitFor({ state: 'visible' })
}

async function editRemoveRestoreInsert(insertId) {
  const beforeEditRenders = network.renders
  let state = await runMutation('edit insert transcript', async () => {
    await chooseContextAction(insertById(insertId), 'Edit text')
    const editor = page.getByRole('textbox', { name: /Edit inserted transcript/ })
    await editor.fill(EDITED_INSERT_TEXT)
    await editor.press('Enter')
  }, { render: false })
  assert.equal(network.renders, beforeEditRenders, 'Text-only insert edit rendered audio')
  assert.equal(state.insertClips.find((clip) => clip.id === insertId)?.text, EDITED_INSERT_TEXT, 'Insert text edit did not persist')

  state = await runMutation('remove insert', async () => {
    await chooseContextAction(insertById(insertId), 'Remove inserted audio')
  })
  assert.equal(state.insertClips.find((clip) => clip.id === insertId)?.isRemoved, true, 'Insert removal did not persist')

  state = await runMutation('restore insert', async () => {
    await chooseContextAction(insertById(insertId), 'Restore inserted audio')
  })
  const restored = state.insertClips.find((clip) => clip.id === insertId)
  assert.equal(restored?.isRemoved, false, 'Insert restoration did not persist')
  assert.equal(restored?.text, EDITED_INSERT_TEXT, 'Remove/restore changed insert text')
  return restored
}

async function rerecordAndUndo(previous) {
  const replacedState = await runMutation('re-record insert', async () => {
    await chooseContextAction(insertById(previous.id), 'Re-record audio')
    const dialog = page.getByRole('dialog', { name: 'Re-record inserted audio', exact: true })
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByLabel('Import insert audio', { exact: true }).setInputFiles(secondInsertPath)
    await dialog.getByRole('textbox', { name: /Spoken transcript/ }).fill(REPLACEMENT_INSERT_TEXT)
    await dialog.getByRole('button', { name: 'Replace recording', exact: true }).click()
  }, { upload: true })
  const replaced = replacedState.insertClips.find((clip) => clip.id === previous.id)
  assert.equal(replaced?.id, previous.id, 'Re-record changed the logical insert ID')
  assert.notEqual(replaced?.clipId, previous.clipId, 'Re-record reused the old immutable clip ID')
  assert.ok(Math.abs(replaced.duration - 0.9) < 0.01, 'Replacement duration is wrong')
  assert.equal(replaced.text, REPLACEMENT_INSERT_TEXT, 'Replacement transcript did not persist')
  assert.equal(replaced.afterWordId, previous.afterWordId, 'Re-record changed transcript placement')
  assert.equal(replaced.sourceTime, previous.sourceTime, 'Re-record changed source placement')

  const undoneState = await runMutation('undo re-record', async () => {
    await page.getByRole('button', { name: /Undo/ }).click()
  })
  const undone = undoneState.insertClips.find((clip) => clip.id === previous.id)
  assert.deepEqual(undone, previous, 'One Undo did not restore both the prior clip and transcript')
  return { replaced, undone, state: undoneState }
}

async function authenticatedExport(revision) {
  return page.evaluate(async ({ id, expectedRevision }) => {
    const token = new URL(window.location.href).searchParams.get('token')
    if (!token) throw new Error('Desktop token is missing for export')
    const response = await fetch(`/api/projects/${id}/export?studio=false&revision=${expectedRevision}`, {
      method: 'POST',
      headers: { 'X-ScriptCut-Token': token },
    })
    if (!response.ok) throw new Error(`Export failed (${response.status})`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length))
    if (bytes.length < 44 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') {
      throw new Error('Export is not a RIFF/WAVE file')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = 12
    let byteRate = 0
    let dataBytes = -1
    while (offset + 8 <= bytes.length) {
      const chunk = ascii(offset, 4)
      const size = view.getUint32(offset + 4, true)
      const dataStart = offset + 8
      if (chunk === 'fmt ' && size >= 12 && dataStart + size <= bytes.length) {
        byteRate = view.getUint32(dataStart + 8, true)
      }
      if (chunk === 'data') {
        dataBytes = Math.min(size, bytes.length - dataStart)
        break
      }
      offset = dataStart + size + (size % 2)
    }
    if (!byteRate || dataBytes < 0) throw new Error('Export WAV chunks are incomplete')
    return {
      byteLength: bytes.length,
      contentType: response.headers.get('content-type'),
      riff: ascii(0, 4),
      wave: ascii(8, 4),
      duration: dataBytes / byteRate,
    }
  }, { id: projectId, expectedRevision: revision })
}

try {
  await page.goto(appUrl.toString(), { waitUntil: 'domcontentloaded' })
  await openFixtureProject('initial project open')
  const initialState = await getProjectState()
  assert.equal(initialState.revision, 1, 'Fixture did not start at revision 1')
  assert.deepEqual(initialState.insertClips, [], 'Fixture unexpectedly contains inserts')

  await exerciseReviewControls()
  await exercisePacingPersistence()
  await exerciseAppliedGapWorkflow()
  await exerciseMarkers()
  await exerciseRetakeAlternateWorkflow()
  for (const mode of cleanupModes) await exerciseCleanupMode(mode)
  await exerciseTimelineVisibility()

  const created = await importInsertAfterAnchor()
  await reloadAndAssertInsert(created)
  const restored = await editRemoveRestoreInsert(created.id)
  const { replaced, undone, state: finalState } = await rerecordAndUndo(restored)

  const exported = await assertWavExport('final inserted edit', finalState.revision)
  assert.ok(
    Math.abs(exported.duration - EXPECTED_EXPORT_DURATION) < 0.03,
    `Export duration ${exported.duration.toFixed(3)}s did not match ${EXPECTED_EXPORT_DURATION.toFixed(3)}s`,
  )
  assertRuntimeClean('final')

  process.stdout.write(`${JSON.stringify({
    cleanupModes: cleanupModes.map((mode) => mode.kind),
    originalEditedComparisonIsLocalOnly: true,
    speakerDialogCancelIsNonMutating: true,
    cleanupAuditionIsNonMutating: true,
    cleanupKeepIgnorePersistsAndUndoes: true,
    cleanupPreviewCancelIsNonMutating: true,
    cleanupApplyIsolationAndUndo: true,
    pacingPersistsWithExactGapTarget: true,
    appliedCustomGapPersistsRestoresAndExports: true,
    retakeCandidateAuditionAlternateApplyRestoreAndExport: true,
    markerCreateRenameUndoRedoMoveDuplicateDragSeekDeleteAndReopen: true,
    noiseCleanupPreservesTranscriptMarkersAndRetakeDetectionAtEveryStrength: true,
    timelineHideShowIsLocalOnly: true,
    playbackReadyWhileTimelineHidden: true,
    insert: {
      logicalId: undone.id,
      originalClipId: undone.clipId,
      replacementClipId: replaced.clipId,
      reRecordPreservedLogicalId: replaced.id === undone.id,
      oneUndoRestoredClipAndText: true,
    },
    export: exported,
    network,
    expectedAudioAbortCount: expectedAborts.length,
    runtimeFailures,
  }, null, 2)}\n`)
} finally {
  closing = true
  await browser.close()
}
