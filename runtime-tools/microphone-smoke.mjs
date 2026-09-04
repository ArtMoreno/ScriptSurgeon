import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright-core'

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    'project-name': { type: 'string' },
    screenshot: { type: 'string' },
    'timeout-ms': { type: 'string' },
  },
  strict: true,
})

for (const required of ['endpoint', 'project-name']) {
  if (!values[required]) throw new Error(`Missing required --${required}`)
}

const timeout = Number(values['timeout-ms'] || 60_000)
const sleep = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
let browser
for (let attempt = 0; attempt < 160; attempt += 1) {
  try {
    browser = await chromium.connectOverCDP(values.endpoint)
    break
  } catch {
    await sleep(250)
  }
}
if (!browser) throw new Error(`WebView2 DevTools endpoint did not become ready at ${values.endpoint}`)

const pages = browser.contexts().flatMap((context) => context.pages())
const page = pages.find((candidate) => candidate.url().startsWith('http://127.0.0.1:')) || pages[0]
if (!page) throw new Error('The ScriptSurgeon WebView page was not found')
page.setDefaultTimeout(timeout)

const failures = []
const network = { uploads: 0, saves: 0, renders: 0 }
let uploadContentType = ''
let closing = false
const origin = new URL(page.url()).origin

page.on('pageerror', (error) => failures.push(`pageerror: ${error.stack || error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') failures.push(`console: ${message.text()}`)
})
page.on('request', (request) => {
  const target = new URL(request.url())
  if (['http:', 'https:'].includes(target.protocol) && target.origin !== origin) {
    failures.push(`external request: ${target.origin}${target.pathname}`)
  }
  if (request.method() === 'POST' && /\/recordings$/.test(target.pathname)) {
    uploadContentType = request.headers()['content-type'] || ''
  }
})
page.on('response', (response) => {
  const request = response.request()
  const target = new URL(response.url())
  if (target.origin !== origin) return
  if (response.status() >= 400) {
    failures.push(`http ${response.status()}: ${request.method()} ${target.pathname}`)
    return
  }
  if (request.method() === 'POST' && /\/recordings$/.test(target.pathname)) network.uploads += 1
  if (request.method() === 'PUT' && /\/state$/.test(target.pathname)) network.saves += 1
  if (request.method() === 'POST' && /\/render$/.test(target.pathname)) network.renders += 1
})
page.on('requestfailed', (request) => {
  if (closing) return
  const reason = request.failure()?.errorText || 'unknown'
  const target = new URL(request.url())
  const expectedAbort = reason.includes('ERR_ABORTED') && (
    target.protocol === 'blob:' || target.pathname.includes('/audio')
  )
  if (!expectedAbort) failures.push(`request failed: ${reason} ${target.pathname}`)
})

async function projectState() {
  return page.evaluate(async () => {
    const token = new URL(window.location.href).searchParams.get('token')
    const selected = document.querySelector('main h1')?.textContent
    const list = await fetch('/api/projects', { headers: { 'X-ScriptCut-Token': token || '' } })
    if (!list.ok) throw new Error(`Project list failed (${list.status})`)
    const projects = await list.json()
    const project = projects.find((item) => item.name === selected)
    if (!project) throw new Error(`Selected project was not found: ${selected}`)
    const response = await fetch(`/api/projects/${project.id}`, {
      headers: { 'X-ScriptCut-Token': token || '' },
    })
    if (!response.ok) throw new Error(`Project state failed (${response.status})`)
    return (await response.json()).state
  })
}

try {
  await page.waitForLoadState('domcontentloaded')
  const capabilities = await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasMediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
    hasMediaRecorder: typeof MediaRecorder === 'function',
    supportedTypes: typeof MediaRecorder === 'function'
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].filter((type) => MediaRecorder.isTypeSupported(type))
      : [],
  }))
  assert.equal(capabilities.isSecureContext, true, 'Loopback page is not a secure context')
  assert.equal(capabilities.hasMediaDevices, true, 'getUserMedia is unavailable')
  assert.equal(capabilities.hasMediaRecorder, true, 'MediaRecorder is unavailable')

  await page.getByTitle(values['project-name'], { exact: true }).click()
  const play = page.getByRole('button', { name: 'Play audio', exact: true })
  await play.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Play audio"]')
    return button instanceof HTMLButtonElement && !button.disabled
  })
  const before = await projectState()
  assert.deepEqual(before.insertClips || [], [], 'Fixture already contains inserted audio')
  const beforeNetwork = { ...network }

  await page.getByRole('button', { name: 'Record insert', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Record an insert', exact: true })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Record', exact: true }).click()
  await dialog.getByRole('button', { name: 'Stop recording', exact: true }).waitFor()
  await page.waitForTimeout(1_250)
  await dialog.getByRole('button', { name: 'Stop recording', exact: true }).click()
  await dialog.getByLabel('Preview inserted audio').waitFor()
  await dialog.getByLabel('Spoken transcript').fill('Recorded through the packaged microphone flow')

  const renderResponse = page.waitForResponse((response) => {
    const request = response.request()
    return request.method() === 'POST' && /\/render(?:\?|$)/.test(response.url()) && response.status() === 200
  })
  await dialog.getByRole('button', { name: 'Save insert', exact: true }).click()
  await renderResponse
  await page.getByText('Saved locally', { exact: true }).waitFor()
  const after = await projectState()
  assert.equal(after.insertClips.length, 1, 'Microphone recording was not persisted')
  const inserted = after.insertClips[0]
  assert.equal(inserted.text, 'Recorded through the packaged microphone flow')
  assert.ok(inserted.duration > 0.5, `Recorded clip was unexpectedly short (${inserted.duration})`)
  assert.match(uploadContentType, /^multipart\/form-data;/i, 'Recording upload was not multipart form data')
  assert.deepEqual({
    uploads: network.uploads - beforeNetwork.uploads,
    saves: network.saves - beforeNetwork.saves,
    renders: network.renders - beforeNetwork.renders,
  }, { uploads: 1, saves: 1, renders: 1 })
  assert.deepEqual(failures, [], failures.join('\n'))

  let screenshot = null
  if (values.screenshot) {
    screenshot = resolve(values.screenshot)
    await mkdir(dirname(screenshot), { recursive: true })
    await page.screenshot({ path: screenshot, fullPage: false })
  }

  process.stdout.write(`${JSON.stringify({
    capabilities,
    clip: {
      id: inserted.id,
      clipId: inserted.clipId,
      duration: inserted.duration,
      text: inserted.text,
    },
    network,
    uploadContentType: uploadContentType.split(';', 1)[0],
    screenshot,
    failures,
  }, null, 2)}\n`)
} finally {
  closing = true
  await browser.close()
}
