import assert from 'node:assert/strict'
import test from 'node:test'
import type { Word } from '../types.ts'
import { revertReword, rewordSpan, rewordedRun } from './reword.ts'

function words(tokens: string[]): Word[] {
  return tokens.map((text, index) => ({
    id: `${index}`.padStart(10, '0'),
    text,
    startTime: index,
    endTime: index + 0.8,
    gapAfter: 0.2,
    isFiller: false,
    isRetake: false,
    isRemoved: false,
  }))
}

test('a one-to-one reword keeps ids and timing and records the original', () => {
  const source = words(['listen', 'to', 'the', 'hole', 'recording'])
  const result = rewordSpan(source, ['0000000003'], 'whole')!
  assert.ok(result)
  assert.deepEqual(result.removedIds, [])
  const changed = result.words[3]
  assert.equal(changed.id, '0000000003')
  assert.equal(changed.text, 'whole')
  assert.equal(changed.originalText, 'hole')
  assert.equal(changed.startTime, 3)
  assert.equal(changed.endTime, 3.8)
  assert.deepEqual(source.map((word) => word.text), ['listen', 'to', 'the', 'hole', 'recording'], 'input is immutable')
})

test('a phrase reword with a different word count keeps the span edges and retires interior ids', () => {
  const source = words(['we', 'are', 'going', 'to', 'talk'])
  const result = rewordSpan(source, ['0000000001', '0000000002', '0000000003'], "we're gonna")!
  assert.ok(result)
  assert.deepEqual(result.words.map((word) => word.text), ['we', "we're", 'gonna', 'talk'])
  assert.equal(result.words[1].id, '0000000001', 'first id survives')
  assert.equal(result.words[2].id, '0000000003', 'last id survives')
  assert.deepEqual(result.removedIds, ['0000000002'])
  assert.equal(result.words[1].startTime, 1)
  assert.equal(result.words[2].endTime, 3.8)
  assert.ok(result.words[1].endTime <= result.words[2].startTime)
  assert.equal(result.words[2].gapAfter, 0.2, 'the trailing gap belongs to the new last word')
  assert.equal(result.words[1].originalText, 'are going to')
  assert.equal(result.words[2].originalText, 'are going to')
  assert.equal(result.lastId, '0000000003')
})

test('a longer phrase mints valid ten-character ids and never overlaps neighbours', () => {
  const source = words(['a', 'b', 'c'])
  const result = rewordSpan(source, ['0000000001'], 'one two three four')!
  assert.equal(result.words.length, 6)
  for (const word of result.words) assert.match(word.id, /^[0-9a-f]{10}$/)
  assert.equal(new Set(result.words.map((word) => word.id)).size, 6)
  assert.equal(result.words[1].startTime, 1)
  assert.equal(result.words[4].endTime, 1.8)
  assert.ok(result.words[4].endTime <= result.words[5].startTime)
})

test('revert restores the original phrase over the same span and clears the marker', () => {
  const source = words(['we', 'are', 'going', 'to', 'talk'])
  const reworded = rewordSpan(source, ['0000000001', '0000000002', '0000000003'], "we're gonna")!
  assert.deepEqual(rewordedRun(reworded.words, '0000000003').map((word) => word.text), ["we're", 'gonna'])
  const reverted = revertReword(reworded.words, '0000000001')!
  assert.ok(reverted)
  assert.deepEqual(reverted.words.map((word) => word.text), ['we', 'are', 'going', 'to', 'talk'])
  assert.ok(reverted.words.every((word) => word.originalText === undefined))
  assert.equal(reverted.words[1].startTime, 1)
  assert.equal(reverted.words[3].endTime, 3.8)
})

test('rewording a removed or non-contiguous selection is refused', () => {
  const source = words(['a', 'b', 'c'])
  assert.equal(rewordSpan(source, ['0000000000', '0000000002'], 'x y'), null)
  const removed = source.map((word, index) => (index === 1 ? { ...word, isRemoved: true } : word))
  assert.equal(rewordSpan(removed, ['0000000001'], 'x'), null)
  assert.equal(rewordSpan(source, ['0000000001'], '   '), null)
  assert.equal(rewordSpan(source, ['0000000001'], 'b'), null, 'unchanged text is a no-op')
})
