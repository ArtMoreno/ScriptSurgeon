import test from 'node:test'
import assert from 'node:assert/strict'
import { findMatches, stepMatch } from './transcriptSearch.ts'
import type { Word } from '../types.ts'

function transcript(...texts: string[]): Word[] {
  return texts.map((text, index) => ({
    id: String(index).padStart(10, '0'),
    text,
    startTime: index,
    endTime: index + 0.5,
    isFiller: false,
    isRetake: false,
    isRemoved: false,
    gapAfter: 0,
  }))
}

test('a single term matches inside words and is case insensitive', () => {
  const words = transcript('Most', 'quarterbacks', 'become', 'famous')
  assert.deepEqual(findMatches(words, 'quarter').map((m) => m.startIdx), [1])
  assert.deepEqual(findMatches(words, 'MOST').map((m) => m.startIdx), [0])
  assert.deepEqual(findMatches(words, 'zzz'), [])
})

test('a multi-word query spans consecutive words like Ctrl+F does', () => {
  const words = transcript('shown', 'Penn', 'State', 'two', 'ways')
  const matches = findMatches(words, 'Penn State')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].startIdx, 1)
  assert.equal(matches[0].endIdx, 2)
  assert.deepEqual(matches[0].wordIds, ['0000000001', '0000000002'])
})

test('extra whitespace in the query is normalized', () => {
  const words = transcript('Penn', 'State')
  assert.equal(findMatches(words, '  penn   state  ').length, 1)
  assert.equal(findMatches(words, '   ').length, 0)
  assert.equal(findMatches(words, '').length, 0)
})

test('every occurrence is reported, including repeats', () => {
  const words = transcript('go', 'again', 'and', 'go', 'again')
  assert.deepEqual(findMatches(words, 'go again').map((m) => m.startIdx), [0, 3])
})

test('removed words remain searchable because they are still on screen', () => {
  const words = transcript('keep', 'gone', 'keep')
  words[1].isRemoved = true
  assert.deepEqual(findMatches(words, 'gone').map((m) => m.startIdx), [1])
})

test('stepping wraps in both directions and tolerates an empty result set', () => {
  assert.equal(stepMatch(2, 3, 1), 0, 'forward past the end wraps to the start')
  assert.equal(stepMatch(0, 3, -1), 2, 'backward past the start wraps to the end')
  assert.equal(stepMatch(0, 0, 1), 0, 'no matches must not divide by zero')
  assert.equal(stepMatch(0, 0, -1), 0)
})
