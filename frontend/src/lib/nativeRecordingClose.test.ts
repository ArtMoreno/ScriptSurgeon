import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RECORDING_CLOSE_REQUEST_EVENT,
  requestRecordingCloseConfirmation,
  type RecordingCloseRequestDetail,
} from './nativeRecordingClose.ts'

test('native recording close fails closed when no dialog handles the request', async () => {
  assert.equal(await requestRecordingCloseConfirmation(new EventTarget()), false)
})

test('the recording dialog response resolves a handled native close exactly once', async () => {
  const target = new EventTarget()
  target.addEventListener(RECORDING_CLOSE_REQUEST_EVENT, (event) => {
    const request = (event as CustomEvent<RecordingCloseRequestDetail>).detail
    request.handled = true
    request.respond(true)
    request.respond(false)
  })
  assert.equal(await requestRecordingCloseConfirmation(target), true)
})
