import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTerminalTranscriptionStatus,
  sidebarProjectStatus,
  transcriptionErrorCopy,
} from './transcriptionStatus.ts'

test('only failed and cancelled transcription states are terminal and retryable', () => {
  assert.equal(isTerminalTranscriptionStatus('error'), true)
  assert.equal(isTerminalTranscriptionStatus('cancelled'), true)
  assert.equal(isTerminalTranscriptionStatus('queued'), false)
  assert.equal(isTerminalTranscriptionStatus('transcribing'), false)
  assert.equal(isTerminalTranscriptionStatus('ready'), false)
})

test('cancelled transcription has retry-oriented fallback copy', () => {
  assert.match(transcriptionErrorCopy({ status: 'cancelled' }), /cancelled/i)
  assert.match(transcriptionErrorCopy({ status: 'cancelled' }), /retry/i)
  assert.equal(
    transcriptionErrorCopy({ status: 'error', error: 'Decoder failed' }),
    'Decoder failed',
  )
})

test('sidebar exposes every backend transcription state', () => {
  assert.equal(sidebarProjectStatus({ status: 'queued', duration: null }, '').label, 'Queued for transcription')
  assert.equal(sidebarProjectStatus({ status: 'transcribing', duration: null }, '').label, 'Transcribing...')
  assert.equal(sidebarProjectStatus({ status: 'error', duration: null }, '').label, 'Transcription failed')
  assert.equal(sidebarProjectStatus({ status: 'cancelled', duration: null }, '').label, 'Transcription cancelled')
  assert.equal(sidebarProjectStatus({ status: 'ready', duration: 61 }, '1:01').label, '1:01')
})
