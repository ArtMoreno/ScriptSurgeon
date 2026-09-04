import assert from 'node:assert/strict'
import test from 'node:test'
import type { InsertClip, Word } from '../types.ts'
import {
  buildTimeline,
  editedGaps,
  editedInsertTimes,
  editedTimeToSource,
  sourceRangeToEdited,
  sourceTimeToEditedNearest,
} from './timeline.ts'

function word(id: string, text: string, start: number, end: number, isRemoved = false): Word {
  return {
    id,
    text,
    startTime: start,
    endTime: end,
    gapAfter: 0,
    isFiller: false,
    isRetake: false,
    isRemoved,
  }
}

function insertion(overrides: Partial<InsertClip> = {}): InsertClip {
  return {
    id: '100000000001',
    clipId: '200000000001',
    sourceTime: 2,
    duration: 1,
    text: 'new words',
    afterWordId: '0000000001',
    isRemoved: false,
    ...overrides,
  }
}

test('an inserted clip splits retained source and extends the edited timeline', () => {
  const words = [word('0000000001', 'one', 0.5, 1), word('0000000002', 'two', 3, 3.5)]
  const clip = insertion()
  const model = buildTimeline(words, new Set(), 4, [clip])
  assert.deepEqual(model.pieces.map((piece) => piece.kind), ['source', 'insert', 'source'])
  assert.ok(Math.abs(model.editedDuration - 4.98) < 0.000_001)
  assert.equal(editedTimeToSource(model, 2.4), 2)
  const times = editedInsertTimes(words, new Set(), 4, [clip]).get(clip.id)
  assert.ok(times)
  assert.ok(Math.abs((times?.end ?? 0) - (times?.start ?? 0) - 1) < 0.000_001)
})

test('an insertion inside a ripple cut is retained at the edit boundary', () => {
  const words = [
    word('0000000001', 'remove', 1, 2, true),
    word('0000000002', 'this', 2, 3, true),
  ]
  const model = buildTimeline(words, new Set(), 4, [insertion()])
  assert.deepEqual(model.pieces.map((piece) => piece.kind), ['source', 'insert', 'source'])
  assert.deepEqual(model.pieces.filter((piece) => piece.kind === 'source').map((piece) => [piece.start, piece.end]), [[0, 1], [3, 4]])
  assert.ok(Math.abs(model.editedDuration - 2.98) < 0.000_001)
})

test('inserts anywhere on one removed span keep state order at the collapsed boundary', () => {
  const words = [
    word('0000000001', 'remove', 1, 2, true),
    word('0000000002', 'this', 2, 3, true),
  ]
  const first = insertion({ id: '100000000001', sourceTime: 3, duration: 0.2 })
  const second = insertion({ id: '100000000002', clipId: '200000000002', sourceTime: 1.5, duration: 0.2 })
  const model = buildTimeline(words, new Set(), 4, [first, second])
  assert.deepEqual(
    model.pieces.filter((piece) => piece.kind === 'insert').map((piece) => piece.insertId),
    [first.id, second.id],
  )
})

test('removed insertions contribute no audio and tied insertions retain state order', () => {
  const words = [word('0000000001', 'one', 0.5, 1)]
  const first = insertion({ id: '100000000001', duration: 0.5 })
  const second = insertion({ id: '100000000002', clipId: '200000000002', duration: 0.25 })
  const removed = insertion({ id: '100000000003', clipId: '200000000003', isRemoved: true })
  const model = buildTimeline(words, new Set(), 4, [first, second, removed])
  assert.deepEqual(
    model.pieces.filter((piece) => piece.kind === 'insert').map((piece) => piece.insertId),
    [first.id, second.id],
  )
})

test('per-gap pacing targets retain the exact requested room tone without changing legacy callers', () => {
  const words = [word('0000000001', 'one', 0.4, 1), word('0000000002', 'two', 3, 3.4)]
  const shortened = new Set([words[0].id])

  const legacy = buildTimeline(words, shortened, 4)
  const targeted = buildTimeline(words, shortened, 4, [], { [words[0].id]: 750 })
  const targetedGap = editedGaps(words, shortened, 4, [], { [words[0].id]: 750 })[0]

  assert.equal(legacy.cuts.find((cut) => cut.reason === 'shortened-gap')?.targetGap, 0.3)
  assert.equal(targeted.cuts.find((cut) => cut.reason === 'shortened-gap')?.targetGap, 0.75)
  assert.ok(Math.abs(targetedGap.editedEnd - targetedGap.editedStart - 0.75) < 0.000_001)
  assert.equal(targetedGap.shortened, true)

  const longerThanSource = buildTimeline(words, shortened, 4, [], { [words[0].id]: 2_500 })
  assert.equal(longerThanSource.cuts.filter((cut) => cut.reason === 'shortened-gap').length, 0)
})

test('nearest source-to-edited mapping collapses removed spans for audition controls', () => {
  const words = [
    word('0000000001', 'remove', 1, 2, true),
    word('0000000002', 'keep', 3, 3.5),
  ]
  const model = buildTimeline(words, new Set(), 5)

  assert.equal(sourceTimeToEditedNearest(model, 1.5, 'before'), 1)
  assert.ok(Math.abs(sourceTimeToEditedNearest(model, 1.5, 'after') - 0.99) < 0.000_001)
  assert.ok(Math.abs(sourceTimeToEditedNearest(model, 3) - 1.99) < 0.000_001)
  assert.deepEqual(sourceRangeToEdited(model, 1.25, 1.75), { start: 1, end: 1 })
  assert.deepEqual(sourceRangeToEdited(model, 3, 3.5), { start: 1.99, end: 2.49 })
})
