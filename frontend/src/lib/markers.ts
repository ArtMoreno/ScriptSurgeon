import type { TimelineModel } from './timeline.ts'
import { editedTimeToSource, sourceTimeToEdited } from './timeline.ts'

/**
 * A marker normally follows a point on the immutable source recording.  When
 * it is attached to an inserted take, `insertId` and `insertOffset` keep the
 * marker with that take if ripple edits move the surrounding source material.
 */
export interface MarkerAnchor {
  sourceTime: number
  insertId?: string | null
  insertOffset?: number | null
}

export type MarkerKind = 'marker' | 'chapter'
export type MarkerPreviewMode = 'original' | 'edited'

/** Structural on purpose: callers can keep this data in their own state type. */
export interface MarkerLike {
  id: string
  title: string
  kind: MarkerKind
  anchor: MarkerAnchor
  end?: MarkerAnchor | null
}

export type MarkerAnchorResolution = 'source' | 'insert' | 'collapsed-source'

export interface ResolvedMarkerAnchor {
  /** Position on the current ripple-edited timeline. */
  editedTime: number
  /** The safe source anchor used when the marker was saved. */
  sourceTime: number
  resolution: MarkerAnchorResolution
}

export interface ResolvedMarker<T extends MarkerLike = MarkerLike> extends ResolvedMarkerAnchor {
  marker: T
}

export interface ChapterRange<T extends MarkerLike = MarkerLike> {
  marker: T
  id: string
  title: string
  start: number
  end: number
  /** Whether this chapter's end came from a saved explicit marker end. */
  hasExplicitEnd: boolean
}

export type ChapterSidecarFormat = 'txt' | 'ffmetadata'

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

interface PositionedPiece {
  piece: TimelineModel['pieces'][number]
  start: number
  end: number
}

function positionedPieces(model: TimelineModel): PositionedPiece[] {
  const positioned: PositionedPiece[] = []
  let cursor = 0
  for (const piece of model.pieces) {
    const start = Math.max(0, cursor - piece.crossfadeBefore)
    const end = start + piece.dur
    positioned.push({ piece, start, end })
    cursor = end
  }
  return positioned
}

/**
 * Persist an edited playhead as a durable anchor.  A playhead inside an active
 * inserted take keeps that take's identity and offset rather than collapsing
 * back to the surrounding source timestamp.
 */
export function markerAnchorAtEditedTime(model: TimelineModel, editedTime: number): MarkerAnchor {
  const target = clamp(finite(editedTime), 0, model.editedDuration)
  const inserted = positionedPieces(model).find(
    (entry) => entry.piece.kind === 'insert' && target >= entry.start && target <= entry.end,
  )
  if (inserted?.piece.kind === 'insert') {
    return {
      sourceTime: inserted.piece.sourceTime,
      insertId: inserted.piece.insertId,
      insertOffset: clamp(target - inserted.start, 0, inserted.piece.dur),
    }
  }
  return { sourceTime: editedTimeToSource(model, target) }
}

/**
 * Turn a position from the currently displayed waveform into a durable marker
 * anchor. Original-preview movement deliberately creates a source anchor;
 * edited-preview movement retains an inserted-take identity when applicable.
 */
export function markerAnchorAtPreviewTime(
  model: TimelineModel,
  previewMode: MarkerPreviewMode,
  previewTime: number,
): MarkerAnchor {
  if (previewMode === 'original') {
    return { sourceTime: clamp(finite(previewTime), 0, model.sourceDuration) }
  }
  return markerAnchorAtEditedTime(model, previewTime)
}

function sourceBoundaryClosestTo(model: TimelineModel, sourceTime: number): number {
  const pieces = positionedPieces(model)
  let closest: { sourceDistance: number; editedTime: number; later: boolean } | null = null
  for (const entry of pieces) {
    if (entry.piece.kind !== 'source') continue
    for (const candidate of [
      { sourceTime: entry.piece.start, editedTime: entry.start, later: entry.piece.start >= sourceTime },
      { sourceTime: entry.piece.end, editedTime: entry.end, later: entry.piece.end >= sourceTime },
    ]) {
      const next = {
        sourceDistance: Math.abs(candidate.sourceTime - sourceTime),
        editedTime: candidate.editedTime,
        later: candidate.later,
      }
      if (
        !closest ||
        next.sourceDistance < closest.sourceDistance ||
        // A deleted point is most naturally carried to the start of the
        // following retained material when both boundaries are equally near.
        (next.sourceDistance === closest.sourceDistance && next.later && !closest.later)
      ) {
        closest = next
      }
    }
  }
  return closest ? clamp(closest.editedTime, 0, model.editedDuration) : 0
}

/**
 * Resolve a saved source/insert marker onto the current edited timeline.
 *
 * A source anchor that was deleted does not disappear: it lands on its nearest
 * retained boundary.  That makes a marker stable across cleanup and retake
 * edits while still avoiding a misleading source-time seek in the rendered
 * audio.
 */
export function resolveMarkerAnchor(anchor: MarkerAnchor, model: TimelineModel): ResolvedMarkerAnchor {
  const sourceTime = clamp(finite(anchor.sourceTime), 0, model.sourceDuration)
  if (anchor.insertId) {
    const insert = positionedPieces(model).find(
      (entry) => entry.piece.kind === 'insert' && entry.piece.insertId === anchor.insertId,
    )
    if (insert) {
      const offset = clamp(finite(anchor.insertOffset ?? 0), 0, insert.piece.dur)
      return {
        editedTime: clamp(insert.start + offset, 0, model.editedDuration),
        sourceTime,
        resolution: 'insert',
      }
    }
  }

  const direct = sourceTimeToEdited(model, sourceTime, 'after')
  if (direct !== null) {
    return {
      editedTime: clamp(direct, 0, model.editedDuration),
      sourceTime,
      resolution: 'source',
    }
  }
  return {
    editedTime: sourceBoundaryClosestTo(model, sourceTime),
    sourceTime,
    resolution: 'collapsed-source',
  }
}

export function resolveMarkers<T extends MarkerLike>(markers: readonly T[], model: TimelineModel): ResolvedMarker<T>[] {
  return markers
    .map((marker, order) => ({ marker, order, ...resolveMarkerAnchor(marker.anchor, model) }))
    .sort((left, right) => left.editedTime - right.editedTime || left.order - right.order)
    .map(({ order: _order, ...resolved }) => resolved)
}

/**
 * Resolve delivery-ready chapter ranges.  A chapter without an explicit end
 * runs until the next chapter, or to the end of the edited program.  Explicit
 * ends are still bounded by the next chapter so generated chapter sidecars
 * never overlap.
 */
export function resolveChapterRanges<T extends MarkerLike>(
  markers: readonly T[],
  model: TimelineModel,
): ChapterRange<T>[] {
  const chapters = resolveMarkers(markers.filter((marker) => marker.kind === 'chapter'), model)
  return chapters.map((resolved, index) => {
    const nextStart = chapters[index + 1]?.editedTime ?? model.editedDuration
    const explicitEnd = resolved.marker.end ? resolveMarkerAnchor(resolved.marker.end, model).editedTime : null
    const requestedEnd = explicitEnd ?? nextStart
    return {
      marker: resolved.marker,
      id: resolved.marker.id,
      title: resolved.marker.title.trim() || `Chapter ${index + 1}`,
      start: clamp(resolved.editedTime, 0, model.editedDuration),
      end: clamp(Math.max(resolved.editedTime, Math.min(requestedEnd, nextStart)), 0, model.editedDuration),
      hasExplicitEnd: explicitEnd !== null,
    }
  })
}

function chapterTimecode(seconds: number): string {
  const millisecondsTotal = Math.max(0, Math.round(finite(seconds) * 1000))
  const hours = Math.floor(millisecondsTotal / 3_600_000)
  const minutes = Math.floor((millisecondsTotal % 3_600_000) / 60_000)
  const secs = Math.floor((millisecondsTotal % 60_000) / 1000)
  const milliseconds = millisecondsTotal % 1000
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(milliseconds, 3)}`
}

function safeChapterTitle(title: string, index: number): string {
  return title.replace(/\s+/g, ' ').trim() || `Chapter ${index + 1}`
}

function ffmetadataEscape(value: string): string {
  return value.replace(/([=;#\\])/g, '\\$1').replace(/\r?\n/g, ' ')
}

/**
 * Produce a small chapter delivery sidecar from resolved ranges.  `txt` is
 * human-readable and useful with delivery notes; `ffmetadata` can be passed
 * to FFmpeg for chapter-aware containers.
 */
export function formatChapterSidecar(
  chapters: readonly Pick<ChapterRange, 'title' | 'start' | 'end'>[],
  format: ChapterSidecarFormat = 'txt',
): string {
  const ordered = chapters
    .map((chapter, index) => ({
      title: safeChapterTitle(chapter.title, index),
      start: Math.max(0, finite(chapter.start)),
      end: Math.max(0, finite(chapter.end)),
      index,
    }))
    .sort((left, right) => left.start - right.start || left.index - right.index)

  if (format === 'txt') {
    return ordered.length ? `${ordered.map((chapter) => `${chapterTimecode(chapter.start)} ${chapter.title}`).join('\n')}\n` : ''
  }

  const blocks = ordered.map((chapter) => {
    const start = Math.round(chapter.start * 1000)
    const end = Math.max(start, Math.round(chapter.end * 1000))
    return `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${start}\nEND=${end}\ntitle=${ffmetadataEscape(chapter.title)}`
  })
  return `;FFMETADATA1\n${blocks.length ? `${blocks.join('\n')}\n` : ''}`
}
