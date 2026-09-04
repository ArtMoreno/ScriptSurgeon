import assert from 'node:assert/strict'
import test from 'node:test'

import { onSeek, requestSeek } from './seekBus.ts'

test('seek requests clamp negative times, reject non-finite values, and unsubscribe cleanly', () => {
  const target = new EventTarget()
  const received: Array<{ time: number; autoplay: boolean }> = []
  const unsubscribe = onSeek((request) => received.push(request), target)

  requestSeek(-4, true, target)
  requestSeek(Number.NaN, true, target)
  requestSeek(2.5, false, target)
  unsubscribe()
  requestSeek(8, true, target)

  assert.deepEqual(received, [
    { time: 0, autoplay: true },
    { time: 2.5, autoplay: false },
  ])
})
