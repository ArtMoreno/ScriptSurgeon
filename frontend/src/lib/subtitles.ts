import type { InsertClip, TranscriptFormat, Word } from '../types'
import { editedInsertTimes, editedWordTimes } from './timeline.ts'
import type { GapTargetLookup } from './gapPacing.ts'

export interface TranscriptToken {
  start: number
  end: number
  text: string
}

export interface Cue {
  index: number
  start: number
  end: number
  text: string
}

/** A resolved chapter on the edited timeline. Kept structural for store independence. */
export interface TranscriptChapter {
  title: string
  start: number
  end?: number | null
}

/**
 * Delivery-only extensions. Omitting this argument preserves the original
 * transcript bytes, including plain TXT paragraph behavior.
 */
export interface TranscriptFormatOptions {
  chapters?: readonly TranscriptChapter[]
  /** Add Markdown-style chapter headings to a TXT transcript. */
  includeChapterHeadings?: boolean
  /** Add short "Chapter: title" cues to SRT/VTT captions. */
  includeChapterCues?: boolean
}

/** Two 42-character lines, the long-standing broadcast subtitle convention. */
const MAX_CUE_CHARS = 84
const MAX_CUE_SECONDS = 6
/** A pause this long reads as a new thought, so it ends the cue. */
const CUE_BREAK_GAP = 0.7
const PARAGRAPH_GAP = 1.2
const MIN_CHARS_BEFORE_SENTENCE_BREAK = 28
/** Subtitles must never collapse to zero length or players may skip them. */
const MIN_CUE_SECONDS = 0.4

/**
 * Kept words and inserted takes on the edited timeline, in playback order, so
 * subtitle timings line up with the exported audio rather than the source.
 */
export function transcriptTokens(
  words: Word[],
  shortenedIds: Set<string>,
  sourceDuration?: number | null,
  insertClips: InsertClip[] = [],
  gapTargets?: GapTargetLookup,
): TranscriptToken[] {
  const wordTimes = editedWordTimes(words, shortenedIds, sourceDuration, insertClips, gapTargets)
  const insertTimes = editedInsertTimes(words, shortenedIds, sourceDuration, insertClips, gapTargets)
  const tokens: TranscriptToken[] = []

  for (const word of words) {
    if (word.isRemoved) continue
    const span = wordTimes.get(word.id)
    const text = word.text.trim()
    if (span && text) tokens.push({ start: span.start, end: span.end, text })
  }
  for (const clip of insertClips) {
    if (clip.isRemoved) continue
    const span = insertTimes.get(clip.id)
    const text = clip.text.trim()
    if (span && text) tokens.push({ start: span.start, end: span.end, text })
  }

  return tokens.sort((left, right) => left.start - right.start || left.end - right.end)
}

function endsSentence(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text)
}

export function buildCues(tokens: TranscriptToken[]): Cue[] {
  const cues: Cue[] = []
  let current: TranscriptToken[] = []

  const flush = () => {
    if (!current.length) return
    const start = current[0].start
    const end = Math.max(current[current.length - 1].end, start + MIN_CUE_SECONDS)
    cues.push({
      index: cues.length + 1,
      start,
      end,
      text: current.map((token) => token.text).join(' '),
    })
    current = []
  }

  for (const token of tokens) {
    if (current.length) {
      const previous = current[current.length - 1]
      const width = current.reduce((total, item) => total + item.text.length + 1, 0)
      const tooWide = width + token.text.length > MAX_CUE_CHARS
      const tooLong = token.end - current[0].start > MAX_CUE_SECONDS
      const bigPause = token.start - previous.end >= CUE_BREAK_GAP
      const sentenceEnd = endsSentence(previous.text) && width >= MIN_CHARS_BEFORE_SENTENCE_BREAK
      if (tooWide || tooLong || bigPause || sentenceEnd) flush()
    }
    current.push(token)
  }
  flush()

  // Never let one cue overlap the next; players treat overlaps as malformed.
  for (let index = 0; index < cues.length - 1; index += 1) {
    if (cues[index].end > cues[index + 1].start) {
      cues[index].end = Math.max(cues[index].start, cues[index + 1].start - 0.001)
    }
  }
  return cues
}

export function timecode(seconds: number, separator: ',' | '.'): string {
  const clamped = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const whole = Math.floor(clamped)
  const milliseconds = Math.round((clamped - whole) * 1000)
  // Rounding 0.9999 up must carry into seconds rather than print ",1000".
  const carried = milliseconds === 1000 ? whole + 1 : whole
  const printedMs = milliseconds === 1000 ? 0 : milliseconds
  const hours = Math.floor(carried / 3600)
  const minutes = Math.floor((carried % 3600) / 60)
  const secs = carried % 60
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(printedMs, 3)}`
}

function toParagraphs(tokens: TranscriptToken[]): string {
  const paragraphs: string[] = []
  let current: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (index > 0 && token.start - tokens[index - 1].end >= PARAGRAPH_GAP && current.length) {
      paragraphs.push(current.join(' '))
      current = []
    }
    current.push(token.text)
  }
  if (current.length) paragraphs.push(current.join(' '))
  return paragraphs.join('\n\n')
}

function normalizedChapters(chapters: readonly TranscriptChapter[] | undefined): TranscriptChapter[] {
  if (!chapters?.length) return []
  return chapters
    .map((chapter, index) => ({
      title: chapter.title.replace(/\s+/g, ' ').trim() || `Chapter ${index + 1}`,
      start: Math.max(0, Number.isFinite(chapter.start) ? chapter.start : 0),
      end: Number.isFinite(chapter.end) ? Math.max(0, chapter.end as number) : null,
      index,
    }))
    .sort((left, right) => left.start - right.start || left.index - right.index)
    .map(({ index: _index, ...chapter }) => chapter)
}

function toParagraphsWithChapterHeadings(tokens: TranscriptToken[], chapters: readonly TranscriptChapter[]): string {
  if (!chapters.length) return toParagraphs(tokens)
  const parts: string[] = []
  let tokenIndex = 0

  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex]
    const nextStart = chapters[chapterIndex + 1]?.start ?? Infinity
    const beforeStart = tokenIndex
    while (tokenIndex < tokens.length && tokens[tokenIndex].start < chapter.start) tokenIndex += 1
    const before = toParagraphs(tokens.slice(beforeStart, tokenIndex))
    if (before) parts.push(before)

    parts.push(`# ${chapter.title}`)
    const chapterStart = tokenIndex
    while (tokenIndex < tokens.length && tokens[tokenIndex].start < nextStart) tokenIndex += 1
    const body = toParagraphs(tokens.slice(chapterStart, tokenIndex))
    if (body) parts.push(body)
  }

  const trailing = toParagraphs(tokens.slice(tokenIndex))
  if (trailing) parts.push(trailing)
  return parts.join('\n\n')
}

/** Short title cues make chapters visible in caption players. */
export function buildChapterCues(chapters: readonly TranscriptChapter[]): Cue[] {
  const normalized = normalizedChapters(chapters)
  return normalized.map((chapter, index) => {
    const nextStart = normalized[index + 1]?.start ?? Infinity
    const chapterEnd = chapter.end
    const requestedEnd = chapterEnd !== null && chapterEnd !== undefined && chapterEnd > chapter.start
      ? chapterEnd
      : chapter.start + 1.2
    const end = Math.max(chapter.start + MIN_CUE_SECONDS, Math.min(requestedEnd, nextStart))
    return {
      index: index + 1,
      start: chapter.start,
      end,
      text: `Chapter: ${chapter.title}`,
    }
  })
}

function withChapterCues(tokens: TranscriptToken[], chapters: readonly TranscriptChapter[]): Cue[] {
  const speechCues = buildCues(tokens).map((cue) => ({ ...cue }))
  const standalone: Cue[] = []
  const normalized = normalizedChapters(chapters)

  for (let index = 0; index < normalized.length; index += 1) {
    const chapter = normalized[index]
    const title = `Chapter: ${chapter.title}`
    const activeCue = speechCues.find((cue) => cue.start <= chapter.start && cue.end >= chapter.start)
    if (activeCue) {
      activeCue.text = `${title}\n${activeCue.text}`
      continue
    }

    const nextSpeechCue = speechCues.find((cue) => cue.start > chapter.start)
    const nextChapterStart = normalized[index + 1]?.start ?? Infinity
    const requestedEnd = chapter.end !== null && chapter.end !== undefined && chapter.end > chapter.start
      ? chapter.end
      : chapter.start + 1.2
    const safeEnd = Math.min(requestedEnd, nextSpeechCue?.start ?? Infinity, nextChapterStart)
    if (safeEnd >= chapter.start + MIN_CUE_SECONDS) {
      standalone.push({ index: 0, start: chapter.start, end: safeEnd, text: title })
    } else if (nextSpeechCue) {
      // No silent interval wide enough for a standalone cue. Prefixing the
      // following speech keeps the file valid instead of emitting overlaps.
      nextSpeechCue.text = `${title}\n${nextSpeechCue.text}`
    } else if (standalone.length) {
      standalone[standalone.length - 1].text = `${standalone[standalone.length - 1].text}\n${title}`
    } else {
      standalone.push({ index: 0, start: chapter.start, end: chapter.start + MIN_CUE_SECONDS, text: title })
    }
  }

  return [...standalone, ...speechCues]
    .map((cue, order) => ({ cue, order }))
    .sort((left, right) => left.cue.start - right.cue.start || left.order - right.order)
    .map(({ cue }, index) => ({ ...cue, index: index + 1 }))
}

export function formatTranscript(
  tokens: TranscriptToken[],
  format: TranscriptFormat,
  options: TranscriptFormatOptions = {},
): string {
  const chapters = normalizedChapters(options.chapters)
  if (format === 'txt') {
    const body = options.includeChapterHeadings && chapters.length
      ? toParagraphsWithChapterHeadings(tokens, chapters)
      : toParagraphs(tokens)
    return body ? `${body}\n` : ''
  }

  const cues = options.includeChapterCues && chapters.length ? withChapterCues(tokens, chapters) : buildCues(tokens)
  if (format === 'vtt') {
    const blocks = cues.map((cue) =>
      `${cue.index}\n${timecode(cue.start, '.')} --> ${timecode(cue.end, '.')}\n${cue.text}`,
    )
    return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`
  }

  const blocks = cues.map((cue) =>
    `${cue.index}\n${timecode(cue.start, ',')} --> ${timecode(cue.end, ',')}\n${cue.text}`,
  )
  return `${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`
}
