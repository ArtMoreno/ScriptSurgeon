import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeTake,
  capturedAudio,
  addTake,
  clockMs,
  discardTake,
  emptyTakeStack,
  formatElapsed,
  MAX_TAKES,
  pauseClock,
  resumeClock,
  selectTake,
  startClock,
  takeLabel,
  type Take,
  type TakeStack,
} from './recorderSession.ts'

function take(id: string, source: Take['source'] = 'recorded'): Take {
  return { id, file: new File([], `${id}.webm`), url: `blob:${id}`, durationMs: 1000, source }
}

function stackOf(...ids: string[]): TakeStack {
  return ids.reduce<TakeStack>((stack, id) => addTake(stack, take(id)).stack, emptyTakeStack)
}

test('interrupted capture retains delivered chunks in order, including a final partial chunk', async () => {
  const blob = capturedAudio([new Blob(['header']), new Blob([]), new Blob(['audio']), new Blob(['tail'])], 'audio/webm')
  assert.ok(blob)
  assert.equal(await blob.text(), 'headeraudiotail')
  assert.equal(blob.type, 'audio/webm')
  assert.equal(capturedAudio([new Blob([])], 'audio/webm'), null)
})

test('the clock excludes time spent paused', () => {
  let clock = startClock(0)
  clock = pauseClock(clock, 5_000)
  assert.equal(clockMs(clock, 30_000), 5_000)

  clock = resumeClock(clock, 30_000)
  assert.equal(clockMs(clock, 32_000), 7_000)
})

test('pausing twice does not double count', () => {
  let clock = startClock(0)
  clock = pauseClock(clock, 4_000)
  clock = pauseClock(clock, 9_000)
  assert.equal(clockMs(clock, 20_000), 4_000)
})

test('resuming a running clock is a no-op', () => {
  const clock = resumeClock(startClock(0), 5_000)
  assert.equal(clockMs(clock, 10_000), 10_000)
})

test('a new take becomes active without discarding the previous one', () => {
  const stack = stackOf('a', 'b')

  assert.deepEqual(stack.takes.map((entry) => entry.id), ['a', 'b'])
  assert.equal(activeTake(stack)?.id, 'b')
})

test('the oldest take is evicted past the cap and handed back for cleanup', () => {
  const ids = Array.from({ length: MAX_TAKES }, (_unused, index) => `t${index}`)
  const full = stackOf(...ids)

  const { stack, evicted } = addTake(full, take('overflow'))

  assert.equal(stack.takes.length, MAX_TAKES)
  assert.deepEqual(evicted.map((entry) => entry.id), ['t0'])
  assert.equal(activeTake(stack)?.id, 'overflow')
})

test('discarding the active take falls back to the one before it', () => {
  const { stack, evicted } = discardTake(stackOf('a', 'b', 'c'), 'c')

  assert.equal(activeTake(stack)?.id, 'b')
  assert.deepEqual(evicted.map((entry) => entry.id), ['c'])
})

test('discarding the only take leaves nothing active', () => {
  const { stack } = discardTake(stackOf('a'), 'a')

  assert.equal(stack.activeId, null)
  assert.equal(activeTake(stack), null)
})

test('discarding an inactive take keeps the current selection', () => {
  const { stack } = discardTake(stackOf('a', 'b'), 'a')

  assert.equal(activeTake(stack)?.id, 'b')
})

test('selecting an unknown take changes nothing', () => {
  const stack = stackOf('a', 'b')

  assert.equal(selectTake(stack, 'missing'), stack)
  assert.equal(activeTake(selectTake(stack, 'a'))?.id, 'a')
})

test('takes are labelled in capture order, imports included', () => {
  let stack = addTake(stackOf('a'), take('one', 'imported')).stack
  stack = addTake(stack, take('two', 'imported')).stack

  assert.equal(takeLabel(stack, 'a'), 'Take 1')
  // Two imports must not share a label, or the picker cannot be read.
  assert.equal(takeLabel(stack, 'one'), 'File 2')
  assert.equal(takeLabel(stack, 'two'), 'File 3')
})

test('elapsed time grows an hours field only when needed', () => {
  assert.equal(formatElapsed(0), '00:00')
  assert.equal(formatElapsed(65_400), '01:05')
  assert.equal(formatElapsed(3_725_000), '1:02:05')
})
