import type { InsertClip, Word } from '../types'
import { gapTargetSecondsFor, type GapTargetLookup } from './gapPacing.ts'

export const CROSSFADE = 0.01 // seconds; backend must use the same bounded join fade
export const SHORT_GAP = 0.3

export type CutReason = 'removed-words' | 'shortened-gap'

/** A source-time interval that is removed from the rendered file. */
export interface CutInterval {
  start: number
  end: number
  reason: CutReason
  wordIds: string[]
  gapAfterWordId?: string
  /** Desired rendered pause, in seconds, for a shortened-gap cut. */
  targetGap?: number
}

/** A retained source interval. The renderer concatenates these in order. */
export interface SourcePiece {
  kind: 'source'
  start: number
  end: number
  dur: number
  /** Fade used when joining this piece to the previous retained piece. */
  crossfadeBefore: number
}

export interface InsertPiece {
  kind: 'insert'
  insertId: string
  sourceTime: number
  dur: number
  crossfadeBefore: number
}

export type Piece = SourcePiece | InsertPiece

export interface TimelineModel {
  sourceDuration: number
  cuts: CutInterval[]
  pieces: Piece[]
  editedDuration: number
}

export interface EditedGap {
  wordId: string
  editedStart: number
  editedEnd: number
  origGap: number
  shortened: boolean
  /** Requested rendered pause, in seconds, when the gap is shortened. */
  targetGap?: number
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

export function inferredSourceDuration(words: Word[], sourceDuration?: number | null): number {
  if (sourceDuration !== null && sourceDuration !== undefined && Number.isFinite(sourceDuration)) {
    return Math.max(0, sourceDuration)
  }
  return words.reduce((max, word) => Math.max(max, finite(word.endTime)), 0)
}

function clampInterval(start: number, end: number, duration: number): { start: number; end: number } | null {
  const safeStart = Math.max(0, Math.min(duration, finite(start)))
  const safeEnd = Math.max(safeStart, Math.min(duration, finite(end, safeStart)))
  return safeEnd - safeStart > 0.000_001 ? { start: safeStart, end: safeEnd } : null
}

/**
 * Build source cuts, not reconstructed word clips.
 *
 * Parity contract for the backend:
 * - With no edits, retain [0, sourceDuration] exactly, including room tone and
 *   material before/after the transcript.
 * - A consecutive run of removed transcript words is one ripple cut from the
 *   first word start to the last word end, including pauses inside that run.
 * - A shortened gap is valid only when the two neighboring words in the
 *   original word array are both kept. Removed speech is never reclassified as
 *   a gap. The middle of the real pause is cut so room tone remains at both
 *   edges.
 */
export function buildCutIntervals(
  words: Word[],
  shortenedIds: Set<string>,
  sourceDuration?: number | null,
  gapTargets?: GapTargetLookup,
): CutInterval[] {
  const duration = inferredSourceDuration(words, sourceDuration)
  const cuts: CutInterval[] = []

  for (let index = 0; index < words.length;) {
    if (!words[index].isRemoved) {
      index += 1
      continue
    }
    const first = index
    while (index + 1 < words.length && words[index + 1].isRemoved) index += 1
    const last = index
    const interval = clampInterval(words[first].startTime, words[last].endTime, duration)
    if (interval) {
      cuts.push({
        ...interval,
        reason: 'removed-words',
        wordIds: words.slice(first, last + 1).map((word) => word.id),
      })
    }
    index += 1
  }

  for (let index = 0; index < words.length - 1; index += 1) {
    const word = words[index]
    const next = words[index + 1]
    if (word.isRemoved || next.isRemoved || !shortenedIds.has(word.id)) continue
    const gapStart = finite(word.endTime)
    const gapEnd = finite(next.startTime)
    const gap = gapEnd - gapStart
    const targetGap = gapTargetSecondsFor(word.id, gapTargets, SHORT_GAP)
    if (gap <= targetGap) continue

    // The retained halves overlap by CROSSFADE when concatenated, so retain an
    // extra fade-width of room tone to land on the requested edited pause.
    const retained = Math.min(gap, targetGap + CROSSFADE)
    const keepBefore = retained / 2
    const interval = clampInterval(gapStart + keepBefore, gapEnd - (retained - keepBefore), duration)
    if (interval) {
      cuts.push({
        ...interval,
        reason: 'shortened-gap',
        wordIds: [],
        gapAfterWordId: word.id,
        targetGap,
      })
    }
  }

  cuts.sort((a, b) => a.start - b.start || a.end - b.end)
  return cuts
}

export function buildPieces(
  words: Word[],
  shortenedIds: Set<string>,
  sourceDuration?: number | null,
  insertClips: InsertClip[] = [],
  gapTargets?: GapTargetLookup,
): Piece[] {
  const duration = inferredSourceDuration(words, sourceDuration)
  const cuts = buildCutIntervals(words, shortenedIds, duration, gapTargets)
  const kept: Array<{ start: number; end: number }> = []
  let keptCursor = 0
  for (const cut of cuts) {
    if (cut.start > keptCursor) kept.push({ start: keptCursor, end: cut.start })
    keptCursor = Math.max(keptCursor, cut.end)
  }
  if (keptCursor < duration || (kept.length === 0 && cuts.length === 0 && duration > 0)) {
    kept.push({ start: keptCursor, end: duration })
  }

  const effectiveAnchor = (sourceTime: number): number => {
    const anchor = Math.max(0, Math.min(duration, finite(sourceTime)))
    // Every timestamp on or inside a removed span becomes one edited boundary.
    // Tied inserts keep their explicit state-array order at that boundary.
    const enclosingCut = cuts.find((cut) => anchor >= cut.start && anchor <= cut.end)
    return enclosingCut ? enclosingCut.start : anchor
  }

  const insertions = insertClips
    .map((clip, order) => ({ clip, order, anchor: effectiveAnchor(clip.sourceTime) }))
    .filter(({ clip }) => !clip.isRemoved && finite(clip.duration) > 0)
    .sort((left, right) => left.anchor - right.anchor || left.order - right.order)

  const pieces: Piece[] = []
  const pushPiece = (piece: Omit<SourcePiece, 'crossfadeBefore'> | Omit<InsertPiece, 'crossfadeBefore'>) => {
    if (piece.dur <= 0) return
    const previous = pieces[pieces.length - 1]
    pieces.push({
      ...piece,
      crossfadeBefore: previous ? Math.min(CROSSFADE, previous.dur, piece.dur) : 0,
    } as Piece)
  }

  let sourceCursor = 0
  let keptIndex = 0
  const appendSourceUntil = (target: number) => {
    const endTarget = Math.max(sourceCursor, Math.min(duration, target))
    while (keptIndex < kept.length) {
      const interval = kept[keptIndex]
      if (interval.end <= sourceCursor) {
        keptIndex += 1
        continue
      }
      if (interval.start >= endTarget) break
      const start = Math.max(interval.start, sourceCursor)
      const end = Math.min(interval.end, endTarget)
      if (end > start) pushPiece({ kind: 'source', start, end, dur: end - start })
      if (endTarget < interval.end) break
      keptIndex += 1
    }
    sourceCursor = endTarget
  }

  for (const insertion of insertions) {
    appendSourceUntil(insertion.anchor)
    pushPiece({
      kind: 'insert',
      insertId: insertion.clip.id,
      sourceTime: insertion.anchor,
      dur: finite(insertion.clip.duration),
    })
  }
  appendSourceUntil(duration)

  return pieces
}

export function buildTimeline(
  words: Word[],
  shortenedIds: Set<string>,
  sourceDuration?: number | null,
  insertClips: InsertClip[] = [],
  gapTargets?: GapTargetLookup,
): TimelineModel {
  const duration = inferredSourceDuration(words, sourceDuration)
  const cuts = buildCutIntervals(words, shortenedIds, duration, gapTargets)
  const pieces = buildPieces(words, shortenedIds, duration, insertClips, gapTargets)
  const editedDuration = pieces.reduce((total, piece) => total + piece.dur - piece.crossfadeBefore, 0)
  return { sourceDuration: duration, cuts, pieces, editedDuration: Math.max(0, editedDuration) }
}

/** Map a retained source timestamp onto the edited timeline. */
export function sourceTimeToEdited(
  model: TimelineModel,
  sourceTime: number,
  boundary: 'before' | 'after' = 'before',
): number | null {
  const time = Math.max(0, Math.min(model.sourceDuration, finite(sourceTime)))
  let editedCursor = 0
  let match: number | null = null
  for (const piece of model.pieces) {
    const pieceEditedStart = editedCursor - piece.crossfadeBefore
    if (piece.kind === 'source' && time >= piece.start && time <= piece.end) {
      match = Math.max(0, pieceEditedStart + (time - piece.start))
      if (boundary === 'before') return match
    }
    editedCursor = pieceEditedStart + piece.dur
  }
  return match
}

/**
 * Map source time to an edited playhead even when the source timestamp lives
 * inside a ripple cut. This is useful for review/audition controls whose
 * proposals are expressed on the immutable source timeline while playback is
 * driven by the edited waveform.
 *
 * At an equal-distance tie inside a removed span, `before` selects the
 * preceding retained boundary and `after` selects the following one. The two
 * can differ by a tiny crossfade overlap; callers auditioning a range should
 * clamp its end to at least its start.
 */
export function sourceTimeToEditedNearest(
  model: TimelineModel,
  sourceTime: number,
  boundary: 'before' | 'after' = 'before',
): number {
  const exact = sourceTimeToEdited(model, sourceTime, boundary)
  if (exact !== null) return exact

  const time = Math.max(0, Math.min(model.sourceDuration, finite(sourceTime)))
  const candidates: Array<{ sourceTime: number; editedTime: number }> = []
  let editedCursor = 0
  for (const piece of model.pieces) {
    const pieceEditedStart = editedCursor - piece.crossfadeBefore
    if (piece.kind === 'source') {
      candidates.push(
        { sourceTime: piece.start, editedTime: Math.max(0, pieceEditedStart) },
        { sourceTime: piece.end, editedTime: Math.max(0, pieceEditedStart + piece.dur) },
      )
    }
    editedCursor = pieceEditedStart + piece.dur
  }

  // Include cut endpoints even when a removal touches the start or end of the
  // file and therefore has no retained source piece on one side.
  for (const cut of model.cuts) {
    candidates.push(
      {
        sourceTime: cut.start,
        editedTime: sourceTimeToEdited(model, cut.start, 'before') ?? 0,
      },
      {
        sourceTime: cut.end,
        editedTime: sourceTimeToEdited(model, cut.end, 'after') ?? model.editedDuration,
      },
    )
  }

  if (!candidates.length) return boundary === 'before' ? 0 : model.editedDuration
  candidates.sort((left, right) => {
    const distance = Math.abs(left.sourceTime - time) - Math.abs(right.sourceTime - time)
    if (Math.abs(distance) > 0.000_001) return distance
    const sourceOrder = left.sourceTime - right.sourceTime
    if (Math.abs(sourceOrder) > 0.000_001) {
      return boundary === 'before' ? sourceOrder : -sourceOrder
    }
    return boundary === 'before'
      ? left.editedTime - right.editedTime
      : right.editedTime - left.editedTime
  })
  return Math.max(0, Math.min(model.editedDuration, candidates[0].editedTime))
}

/** Map a source audition range onto the edited timeline without null gaps. */
export function sourceRangeToEdited(
  model: TimelineModel,
  sourceStart: number,
  sourceEnd: number,
): { start: number; end: number } {
  const start = sourceTimeToEditedNearest(model, sourceStart, 'before')
  const end = sourceTimeToEditedNearest(model, sourceEnd, 'after')
  return { start, end: Math.max(start, end) }
}

/** Map an edited playhead position back to the immutable source timeline. */
export function editedTimeToSource(model: TimelineModel, editedTime: number): number {
  const target = Math.max(0, Math.min(model.editedDuration, finite(editedTime)))
  let editedCursor = 0
  let lastSourceTime = 0
  for (const piece of model.pieces) {
    const start = editedCursor - piece.crossfadeBefore
    const end = start + piece.dur
    if (piece.kind === 'source') {
      lastSourceTime = piece.end
      if (target >= start && target <= end) {
        return Math.max(piece.start, Math.min(piece.end, piece.start + target - start))
      }
    } else if (target >= start && target <= end) {
      return piece.sourceTime
    }
    editedCursor = end
  }
  return Math.max(0, Math.min(model.sourceDuration, lastSourceTime))
}

/** Map each kept word to its position on the ripple-edited timeline. */
export function editedWordTimes(
  words: Word[],
  shortenedIds: Set<string>,
  sourceDuration?: number | null,
  insertClips: InsertClip[] = [],
  gapTargets?: GapTargetLookup,
): Map<string, { start: number; end: number }> {
  const model = buildTimeline(words, shortenedIds, sourceDuration, insertClips, gapTargets)
  const map = new Map<string, { start: number; end: number }>()
  for (const word of words) {
    if (word.isRemoved) continue
    const start = sourceTimeToEdited(model, word.startTime, 'after')
    const end = sourceTimeToEdited(model, word.endTime, 'before')
    if (start !== null && end !== null) map.set(word.id, { start, end: Math.max(start, end) })
  }
  return map
}

export function editedDuration(
  words: Word[],
  shortenedIds: Set<string>,
  sourceDuration?: number | null,
  insertClips: InsertClip[] = [],
  gapTargets?: GapTargetLookup,
): number {
  return buildTimeline(words, shortenedIds, sourceDuration, insertClips, gapTargets).editedDuration
}

export function editedInsertTimes(
  words: Word[],
  shortenedIds: Set<string>,
  sourceDuration: number | null | undefined,
  insertClips: InsertClip[],
  gapTargets?: GapTargetLookup,
): Map<string, { start: number; end: number }> {
  const model = buildTimeline(words, shortenedIds, sourceDuration, insertClips, gapTargets)
  const times = new Map<string, { start: number; end: number }>()
  let editedCursor = 0
  for (const piece of model.pieces) {
    const start = Math.max(0, editedCursor - piece.crossfadeBefore)
    const end = start + piece.dur
    if (piece.kind === 'insert') times.set(piece.insertId, { start, end })
    editedCursor = end
  }
  return times
}

/** Only returns real pauses between adjacent, still-kept original words. */
export function editedGaps(
  words: Word[],
  shortenedIds: Set<string>,
  sourceDuration?: number | null,
  insertClips: InsertClip[] = [],
  gapTargets?: GapTargetLookup,
): EditedGap[] {
  const model = buildTimeline(words, shortenedIds, sourceDuration, insertClips, gapTargets)
  const gaps: EditedGap[] = []
  for (let index = 0; index < words.length - 1; index += 1) {
    const word = words[index]
    const next = words[index + 1]
    if (word.isRemoved || next.isRemoved) continue
    const origGap = Math.max(0, next.startTime - word.endTime)
    if (origGap <= 0) continue
    const targetGap = gapTargetSecondsFor(word.id, gapTargets, SHORT_GAP)
    const editedStart = sourceTimeToEdited(model, word.endTime)
    const editedEnd = sourceTimeToEdited(model, next.startTime)
    if (editedStart === null || editedEnd === null) continue
    gaps.push({
      wordId: word.id,
      editedStart,
      editedEnd: Math.max(editedStart, editedEnd),
      origGap,
      shortened: shortenedIds.has(word.id) && origGap > targetGap,
      targetGap: shortenedIds.has(word.id) ? targetGap : undefined,
    })
  }
  return gaps
}

export function wordAtEditedTime(
  words: Word[],
  shortenedIds: Set<string>,
  time: number,
  sourceDuration?: number | null,
  insertClips: InsertClip[] = [],
  gapTargets?: GapTargetLookup,
): Word | null {
  const times = editedWordTimes(words, shortenedIds, sourceDuration, insertClips, gapTargets)
  let nearest: Word | null = null
  for (const word of words) {
    if (word.isRemoved) continue
    const span = times.get(word.id)
    if (!span) continue
    if (time >= span.start && time < span.end) return word
    if (span.start <= time) nearest = word
  }
  return nearest
}

export function fmtTime(sec: number): string {
  const safe = Math.max(0, finite(sec))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = Math.floor(safe % 60)
  const centiseconds = Math.floor((safe % 1) * 100)
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
  return hours ? `${String(hours).padStart(2, '0')}:${base}` : base
}
