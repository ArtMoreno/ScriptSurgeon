import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultRecordingProjectName,
  normalizeProjectName,
  projectNameFromFilename,
  PROJECT_NAME_MAX_LENGTH,
} from './projectRecording.ts'
import { api } from './api.ts'
import { PRODUCT_FILE_STEM, PRODUCT_NAME } from './branding.ts'

test('public product metadata uses the ScriptSurgeon brand', () => {
  assert.equal(PRODUCT_NAME, 'ScriptSurgeon')
  assert.equal(PRODUCT_FILE_STEM, 'scriptsurgeon')
})

test('new recording names include a stable local date and time', () => {
  assert.equal(
    defaultRecordingProjectName(new Date('2026-08-09T04:15:00Z'), 'en-US', 'America/Phoenix'),
    'New recording - Aug 8, 2026, 9:15 PM',
  )
})

test('imported filenames become bounded project names', () => {
  assert.equal(projectNameFromFilename('C:\\captures\\voice.take.webm'), 'voice.take')
  assert.equal(projectNameFromFilename(' interview.wav '), 'interview')
  assert.equal(projectNameFromFilename('.webm'), '')
  assert.equal(normalizeProjectName(`  ${'a'.repeat(200)}  `).length, PROJECT_NAME_MAX_LENGTH)
})

test('recorded project uploads add a name without changing ordinary imports', async () => {
  const originalFetch = globalThis.fetch
  const forms: FormData[] = []
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'POST')
    assert.ok(init?.body instanceof FormData)
    forms.push(init.body)
    return new Response(JSON.stringify({ id: '0123456789ab', name: 'Recorded project' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const file = new File(['audio'], 'take.webm', { type: 'audio/webm' })
    await api.upload(file, undefined, 'Recorded project')
    await api.upload(file)
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(forms.length, 2)
  assert.equal(forms[0].get('name'), 'Recorded project')
  assert.equal(forms[1].has('name'), false)
  assert.equal((forms[0].get('file') as File).name, 'take.webm')
})
