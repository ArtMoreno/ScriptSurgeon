import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCues, formatTranscript, timecode, transcriptTokens } from './subtitles.ts'
import type { InsertClip, Word } from '../types.ts'

function word(id: string, text: string, startTime: number, endTime: number, isRemoved = false): Word {
  return { id, text, startTime, endTime, isFiller: false, isRetake: false, isRemoved, gapAfter: 0 }
}

function tokens(entries: [number, number, string][]) {
  return entries.map(([start, end, text]) => ({ start, end, text }))
}

test('subtitle timings follow the edited timeline, not the source', () => {
  const words: Word[] = [
    word('0000000001', 'one', 0.0, 1.0),
    word('0000000002', 'cut', 1.0, 5.0, true),
    word('0000000003', 'two', 5.0, 6.0),
  ]
  const result = transcriptTokens(words, new Set())
  assert.equal(result.length, 2, 'removed words are not subtitled')
  assert.equal(result[0].text, 'one')
  assert.equal(result[1].text, 'two')
  // "two" starts at source 5.0 but follows a 4s ripple cut, so it must land ~1.0.
  assert.ok(result[1].start < 1.5, `expected the cut to be closed, got ${result[1].start}`)
})

test('inserted takes are interleaved into the transcript in playback order', () => {
  const words: Word[] = [word('0000000001', 'before', 0, 1), word('0000000002', 'after', 1, 2)]
  const insert: InsertClip = {
    id: '111111111111',
    clipId: 'aaaaaaaaaaaa',
    sourceTime: 1,
    duration: 0.5,
    text: 'inserted',
    afterWordId: '0000000001',
    isRemoved: false,
  }
  const result = transcriptTokens(words, new Set(), 2, [insert])
  assert.deepEqual(result.map((item) => item.text), ['before', 'inserted', 'after'])
  const removed = transcriptTokens(words, new Set(), 2, [{ ...insert, isRemoved: true }])
  assert.deepEqual(removed.map((item) => item.text), ['before', 'after'])
})

test('cues split on long pauses, sentence ends, and width', () => {
  const pause = buildCues(tokens([[0, 0.5, 'first'], [2.0, 2.5, 'second']]))
  assert.equal(pause.length, 2, 'a pause over the break threshold starts a new cue')

  const sentence = buildCues(tokens([
    [0, 0.4, 'a'.repeat(30) + '.'],
    [0.5, 0.9, 'next'],
  ]))
  assert.equal(sentence.length, 2, 'a sentence end past the minimum width starts a new cue')

  const wide = buildCues(Array.from({ length: 30 }, (_, index) => ({
    start: index * 0.2,
    end: index * 0.2 + 0.15,
    text: 'word',
  })))
  assert.ok(wide.length > 1, 'long runs are split rather than emitted as one cue')
  for (const cue of wide) assert.ok(cue.text.length <= 84, `cue too wide: ${cue.text.length}`)
})

test('cues never overlap and never collapse to zero length', () => {
  const cues = buildCues(tokens([[0, 0.05, 'tiny'], [1.0, 1.4, 'next']]))
  for (const cue of cues) assert.ok(cue.end > cue.start, 'cue must have positive duration')
  for (let index = 0; index < cues.length - 1; index += 1) {
    assert.ok(cues[index].end <= cues[index + 1].start, 'cues must not overlap')
  }
})

test('timecodes use the right separator and carry rounding into seconds', () => {
  assert.equal(timecode(0, ','), '00:00:00,000')
  assert.equal(timecode(3661.5, ','), '01:01:01,500')
  assert.equal(timecode(3661.5, '.'), '01:01:01.500')
  // 0.9999 must not render as ",1000".
  assert.equal(timecode(1.9999, ','), '00:00:02,000')
  assert.equal(timecode(-5, ','), '00:00:00,000')
})

test('timecodes fail closed for non-finite input', () => {
  assert.equal(timecode(Number.NaN, ','), '00:00:00,000')
  assert.equal(timecode(Number.POSITIVE_INFINITY, '.'), '00:00:00.000')
})

test('srt is numbered with comma timecodes and vtt carries its header', () => {
  const source = tokens([[0, 0.8, 'hello'], [2.0, 2.6, 'world']])
  const srt = formatTranscript(source, 'srt')
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:00,8\d\d\nhello\n\n2\n/)
  assert.ok(!srt.includes('WEBVTT'))

  const vtt = formatTranscript(source, 'vtt')
  assert.ok(vtt.startsWith('WEBVTT\n\n'), 'VTT requires its magic header')
  assert.ok(vtt.includes('-->'))
  assert.ok(!vtt.includes(',8'), 'VTT uses a dot, not a comma, for milliseconds')
})

test('txt drops timings and breaks paragraphs on long pauses', () => {
  const text = formatTranscript(tokens([[0, 0.5, 'one'], [0.6, 1.0, 'two'], [4.0, 4.5, 'later']]), 'txt')
  assert.equal(text, 'one two\n\nlater\n')
  assert.ok(!text.includes('-->'))
})

test('an empty transcript produces empty output rather than stray headers', () => {
  assert.equal(formatTranscript([], 'srt'), '')
  assert.equal(formatTranscript([], 'txt'), '')
  assert.equal(formatTranscript([], 'vtt'), 'WEBVTT\n\n')
})

test('chapter delivery options add headings and title cues only when requested', () => {
  const source = tokens([[0, 0.5, 'intro'], [2, 2.5, 'later']])
  const chapters = [{ title: 'Opening', start: 0 }, { title: 'Next', start: 2 }]

  assert.equal(
    formatTranscript(source, 'txt', { chapters, includeChapterHeadings: true }),
    '# Opening\n\nintro\n\n# Next\n\nlater\n',
  )

  const srt = formatTranscript(source, 'srt', { chapters, includeChapterCues: true })
  assert.match(srt, /1\n00:00:00,000 --> 00:00:00,500\nChapter: Opening\nintro/)
  assert.match(srt, /Chapter: Next/)
  const vtt = formatTranscript(source, 'vtt', { chapters, includeChapterCues: true })
  assert.ok(vtt.includes('Chapter: Opening'))
})
