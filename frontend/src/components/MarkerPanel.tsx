import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { buildTimeline, fmtTime } from '../lib/timeline'
import { gapTargetsFromEdits } from '../lib/gapPacing'
import { markerAnchorAtPreviewTime, resolveMarkers } from '../lib/markers'
import type { Marker } from '../types'

function secondsInputValue(seconds: number): string {
  return Math.max(0, Number.isFinite(seconds) ? seconds : 0).toFixed(3)
}

function sameMarkerAnchor(left: Marker['anchor'], right: Marker['anchor']): boolean {
  return left.sourceTime === right.sourceTime
    && (left.insertId ?? null) === (right.insertId ?? null)
    && (left.insertOffset ?? null) === (right.insertOffset ?? null)
}

export default function MarkerPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const markers = useStore((state) => state.markers)
  const words = useStore((state) => state.words)
  const shortenedGapIds = useStore((state) => state.shortenedGapIds)
  const gapEdits = useStore((state) => state.gapEdits)
  const sourceDuration = useStore((state) => state.sourceDuration)
  const insertClips = useStore((state) => state.insertClips)
  const audioPreviewMode = useStore((state) => state.audioPreviewMode)
  const addMarker = useStore((state) => state.addMarker)
  const updateMarker = useStore((state) => state.updateMarker)
  const deleteMarker = useStore((state) => state.deleteMarker)
  const seekMarker = useStore((state) => state.seekMarker)
  const exportChapter = useStore((state) => state.exportChapter)
  const exportChapterList = useStore((state) => state.exportChapterList)
  const exportTranscript = useStore((state) => state.exportTranscript)
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [newTitle, setNewTitle] = useState('')

  const timeline = useMemo(() => buildTimeline(
    words,
    new Set(shortenedGapIds),
    sourceDuration,
    insertClips,
    gapTargetsFromEdits(gapEdits),
  ), [words, shortenedGapIds, sourceDuration, insertClips, gapEdits])
  const resolved = useMemo(() => resolveMarkers(markers, timeline), [markers, timeline])

  useEffect(() => {
    if (open) window.setTimeout(() => dialogRef.current?.focus({ preventScroll: true }), 0)
  }, [open])

  if (!open) return null

  const add = (kind: 'marker' | 'chapter') => {
    addMarker(kind, newTitle)
    setNewTitle('')
  }

  const positionLabel = audioPreviewMode === 'original' ? 'Source position' : 'Edited position'
  const previewDuration = audioPreviewMode === 'original' ? sourceDuration : timeline.editedDuration

  const commitPosition = (marker: Marker, currentTime: number, input: HTMLInputElement) => {
    if (input.value === input.defaultValue) return
    const requested = input.value.trim() ? Number(input.value) : Number.NaN
    if (!Number.isFinite(requested)) {
      input.value = input.defaultValue
      return
    }
    const nextTime = Math.max(0, Math.min(previewDuration, requested))
    const nextValue = secondsInputValue(nextTime)
    input.value = nextValue
    input.defaultValue = nextValue
    if (Math.abs(nextTime - currentTime) < 0.000_001) return
    const nextAnchor = markerAnchorAtPreviewTime(timeline, audioPreviewMode, nextTime)
    if (!sameMarkerAnchor(marker.anchor, nextAnchor)) updateMarker(marker.id, { anchor: nextAnchor })
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
      className="absolute right-3 top-[calc(100%+8px)] z-[60] w-[480px] max-w-[calc(100vw-24px)] rounded-2xl border border-line-strong bg-canvas-raised p-4 shadow-2xl shadow-ink/15 outline-none focus-visible:ring-2 focus-visible:ring-ember"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-sm font-semibold text-ink">Markers and chapters</h2>
          <p className="mt-1 text-[12px] leading-5 text-ink-muted">Saved locally as source anchors, so they follow ripple edits and recorded inserts without changing audio. Drag an annotation in the waveform, or edit its exact time below.</p>
        </div>
        <button type="button" onClick={onClose} className="h-8 px-2 rounded-lg text-[12px] text-ink-muted hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">Close</button>
      </div>

      <div className="mt-4 flex gap-2">
        <input
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          maxLength={120}
          placeholder="Optional title at playhead"
          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2.5 text-[12px] text-ink outline-none placeholder:text-ink-muted focus:border-ember focus:ring-2 focus:ring-ember/25"
        />
        <button type="button" onClick={() => add('marker')} className="h-9 px-3 rounded-lg border border-line text-[12px] font-semibold text-ink hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">Add marker</button>
        <button type="button" onClick={() => add('chapter')} className="h-9 px-3 rounded-lg bg-ember text-[12px] font-semibold text-ink-inverse hover:bg-ember-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">Add chapter</button>
      </div>

      <div className="mt-3 max-h-[min(46vh,360px)] space-y-2 overflow-y-auto pr-1" aria-label="Saved markers">
        {!resolved.length && <p className="rounded-lg bg-canvas-soft px-3 py-2 text-[12px] text-ink-muted">Add a marker or chapter at the playhead. Chapters can be exported as individual local audio clips.</p>}
        {resolved.map(({ marker, editedTime, resolution }) => (
          <div key={marker.id} className="rounded-xl border border-line bg-canvas p-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => seekMarker(marker.id)}
                className="font-mono text-[11px] tabular-nums text-ember-dark hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember rounded"
                title="Seek to this marker"
              >
                {fmtTime(editedTime)}
              </button>
              <select
                value={marker.kind}
                onChange={(event) => updateMarker(marker.id, { kind: event.target.value as 'marker' | 'chapter' })}
                className="app-select h-7 rounded-md border border-line bg-canvas-raised px-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted outline-none focus:ring-2 focus:ring-ember"
                aria-label={`Kind for ${marker.title}`}
              >
                <option value="marker">Marker</option>
                <option value="chapter">Chapter</option>
              </select>
              {resolution === 'collapsed-source' && <span className="text-[10px] text-ochre-dark" title="The original point was cut, so it snapped to a retained boundary">snapped</span>}
              <button type="button" onClick={() => deleteMarker(marker.id)} className="ml-auto h-7 px-2 rounded-md text-[11px] text-ink-muted hover:bg-danger-soft hover:text-danger-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger">Delete</button>
            </div>
            <input
              defaultValue={marker.title}
              key={`${marker.id}-${marker.title}`}
              aria-label={`Title for ${marker.kind} at ${fmtTime(editedTime)}`}
              onBlur={(event) => updateMarker(marker.id, { title: event.currentTarget.value })}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
              maxLength={120}
              className="mt-2 h-8 w-full rounded-md border border-transparent bg-transparent px-1.5 text-[12px] font-medium text-ink hover:border-line focus:border-ember focus:outline-none focus:ring-2 focus:ring-ember/25"
            />
            {(() => {
              const positionTime = audioPreviewMode === 'original' ? marker.anchor.sourceTime : editedTime
              const positionValue = secondsInputValue(positionTime)
              return (
                <label className="mt-2 flex items-center gap-2 text-[10px] font-medium text-ink-muted">
                  <span className="shrink-0">{positionLabel} (seconds)</span>
                  <input
                    key={`position-${marker.id}-${audioPreviewMode}-${positionValue}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={previewDuration}
                    step="0.001"
                    defaultValue={positionValue}
                    aria-label={`${positionLabel} in seconds for ${marker.title}`}
                    onBlur={(event) => commitPosition(marker, positionTime, event.currentTarget)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        event.currentTarget.value = event.currentTarget.defaultValue
                        event.currentTarget.blur()
                      }
                    }}
                    className="h-8 w-28 rounded-md border border-line bg-canvas-raised px-2 font-mono text-[11px] tabular-nums text-ink outline-none focus:border-ember focus:ring-2 focus:ring-ember/25"
                  />
                  <span className="min-w-0 truncate tabular-nums">0–{secondsInputValue(previewDuration)}</span>
                </label>
              )
            })()}
            {marker.kind === 'chapter' && (
              <div className="mt-2 flex justify-end gap-1.5">
                <button type="button" onClick={() => void exportChapter(marker.id, 'wav')} className="h-7 px-2 rounded-md text-[11px] font-semibold text-ember-dark hover:bg-ember-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">Export chapter WAV</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-line pt-3">
        <button type="button" onClick={() => exportTranscript('txt', { includeChapterHeadings: true })} disabled={!markers.some((marker) => marker.kind === 'chapter')} className="h-8 px-3 rounded-lg text-[11px] font-semibold text-ink-muted hover:bg-canvas-soft disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">Transcript with headings</button>
        <button type="button" onClick={() => exportTranscript('vtt', { includeChapterCues: true })} disabled={!markers.some((marker) => marker.kind === 'chapter')} className="h-8 px-3 rounded-lg text-[11px] font-semibold text-ink-muted hover:bg-canvas-soft disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">VTT with chapter cues</button>
        <button type="button" onClick={exportChapterList} disabled={!markers.some((marker) => marker.kind === 'chapter')} className="h-8 px-3 rounded-lg border border-line text-[11px] font-semibold text-ink hover:bg-canvas-soft disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">Export chapter list</button>
      </div>
    </div>
  )
}
