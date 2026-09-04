import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_GAP_PACING,
  GAP_TARGET_MAX_MS,
  eligibleGapWordIds,
  gapEditsForWordIds,
  gapTargetSecondsFor,
  gapTargetsFromEdits,
  normalizeGapEdits,
  normalizeGapPacing,
  pacingForPreset,
} from './gapPacing.ts'
import type { Word } from '../types.ts'

function word(id: string, text: string, startTime: number, endTime: number): Word {
  return {
    id,
    text,
    startTime,
    endTime,
    gapAfter: 0,
    isFiller: false,
    isRetake: false,
    isRemoved: false,
  }
}

test('pacing presets are detached values and preserve the legacy podcast defaults', () => {
  assert.deepEqual(DEFAULT_GAP_PACING, {
    preset: 'podcast',
    detectionThresholdMs: 800,
    targetGapMs: 300,
  })
  assert.deepEqual(pacingForPreset('tight'), {
    preset: 'tight',
    detectionThresholdMs: 550,
    targetGapMs: 180,
  })
})

test('pacing normalization clamps unsafe values and never makes a suggestion threshold shorter than its target', () => {
  assert.deepEqual(normalizeGapPacing({
    preset: 'custom',
    detectionThresholdMs: 120,
    targetGapMs: 240,
  }), {
    preset: 'custom',
    detectionThresholdMs: 241,
    targetGapMs: 240,
  })
  assert.equal(normalizeGapPacing({ preset: 'custom', targetGapMs: Number.POSITIVE_INFINITY }).targetGapMs, 300)
  assert.equal(normalizeGapPacing({ preset: 'custom', targetGapMs: GAP_TARGET_MAX_MS + 1 }).targetGapMs, GAP_TARGET_MAX_MS)
})

test('per-gap edits serialize by source anchor and timeline lookups accept records or maps', () => {
  const targets = gapTargetsFromEdits([
    { afterWordId: 'first', targetGapMs: 220 },
    { afterWordId: 'first', targetGapMs: 260 },
    { afterWordId: 'second', targetGapMs: -1 },
  ])
  assert.deepEqual(targets, { first: 260, second: 50 })
  assert.equal(gapTargetSecondsFor('first', targets), 0.26)
  assert.equal(gapTargetSecondsFor('first', new Map([['first', 450]])), 0.45)
  assert.equal(gapTargetSecondsFor('missing', targets), 0.3)
  assert.deepEqual(gapEditsForWordIds(['second', 'missing', 'first'], targets), [
    { afterWordId: 'second', targetGapMs: 50 },
    { afterWordId: 'first', targetGapMs: 260 },
  ])
})

test('canonical gap edits deduplicate explicitly edited anchors before legacy shortened IDs', () => {
  assert.deepEqual(normalizeGapEdits([
    { afterWordId: 'first', targetGapMs: 180 },
    { afterWordId: 'second', targetGapMs: 260 },
    { afterWordId: 'first', targetGapMs: 220 },
  ], ['legacy', 'second', 'first']), [
    { afterWordId: 'first', targetGapMs: 220 },
    { afterWordId: 'second', targetGapMs: 260 },
    { afterWordId: 'legacy', targetGapMs: 300 },
  ])
})

test('direct pacing actions use the same conservative eligibility as Cleanup review', () => {
  const pacing = { preset: 'podcast' as const, detectionThresholdMs: 800, targetGapMs: 300 }

  assert.deepEqual(eligibleGapWordIds([
    word('short', 'Keep', 0, 0.1),
    word('short-next', 'going', 0.75, 0.85),
  ], pacing), [], 'a pause below the detection threshold is not directly shortened')

  assert.deepEqual(eligibleGapWordIds([
    word('sentence', 'Finished.', 0, 0.1),
    word('sentence-next', 'Continue', 1.9, 2.0),
  ], pacing), [], 'a sentence break is not directly shortened')

  assert.deepEqual(eligibleGapWordIds([
    word('speaker', 'Question', 0, 0.1),
    word('speaker-next', 'Answer', 1.9, 2.0),
  ], pacing, { speaker: 'one', 'speaker-next': 'two' }), [], 'a speaker change is not directly shortened')

  assert.deepEqual(eligibleGapWordIds([
    word('eligible', 'We', 0, 0.1),
    word('eligible-next', 'continue', 1.9, 2.0),
    word('eligible-tail', 'now.', 2.08, 2.2),
  ], pacing), ['eligible'], 'a long continuous pause remains eligible')

  assert.deepEqual(eligibleGapWordIds([
    word('kept', 'We', 0, 0.1),
    word('kept-next', 'continue', 1.9, 2.0),
    word('kept-tail', 'now.', 2.08, 2.2),
  ], pacing, undefined, ['kept']), [], 'a pause explicitly kept by the user stays protected')
})
