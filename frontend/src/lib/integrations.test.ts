import assert from 'node:assert/strict'
import test from 'node:test'
import { exportGroups, HANDOFF_GROUP, mergeExportOptions, targetFromOptionId } from './integrations.ts'
import type { IntegrationTarget } from '../types'

const BUILT_IN = [
  { id: 'audio:wav', label: 'WAV', group: 'Audio' },
  { id: 'text:srt', label: 'SRT', group: 'Transcript' },
]

function target(id: string, label: string): IntegrationTarget {
  return {
    id,
    label,
    summary: `${label} summary`,
    extension: id,
    requiresVideo: false,
  }
}

test('served targets are appended after the built-in choices', () => {
  const options = mergeExportOptions(BUILT_IN, [target('edl', 'Timeline (EDL)')])

  assert.deepEqual(options.map((option) => option.id), ['audio:wav', 'text:srt', 'handoff:edl'])
  assert.equal(options[2].group, HANDOFF_GROUP)
})

test('the built-in choices are untouched when nothing is served', () => {
  const options = mergeExportOptions(BUILT_IN, [])

  assert.deepEqual(options.map((option) => option.id), ['audio:wav', 'text:srt'])
})

test('a served target keeps its own label', () => {
  const options = mergeExportOptions(BUILT_IN, [target('edl', 'Timeline (EDL)')])

  assert.equal(options[2].label, 'Timeline (EDL)')
})

test('the handoff group appears only when a target is served', () => {
  assert.deepEqual(exportGroups(['Audio'], []), ['Audio'])
  assert.deepEqual(exportGroups(['Audio'], [target('edl', 'EDL')]), ['Audio', HANDOFF_GROUP])
})

test('option ids resolve back to their target, and built-ins resolve to nothing', () => {
  const targets = [target('edl', 'Timeline (EDL)')]

  assert.equal(targetFromOptionId('handoff:edl', targets)?.id, 'edl')
  assert.equal(targetFromOptionId('audio:wav', targets), null)
  // A target served by an older backend but since removed must not throw.
  assert.equal(targetFromOptionId('handoff:gone', targets), null)
})
