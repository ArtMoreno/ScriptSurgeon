import assert from 'node:assert/strict'
import test from 'node:test'
import type { InsertClip, Word } from '../types.ts'
import { buildTimeline, sourceTimeToEdited } from './timeline.ts'
import { formatChapterSidecar, markerAnchorAtPreviewTime, resolveChapterRanges, resolveMarkerAnchor } from './markers.ts'

function word(id: string, startTime: number, endTime: number, isRemoved = false): Word {
  return {
    id,
    text: id,
    startTime,
    endTime,
    gapAfter: 0,
    isFiller: false,
    isRetake: false,
    isRemoved,
  }
}

function insert(): InsertClip {
  return {
    id: '100000000001',
    clipId: '200000000001',
    sourceTime: 1,
    duration: 0.5,
    text: 'inserted take',
    afterWordId: '0000000001',
    isRemoved: false,
  }
}

test('a marker inside a removed source span falls onto the edited boundary', () => {
  const model = buildTimeline([
    word('0000000001', 0, 1),
    word('0000000002', 1, 3, true),
    word('0000000003', 3, 4),
  ], new Set(), 4)

  const resolved = resolveMarkerAnchor({ sourceTime: 2 }, model)
  assert.equal(resolved.resolution, 'collapsed-source')
  assert.ok(resolved.editedTime >= 0.98 && resolved.editedTime <= 1, `unexpected boundary ${resolved.editedTime}`)
})

test('an inserted-take anchor follows the take rather than the source seam', () => {
  const clip = insert()
  const model = buildTimeline([
    word('0000000001', 0, 1),
    word('0000000002', 1, 2),
  ], new Set(), 2, [clip])

  const resolved = resolveMarkerAnchor({ sourceTime: 1, insertId: clip.id, insertOffset: 0.25 }, model)
  assert.equal(resolved.resolution, 'insert')
  assert.ok(Math.abs(resolved.editedTime - 1.24) < 0.000_001, `unexpected inserted position ${resolved.editedTime}`)
})

test('moving a marker inside an inserted take retains its take-relative offset', () => {
  const clip = insert()
  const model = buildTimeline([
    word('0000000001', 0, 1),
    word('0000000002', 1, 2),
  ], new Set(), 2, [clip])

  const anchor = markerAnchorAtPreviewTime(model, 'edited', 1.24)
  assert.deepEqual(anchor, { sourceTime: 1, insertId: clip.id, insertOffset: 0.25 })
})

test('an exact original-preview move saves a clamped source anchor', () => {
  const model = buildTimeline([
    word('0000000001', 0, 1),
    word('0000000002', 1, 2),
  ], new Set(), 2)

  assert.deepEqual(markerAnchorAtPreviewTime(model, 'original', 1.234), { sourceTime: 1.234 })
  assert.deepEqual(markerAnchorAtPreviewTime(model, 'original', 99), { sourceTime: 2 })
})

test('a marker moved on the edited timeline remains source-anchored across a pacing change', () => {
  const words = [
    word('0000000001', 0, 1),
    word('0000000002', 3, 4),
    word('0000000003', 4, 5),
  ]
  const shortened = new Set(['0000000001'])
  const initial = buildTimeline(words, shortened, 5, [], { '0000000001': 300 })
  const anchor = markerAnchorAtPreviewTime(initial, 'edited', 1.5)
  const initiallyResolved = resolveMarkerAnchor(anchor, initial)
  assert.ok(Math.abs(initiallyResolved.editedTime - 1.5) < 0.000_001)

  const changedPacing = buildTimeline(words, shortened, 5, [], { '0000000001': 800 })
  const resolvedAfterPacingChange = resolveMarkerAnchor(anchor, changedPacing)
  const expected = sourceTimeToEdited(changedPacing, anchor.sourceTime, 'after')
  assert.equal(resolvedAfterPacingChange.resolution, 'source')
  assert.equal(resolvedAfterPacingChange.sourceTime, anchor.sourceTime)
  assert.notEqual(resolvedAfterPacingChange.editedTime, initiallyResolved.editedTime)
  assert.ok(expected !== null)
  assert.ok(Math.abs(resolvedAfterPacingChange.editedTime - expected) < 0.000_001)
})

test('chapters resolve in edited order and never overlap in delivery sidecars', () => {
  const model = buildTimeline([word('0000000001', 0, 10)], new Set(), 10)
  const chapters = resolveChapterRanges([
    { id: 'one', title: 'One', kind: 'chapter' as const, anchor: { sourceTime: 1 } },
    { id: 'note', title: 'Note', kind: 'marker' as const, anchor: { sourceTime: 2 } },
    { id: 'two', title: 'Two', kind: 'chapter' as const, anchor: { sourceTime: 4 }, end: { sourceTime: 8 } },
    { id: 'three', title: 'Three', kind: 'chapter' as const, anchor: { sourceTime: 6 } },
  ], model)

  assert.deepEqual(chapters.map((chapter) => [chapter.title, chapter.start, chapter.end]), [
    ['One', 1, 4],
    ['Two', 4, 6],
    ['Three', 6, 10],
  ])
  assert.equal(chapters[1].hasExplicitEnd, true)
})

test('chapter sidecars are ordered, timestamped, and safe for FFmetadata', () => {
  const chapters = [
    { title: 'Later', start: 61.25, end: 62 },
    { title: 'Intro', start: 0, end: 2 },
    { title: 'A=B', start: 120, end: 121 },
  ]
  assert.equal(
    formatChapterSidecar(chapters),
    '00:00:00.000 Intro\n00:01:01.250 Later\n00:02:00.000 A=B\n',
  )
  const metadata = formatChapterSidecar(chapters, 'ffmetadata')
  assert.ok(metadata.startsWith(';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Intro\n'))
  assert.ok(metadata.includes('title=A\\=B'))
})
