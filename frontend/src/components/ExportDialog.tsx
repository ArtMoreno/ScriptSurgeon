import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useIntegrations } from '../lib/integrations'
import { buildTimeline, fmtTime } from '../lib/timeline'
import { gapTargetsFromEdits } from '../lib/gapPacing'
import { AudioIcon, CloseIcon } from './Icons'
import { resolveExportRange } from '../lib/exportRange'

const tabs = ['Audio', 'Timeline', 'Transcript', 'Subtitles'] as const
type Tab = typeof tabs[number]

export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const state = useStore()
  const targets = useIntegrations(s => s.targets)
  const [tab, setTab] = useState<Tab>('Audio')
  const [format, setFormat] = useState<string>(state.audioExportFormat)
  const [feedback, setFeedback] = useState('')
  const [range, setRange] = useState(false)
  const [start, setStart] = useState('0')
  const [end, setEnd] = useState('')
  const [chapters, setChapters] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const duration = buildTimeline(state.words, new Set(state.shortenedGapIds), state.sourceDuration, state.insertClips, gapTargetsFromEdits(state.gapEdits)).editedDuration
  const resolvedRange = resolveExportRange(start, end, duration)
  const validRange = !range || resolvedRange !== null
  const exportDuration = range && resolvedRange ? resolvedRange.end - resolvedRange.start : duration
  const options = tab === 'Audio' ? [['wav', 'WAV (.wav)'], ['mp3', 'MP3 (.mp3)']]
    : tab === 'Subtitles' ? [['srt', 'SubRip (.srt)'], ['vtt', 'WebVTT (.vtt)']]
    : tab === 'Transcript' ? [['txt', 'Plain text (.txt)']]
    : targets.map(t => [t.id, t.label])
  const selected = options.some(o => o[0] === format) ? format : options[0]?.[0] ?? ''
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  const run = async () => {
    if (!validRange || !selected || state.exporting || state.status !== 'ready') return
    setFeedback('')
    if (tab === 'Audio') {
      const audioFormat = selected === 'mp3' ? 'mp3' : 'wav'
      state.setAudioExportFormat(audioFormat)
      await state.exportProject(audioFormat, range ? resolvedRange : null)
    } else if (tab === 'Timeline') {
      const target = targets.find(t => t.id === selected)
      if (target) await state.exportIntegration(target.id, target.extension)
    } else {
      state.exportTranscript(tab === 'Transcript' ? 'txt' : selected === 'vtt' ? 'vtt' : 'srt', { includeChapterHeadings: chapters && tab === 'Transcript', includeChapterCues: chapters && tab === 'Subtitles' })
    }
    const latest = useStore.getState()
    if (latest.projectId === state.projectId && !latest.operationError) {
      setFeedback(`${options.find(o => o[0] === selected)?.[1] ?? selected} is ready. Download requested; check your browser downloads or save dialog.`)
    }
  }
  return <dialog ref={dialog} className="export-dialog" aria-labelledby="export-title" onCancel={onClose}>
    <header><h2 id="export-title">Export</h2><button onClick={onClose} aria-label="Close export"><CloseIcon /></button></header>
    <fieldset disabled={state.exporting} onChange={() => setFeedback('')}>
    <legend className="sr-only">Export settings</legend>
    <div className="export-tabs" role="group" aria-label="Export type">{tabs.map(t => <button key={t} aria-pressed={tab === t} onClick={() => { setTab(t); setRange(false); setFeedback('') }}>{t}</button>)}</div>
    <div className="export-file"><AudioIcon className="h-8 w-8" /><div><strong>{state.projectName}</strong><p>{validRange ? fmtTime(exportDuration) : 'Invalid range'} · {range ? 'Selected range' : 'Edited project'}</p></div></div>
    <div className="export-fields">
      <div><span>Destination</span><span>Local export</span></div>
      <label>Export range<select value={range ? 'range' : 'all'} onChange={e => setRange(e.target.value === 'range')} disabled={tab !== 'Audio'}><option value="all">Entire project</option><option value="range">Time range</option></select></label>
      {range && <div className="export-range"><label>Start (seconds)<input type="number" min="0" step="0.01" value={start} onChange={e => setStart(e.target.value)} /></label><label>End (seconds)<input type="number" min="0" max={duration} step="0.01" value={end} placeholder={duration.toFixed(2)} onChange={e => setEnd(e.target.value)} /></label></div>}
      {!validRange && <p role="alert">Choose at least 0.01 seconds within the edited audio, with the end after the start.</p>}
      <label>Format<select value={selected} onChange={e => setFormat(e.target.value)} disabled={!options.length}>{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {!options.length && <p role="status">Timeline formats are unavailable. Check the local server connection.</p>}
    </div>
    <details><summary>Advanced</summary>{tab === 'Audio' ? <p>Uses current processing: Studio Sound {state.studioSound ? 'on' : 'off'}, noise reduction {state.noiseReduction}, normalization {state.normalizeLoudness ? 'on' : 'off'}. MP3 exports at 192 kbps.</p> : tab === 'Timeline' ? <p>The handoff uses your saved edits and source media references.</p> : <label className="export-check"><input type="checkbox" checked={chapters} onChange={e => setChapters(e.target.checked)} /> Include chapters</label>}</details>
    </fieldset>
    <p className="export-note">Your original recording is preserved. Your browser or desktop save dialog chooses the destination.</p>
    {feedback && <p role="status" className="export-note">{feedback}</p>}
    {state.operationError && <p role="alert" className="export-error">{state.operationError}</p>}
    <button className="export-primary" disabled={state.status !== 'ready' || state.exporting || !validRange || !selected} onClick={() => void run()}>{state.exporting ? 'Exporting…' : `Export ${tab.toLowerCase()}`}</button>
  </dialog>
}
