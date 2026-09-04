import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js'
import type { Region } from 'wavesurfer.js/dist/plugins/regions.js'
import { useStore } from '../store'
import { buildTimeline, editedWordTimes, editedGaps, editedInsertTimes, sourceRangeToEdited } from '../lib/timeline'
import { gapTargetsFromEdits } from '../lib/gapPacing'
import { markerAnchorAtEditedTime, markerAnchorAtPreviewTime, resolveMarkers } from '../lib/markers'
import type { TimelineSize, WorkspaceTheme } from '../lib/workspacePreferences'
import { onSeek } from '../lib/seekBus'
import { player } from '../lib/player'
import { authHeaders } from '../lib/api'
import { CloseIcon, ScissorsIcon } from './Icons'
import TransportBar from './TransportBar'

interface Menu {
  x: number
  y: number
  region: Region
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /(?:signal|operation|request).*abort|aborted without reason/i.test(message)
}

interface WaveformColors {
  wave: string
  progress: string
  cursor: string
  selection: string
  shortened: string
  gap: string
  insert: string
  marker: string
  chapter: string
}

const WAVEFORM_COLOR_FALLBACKS: WaveformColors = {
  wave: '#77726d',
  progress: '#e16545',
  cursor: '#241f1b',
  selection: 'rgba(225,101,69,0.2)',
  shortened: 'rgba(19,119,98,0.2)',
  gap: 'rgba(190,108,0,0.29)',
  insert: 'rgba(112,61,94,0.16)',
  marker: 'rgba(83,82,78,0.34)',
  chapter: 'rgba(225,101,69,0.42)',
}

function waveformColors(): WaveformColors {
  const style = getComputedStyle(document.documentElement)
  const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    wave: value('--wave-color', WAVEFORM_COLOR_FALLBACKS.wave),
    progress: value('--wave-progress-color', WAVEFORM_COLOR_FALLBACKS.progress),
    cursor: value('--wave-cursor-color', WAVEFORM_COLOR_FALLBACKS.cursor),
    selection: value('--wave-selection-color', WAVEFORM_COLOR_FALLBACKS.selection),
    shortened: value('--wave-shortened-region-color', WAVEFORM_COLOR_FALLBACKS.shortened),
    gap: value('--wave-gap-region-color', WAVEFORM_COLOR_FALLBACKS.gap),
    insert: value('--wave-insert-region-color', WAVEFORM_COLOR_FALLBACKS.insert),
    marker: value('--wave-marker-region-color', WAVEFORM_COLOR_FALLBACKS.marker),
    chapter: value('--wave-chapter-region-color', WAVEFORM_COLOR_FALLBACKS.chapter),
  }
}

const TIMELINE_SIZE_OPTIONS: { value: TimelineSize; label: string; title: string }[] = [
  { value: 'normal', label: 'Full', title: 'Use the full timeline height' },
  { value: 'compact', label: 'Compact', title: 'Use a smaller timeline height' },
  { value: 'minimized', label: 'Hide', title: 'Minimize the waveform and keep playback controls' },
]

export default function WaveformPanel({
  zoom,
  setZoom,
  timelineSize,
  onTimelineSizeChange,
  onShowTimeline,
  theme,
}: {
  zoom: number
  setZoom: (zoom: number) => void
  timelineSize: TimelineSize
  onTimelineSizeChange: (size: TimelineSize) => void
  onShowTimeline: () => void
  theme: WorkspaceTheme
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<RegionsPlugin | null>(null)
  const activeSelectionRef = useRef<Region | null>(null)
  const dragSelectionCleanupRef = useRef<(() => void) | null>(null)
  const loadSequence = useRef(0)
  const zoomRef = useRef(zoom)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [ready, setReady] = useState(false)
  const minimized = timelineSize === 'minimized'
  const panelHeight = timelineSize === 'normal'
    ? 'h-[clamp(220px,34vh,360px)]'
    : timelineSize === 'compact'
      ? 'h-[clamp(160px,22vh,220px)]'
      : 'h-12'

  zoomRef.current = zoom

  const audioUrl = useStore((state) => state.audioUrl)
  const words = useStore((state) => state.words)
  const shortenedGapIds = useStore((state) => state.shortenedGapIds)
  const gapEdits = useStore((state) => state.gapEdits)
  const gapPacing = useStore((state) => state.gapPacing)
  const insertClips = useStore((state) => state.insertClips)
  const sourceDuration = useStore((state) => state.sourceDuration)
  const markers = useStore((state) => state.markers)
  const audioPreviewMode = useStore((state) => state.audioPreviewMode)
  const rendering = useStore((state) => state.rendering)
  const removeWords = useStore((state) => state.removeWords)
  const shortenGaps = useStore((state) => state.shortenGaps)
  const addMarker = useStore((state) => state.addMarker)
  const reportError = useStore((state) => state.reportError)
  const exportProject = useStore((state) => state.exportProject)
  const audioExportFormat = useStore((state) => state.audioExportFormat)
  const exporting = useStore((state) => state.exporting)
  const waveformGain = useStore((state) => state.waveformGain)
  const playbackRate = useStore((state) => state.playbackRate)

  useEffect(() => {
    if (!containerRef.current) return
    const regions = RegionsPlugin.create()
    const colors = waveformColors()
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: colors.wave,
      progressColor: colors.progress,
      cursorColor: colors.cursor,
      cursorWidth: 2,
      height: 'auto',
      minPxPerSec: 50,
      normalize: false,
      plugins: [regions],
    })
    wsRef.current = ws
    regionsRef.current = regions
    player.set(ws)

    ws.on('timeupdate', (time) => useStore.getState().setPlayTime(time))
    ws.on('play', () => useStore.getState().setPlaying(true))
    ws.on('pause', () => useStore.getState().setPlaying(false))
    ws.on('error', (error) => {
      if (isAbortLike(error)) return
      useStore.getState().setWaveformReady(false)
      useStore.getState().reportError(`The waveform could not be loaded. ${error.message}`)
    })

    dragSelectionCleanupRef.current = regions.enableDragSelection({ color: colors.selection })
    regions.on('region-created', (region) => {
      if (region.id.startsWith('marker-') || region.id.startsWith('annotation-')) return
      if (activeSelectionRef.current && activeSelectionRef.current !== region) activeSelectionRef.current.remove()
      activeSelectionRef.current = region
      const rect = (region.element as HTMLElement | undefined)?.getBoundingClientRect()
      const host = containerRef.current?.getBoundingClientRect()
      setMenu({
        x: rect && host ? rect.left - host.left + rect.width / 2 : 110,
        y: 8,
        region,
      })
    })
    regions.on('region-updated', (region) => {
      if (!region.id.startsWith('annotation-')) return
      const markerId = region.id.slice('annotation-'.length)
      if (!markerId) return

      // Read live state rather than closing over a render. A marker can be
      // moved while an edited preview is changing, and its saved anchor must
      // use the timeline that is on screen when the drag finishes.
      const state = useStore.getState()
      const timeline = buildTimeline(
        state.words,
        new Set(state.shortenedGapIds),
        state.sourceDuration,
        state.insertClips,
        gapTargetsFromEdits(state.gapEdits),
      )
      state.updateMarker(markerId, {
        anchor: markerAnchorAtPreviewTime(timeline, state.audioPreviewMode, region.start),
      })
    })

    const offSeek = onSeek(({ time, autoplay }) => {
      if (!ws.getDecodedData()) return
      ws.setTime(time)
      if (autoplay && !ws.isPlaying()) {
        void ws.play().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Unknown playback error.'
          useStore.getState().reportError(`Playback could not start. ${message}`)
        })
      }
    })

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const textEntry = target?.closest('input, textarea, [contenteditable="true"]')
      if (target?.closest('[role="dialog"], [role="menu"]')) return
      if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))) {
        if (textEntry) return
        event.preventDefault()
        useStore.getState().redo()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        if (textEntry) return
        event.preventDefault()
        useStore.getState().undo()
        return
      }
      if (event.key === 'Escape' && activeSelectionRef.current && !textEntry) {
        activeSelectionRef.current.remove()
        activeSelectionRef.current = null
        setMenu(null)
        return
      }
      if (target?.closest('input, textarea, select, button, a, audio, video, [contenteditable="true"], [role="button"]')) return
      if (event.code === 'Space') {
        if (!ws.getDecodedData()) return
        event.preventDefault()
        void ws.playPause().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Unknown playback error.'
          useStore.getState().reportError(`Playback could not start. ${message}`)
        })
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        const state = useStore.getState()
        if (state.projectId) { event.preventDefault(); state.removeSelection() }
      } else if (event.key.toLowerCase() === 'g' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        useStore.getState().shortenGapAtPlayhead()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      loadSequence.current += 1
      useStore.getState().setWaveformReady(false)
      offSeek()
      window.removeEventListener('keydown', onKey)
      dragSelectionCleanupRef.current?.()
      dragSelectionCleanupRef.current = null
      if (wsRef.current === ws) {
        wsRef.current = null
        regionsRef.current = null
        player.set(null)
      }
      ws.destroy()
    }
  }, [])

  // WaveSurfer paints to canvas, so its palette must be refreshed separately
  // from the semantic CSS variables used by the React controls.
  useEffect(() => {
    const ws = wsRef.current
    const regions = regionsRef.current
    if (!ws || !regions) return
    const colors = waveformColors()
    ws.setOptions({ waveColor: colors.wave, progressColor: colors.progress, cursorColor: colors.cursor })
    dragSelectionCleanupRef.current?.()
    dragSelectionCleanupRef.current = regions.enableDragSelection({ color: colors.selection })
  }, [theme])

  useEffect(() => {
    const ws = wsRef.current
    const regions = regionsRef.current
    if (!ws) return
    const sequence = ++loadSequence.current
    player.cancelAudition()
    useStore.getState().setWaveformReady(false)
    setMenu(null)
    activeSelectionRef.current = null
    regions?.getRegions().forEach((region) => region.remove())

    if (!audioUrl) {
      setReady(false)
      ws.pause()
      ws.empty()
      return
    }

    setReady(false)
    const position = useStore.getState().playTime
    const wasPlaying = useStore.getState().playing
    const controller = new AbortController()

    const loadAudio = async () => {
      try {
        const response = await fetch(audioUrl, {
          headers: authHeaders(),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Audio request failed (${response.status})`)
        const blob = await response.blob()
        if (controller.signal.aborted || sequence !== loadSequence.current || wsRef.current !== ws) return
        await ws.loadBlob(blob)
        if (controller.signal.aborted || sequence !== loadSequence.current || wsRef.current !== ws || !ws.getDecodedData()) return
        ws.zoom(zoomRef.current)
        setReady(true)
        useStore.getState().setWaveformReady(true)
        if (position > 0) ws.setTime(Math.min(position, ws.getDuration()))
        if (wasPlaying) {
          void ws.play().catch((error: unknown) => {
            if (sequence !== loadSequence.current || wsRef.current !== ws || isAbortLike(error)) return
            const message = error instanceof Error ? error.message : 'Unknown playback error.'
            reportError(`Playback could not resume. ${message}`)
          })
        }
      } catch (error: unknown) {
        if (
          controller.signal.aborted || isAbortLike(error) ||
          sequence !== loadSequence.current || wsRef.current !== ws
        ) return
        setReady(false)
        useStore.getState().setWaveformReady(false)
        const message = error instanceof Error ? error.message : 'Unknown audio loading error.'
        reportError(`The audio preview could not be opened. ${message}`)
      }
    }

    void loadAudio()
    return () => controller.abort()
  }, [audioUrl, reportError])

  // Vertical scaling only; the decoded audio and every render are untouched.
  useEffect(() => {
    if (!ready) return
    wsRef.current?.setOptions({ barHeight: waveformGain })
  }, [waveformGain, ready])

  // A reload resets the media element, so the chosen speed must be reapplied.
  useEffect(() => {
    if (!ready) return
    player.setRate(playbackRate)
  }, [playbackRate, ready])

  useEffect(() => {
    if (!ready) return
    const ws = wsRef.current
    if (!ws?.getDecodedData()) return
    try {
      ws.zoom(zoom)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown waveform error.'
      reportError(`The waveform zoom could not be changed. ${message}`)
    }
  }, [zoom, ready, reportError])

  useEffect(() => {
    if (minimized || !ready) return
    const frame = window.requestAnimationFrame(() => {
      const ws = wsRef.current
      if (!ws?.getDecodedData()) return
      try {
        ws.zoom(zoomRef.current)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown waveform error.'
        reportError(`The waveform could not be reopened. ${message}`)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [minimized, ready, reportError])

  useEffect(() => {
    const regions = regionsRef.current
    if (!regions || !ready) return
    const colors = waveformColors()
    regions.getRegions()
      .filter((region) => region.id.startsWith('marker-') || region.id.startsWith('annotation-'))
      .forEach((region) => region.remove())
    const shortened = new Set(shortenedGapIds)
    const gapTargets = gapTargetsFromEdits(gapEdits)
    const timeline = buildTimeline(words, shortened, sourceDuration, insertClips, gapTargets)
    if (audioPreviewMode === 'edited') {
      for (const gap of editedGaps(words, shortened, sourceDuration, insertClips, gapTargets)) {
        if (gap.shortened) {
          regions.addRegion({
            id: `marker-sgap-${gap.wordId}`,
            start: gap.editedStart,
            end: Math.max(gap.editedEnd, gap.editedStart + 0.02),
            color: colors.shortened,
            drag: false,
            resize: false,
          })
        } else if (gap.origGap >= gapPacing.detectionThresholdMs / 1000) {
          regions.addRegion({
            id: `marker-gap-${gap.wordId}`,
            start: gap.editedStart,
            end: gap.editedEnd,
            color: colors.gap,
            drag: false,
            resize: false,
          })
        }
      }
      for (const [insertId, span] of editedInsertTimes(words, shortened, sourceDuration, insertClips, gapTargets)) {
        regions.addRegion({
          id: `marker-insert-${insertId}`,
          start: span.start,
          end: Math.max(span.end, span.start + 0.02),
          color: colors.insert,
          drag: false,
          resize: false,
        })
      }
    }
    const previewDuration = audioPreviewMode === 'original' ? sourceDuration : timeline.editedDuration
    for (const resolved of resolveMarkers(markers, timeline)) {
      const markerTime = audioPreviewMode === 'original' ? resolved.sourceTime : resolved.editedTime
      const markerStart = Math.max(0, Math.min(markerTime, Math.max(0, previewDuration - 0.025)))
      const annotation = regions.addRegion({
        id: `annotation-${resolved.marker.id}`,
        start: markerStart,
        end: Math.min(previewDuration, markerStart + 0.025),
        color: resolved.marker.kind === 'chapter' ? colors.chapter : colors.marker,
        drag: true,
        resize: false,
      })
      if (annotation.element) {
        const kind = resolved.marker.kind === 'chapter' ? 'chapter' : 'marker'
        annotation.element.title = `Drag to move ${kind}: ${resolved.marker.title}`
        annotation.element.setAttribute('aria-label', `Drag to move ${kind}: ${resolved.marker.title}`)
      }
    }
  }, [words, shortenedGapIds, gapEdits, gapPacing.detectionThresholdMs, sourceDuration, insertClips, markers, ready, audioPreviewMode, theme])

  const applyMenu = (action: 'remove' | 'shorten') => {
    if (!menu) return
    const { region } = menu
    const start = region.start
    const end = region.end
    const shortened = new Set(shortenedGapIds)
    const gapTargets = gapTargetsFromEdits(gapEdits)
    if (action === 'remove') {
      const times = audioPreviewMode === 'edited'
        ? editedWordTimes(words, shortened, sourceDuration, insertClips, gapTargets)
        : null
      const ids = words
        .filter((word) => {
          if (word.isRemoved) return false
          if (audioPreviewMode === 'original') return word.endTime > start && word.startTime < end
          const span = times?.get(word.id)
          return span && span.end > start && span.start < end
        })
        .map((word) => word.id)
      if (ids.length) removeWords(ids)
    } else {
      const gapIds = audioPreviewMode === 'original'
        ? words.flatMap((word, index) => {
          const next = words[index + 1]
          return next && !word.isRemoved && !next.isRemoved && next.startTime > word.endTime
            && next.startTime > start && word.endTime < end
            ? [word.id]
            : []
        })
        : editedGaps(words, shortened, sourceDuration, insertClips, gapTargets)
          .filter((gap) => !gap.shortened && gap.editedEnd > start && gap.editedStart < end)
          .map((gap) => gap.wordId)
      if (gapIds.length) shortenGaps(gapIds)
    }
    region.remove()
    activeSelectionRef.current = null
    setMenu(null)
  }

  const saveSelectionMarker = (kind: 'marker' | 'chapter') => {
    if (!menu) return
    const timeline = buildTimeline(
      words,
      new Set(shortenedGapIds),
      sourceDuration,
      insertClips,
      gapTargetsFromEdits(gapEdits),
    )
    const start = audioPreviewMode === 'original'
      ? { sourceTime: menu.region.start }
      : markerAnchorAtEditedTime(timeline, menu.region.start)
    const end = audioPreviewMode === 'original'
      ? { sourceTime: Math.max(menu.region.start, menu.region.end) }
      : markerAnchorAtEditedTime(timeline, menu.region.end)
    addMarker(kind, undefined, start, kind === 'marker' ? end : undefined)
    menu.region.remove()
    activeSelectionRef.current = null
    setMenu(null)
  }

  return (
    <section
      className={`${panelHeight} shrink-0 border-t border-line bg-canvas-raised relative flex flex-col transition-[height] duration-200`}
      aria-label="Audio timeline"
    >
      {!minimized && (
        <div className="h-9 shrink-0 px-3 sm:px-4 flex items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-ink-muted border-b border-line">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <ScissorsIcon className="h-3.5 w-3.5" /> Timeline
          </span>
          <span className="normal-case tracking-normal text-ink-muted hidden 2xl:inline">Drag a range to cut words or shorten a pause</span>
          <span className="normal-case tracking-normal text-ink-muted hidden xl:inline">
            <span className="text-ochre-dark">Long pause</span>
            <span className="mx-2 text-line-strong">·</span>
            <span className="text-forest-dark">Shortened</span>
            <span className="mx-2 text-line-strong">·</span>
            <span className="text-plum-dark">Insert</span>
          </span>
          <div role="group" aria-label="Timeline size" className="ml-auto flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-line bg-canvas-soft p-0.5 normal-case tracking-normal">
            {TIMELINE_SIZE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => onTimelineSizeChange(option.value)}
                aria-pressed={timelineSize === option.value}
                aria-controls="audio-waveform-content"
                className={`h-full rounded-[5px] px-2 text-[10px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ember ${
                  timelineSize === option.value
                    ? 'bg-canvas-raised text-ink shadow-sm shadow-line/30'
                    : 'text-ink-muted hover:bg-canvas-raised hover:text-ink'
                }`}
                title={option.title}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        id="audio-waveform-content"
        className={`relative overflow-hidden ${minimized ? 'h-0 invisible' : 'flex-1 min-h-0 visible'}`}
        aria-hidden={minimized}
      >
        <div ref={containerRef} className="h-full min-h-0 px-2 overflow-hidden" />
        {!minimized && (!ready || rendering) && (
          <div className="absolute inset-0 flex items-center justify-center text-ink-muted text-xs pointer-events-none bg-canvas/70 backdrop-blur-[1px]" aria-live="polite">
            {rendering ? (
              <span className="inline-flex items-center gap-2"><span className="h-3.5 w-3.5 rounded-full border-2 border-line-strong border-t-ember animate-spin" /> Updating audio preview…</span>
            ) : audioUrl ? (
              <span className="inline-flex items-center gap-2"><span className="h-3.5 w-3.5 rounded-full border-2 border-line-strong border-t-ember animate-spin" /> Loading waveform...</span>
            ) : 'The waveform will appear when the local preview is ready.'}
          </div>
        )}
      </div>
      <TransportBar
        variant={minimized ? 'thin' : 'full'}
        zoom={zoom}
        setZoom={setZoom}
        onShowTimeline={onShowTimeline}
      />
      {!minimized && menu && (
        <div
          className="absolute z-40 flex items-center gap-1 rounded-xl border border-line-strong bg-canvas-raised p-1.5 shadow-2xl shadow-ink/15"
          style={{ left: Math.max(8, Math.min(menu.x - 120, (containerRef.current?.clientWidth || 260) - 252)), top: menu.y + 34 }}
          role="toolbar"
          aria-label="Waveform selection actions"
        >
          <button type="button" onClick={() => applyMenu('remove')} className="h-8 px-3 rounded-lg text-[12px] font-medium text-danger-dark hover:bg-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger">
            Ripple cut
          </button>
          <button type="button" onClick={() => applyMenu('shorten')} className="h-8 px-3 rounded-lg text-[12px] font-medium text-forest-dark hover:bg-forest-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest">
            Shorten pause
          </button>
          <button type="button" onClick={() => saveSelectionMarker('marker')} className="h-8 px-3 rounded-lg text-[12px] font-medium text-ink hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">
            Save marker
          </button>
          <button type="button" onClick={() => saveSelectionMarker('chapter')} className="h-8 px-3 rounded-lg text-[12px] font-medium text-ember-dark hover:bg-ember-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">
            Start chapter
          </button>
          <button
            type="button"
            disabled={exporting}
            onClick={() => {
              const { start, end } = menu.region
              const range = audioPreviewMode === 'original'
                ? sourceRangeToEdited(
                  buildTimeline(words, new Set(shortenedGapIds), sourceDuration, insertClips, gapTargetsFromEdits(gapEdits)),
                  start,
                  end,
                )
                : { start, end }
              menu.region.remove()
              activeSelectionRef.current = null
              setMenu(null)
              void exportProject(audioExportFormat, range)
            }}
            className="h-8 px-3 rounded-lg text-[12px] font-medium text-ink hover:bg-canvas-soft disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            title={`Export just this selection as ${audioExportFormat.toUpperCase()}`}
          >
            {exporting ? 'Exporting…' : `Export ${audioExportFormat.toUpperCase()}`}
          </button>
          <button
            type="button"
            onClick={() => {
              menu.region.remove()
              activeSelectionRef.current = null
              setMenu(null)
            }}
            className="h-8 w-8 grid place-items-center rounded-lg text-ink-muted hover:bg-canvas-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            aria-label="Clear waveform selection"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </section>
  )
}
