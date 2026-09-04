import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../store'
import { describeEmptyGapReview } from '../lib/cleanup'
import type { CleanupKind } from '../lib/cleanup'
import { fmtTime } from '../lib/timeline'
import type { CleanupSummary, NoiseLevel } from '../types'
import GapPacingDialog from './GapPacingDialog'
import MarkerPanel from './MarkerPanel'
import {
  CheckIcon,
  FillerIcon,
  GapIcon,
  LevelsIcon,
  NoiseIcon,
  RetakeIcon,
  RevertIcon,
  SparklesIcon,
} from './Icons'

const NOISE_OPTIONS: { value: NoiseLevel; label: string; hint: string }[] = [
  { value: 'off', label: 'No noise cleanup', hint: 'Leave background noise untouched' },
  { value: 'light', label: 'Light', hint: 'Gentle hiss reduction; safest for quiet rooms' },
  { value: 'medium', label: 'Medium', hint: 'Removes steady hum, fans, and air conditioning' },
  { value: 'strong', label: 'Strong', hint: 'Most aggressive; can thin the voice on noisy takes' },
]

interface CleanupModeConfig {
  kind: CleanupKind
  buttonLabel: string
  dialogTitle: string
  previewCopy: string
  emptyCopy: string
  buttonClass: string
  activeButtonClass: string
  iconClass: string
  metricClass: string
  applyClass: string
}

const CLEANUP_MODES: CleanupModeConfig[] = [
  {
    kind: 'fillers',
    buttonLabel: 'Remove fillers',
    dialogTitle: 'Review filler removal',
    previewCopy: 'Potential filler words are highlighted in amber. Your recording does not change until you apply.',
    emptyCopy: 'No removable filler words were found in this transcript.',
    buttonClass: '!border-line !bg-canvas-raised !text-ink hover:!bg-canvas-soft',
    activeButtonClass: '!border-ochre/50 !bg-ochre-soft ring-1 ring-inset ring-ochre/25',
    iconClass: 'bg-ochre-soft text-ochre-dark',
    metricClass: 'border-ochre/25 bg-ochre-soft text-ochre-dark',
    applyClass: 'bg-ochre-dark hover:bg-ochre focus-visible:ring-ochre',
  },
  {
    kind: 'gaps',
    buttonLabel: 'Shorten gaps',
    dialogTitle: 'Review gap shortening',
    previewCopy: 'Long pauses proposed for shortening are marked in green. Choose exact pacing before applying, and restore any pause later.',
    emptyCopy: 'No eligible long gaps were found in this transcript.',
    buttonClass: '!border-forest/20 !bg-forest-soft !text-forest-dark hover:!border-forest/35 hover:!bg-forest/10',
    activeButtonClass: '!border-forest/50 !bg-forest/15 ring-1 ring-inset ring-forest/25',
    iconClass: 'bg-forest-soft text-forest-dark',
    metricClass: 'border-forest/25 bg-forest-soft text-forest-dark',
    applyClass: 'bg-forest-dark hover:bg-forest focus-visible:ring-forest',
  },
  {
    kind: 'retakes',
    buttonLabel: 'Remove retakes',
    dialogTitle: 'Review retake removal',
    previewCopy: 'Likely false starts and repeated takes are highlighted in violet. Choose and audition the take to keep before applying.',
    emptyCopy: 'No likely retakes were found in this transcript.',
    buttonClass: '!border-plum/20 !bg-plum-soft !text-plum-dark hover:!border-plum/35 hover:!bg-plum/10',
    activeButtonClass: '!border-plum/50 !bg-plum/15 ring-1 ring-inset ring-plum/25',
    iconClass: 'bg-plum-soft text-plum-dark',
    metricClass: 'border-plum/25 bg-plum-soft text-plum-dark',
    applyClass: 'bg-plum-dark hover:bg-plum focus-visible:ring-plum',
  },
]

function modeConfig(kind: CleanupKind): CleanupModeConfig {
  return CLEANUP_MODES.find((mode) => mode.kind === kind) ?? CLEANUP_MODES[0]
}

function modeCount(kind: CleanupKind, summary: CleanupSummary): number {
  return summary[kind]
}

function countNoun(kind: CleanupKind, count: number): string {
  if (kind === 'fillers') return `filler word${count === 1 ? '' : 's'}`
  if (kind === 'gaps') return `gap${count === 1 ? '' : 's'}`
  return `retake word${count === 1 ? '' : 's'}`
}

function applyLabel(kind: CleanupKind, count: number): string {
  const verb = kind === 'gaps' ? 'Shorten' : 'Remove'
  return `${verb} ${count} ${countNoun(kind, count)}`
}

function appliedTitle(kind: CleanupKind): string {
  if (kind === 'fillers') return 'Filler removal applied'
  if (kind === 'gaps') return 'Gap shortening applied'
  return 'Retake removal applied'
}

function appliedDetail(kind: CleanupKind, count: number): string {
  const verb = kind === 'gaps' ? 'shortened' : 'removed'
  return `${count} ${countNoun(kind, count)} ${verb}. Undo is available.`
}

function CleanupModeIcon({ kind, className }: { kind: CleanupKind; className?: string }) {
  if (kind === 'fillers') return <FillerIcon className={className} />
  if (kind === 'gaps') return <GapIcon className={className} />
  return <RetakeIcon className={className} />
}

export default function TopBar({
  panel,
  onClosePanel,
}: {
  panel: string | null
  onClosePanel: () => void
}) {
  const status = useStore((state) => state.status)
  const rendering = useStore((state) => state.rendering)
  const studioSound = useStore((state) => state.studioSound)
  const toggleStudio = useStore((state) => state.toggleStudio)
  const normalizeLoudness = useStore((state) => state.normalizeLoudness)
  const toggleNormalize = useStore((state) => state.toggleNormalize)
  const noiseReduction = useStore((state) => state.noiseReduction)
  const setNoiseReduction = useStore((state) => state.setNoiseReduction)
  const openCleanupWorkbench = useStore((state) => state.openCleanupWorkbench)
  const closeCleanupWorkbench = useStore((state) => state.closeCleanupWorkbench)
  const cleanupPreview = useStore((state) => state.cleanupPreview)
  const cleanupWorkbenchOpen = useStore((state) => state.cleanupWorkbenchOpen)
  const cleanupWorkbenchFilter = useStore((state) => state.cleanupWorkbenchFilter)
  const setCleanupWorkbenchFilter = useStore((state) => state.setCleanupWorkbenchFilter)
  const focusedCleanupProposalId = useStore((state) => state.focusedCleanupProposalId)
  const focusCleanupProposal = useStore((state) => state.focusCleanupProposal)
  const auditionCleanupProposal = useStore((state) => state.auditionCleanupProposal)
  const auditionRetakeCandidate = useStore((state) => state.auditionRetakeCandidate)
  const setCleanupSelection = useStore((state) => state.setCleanupSelection)
  const selectRetakeCandidate = useStore((state) => state.selectRetakeCandidate)
  const selectHighConfidenceCleanup = useStore((state) => state.selectHighConfidenceCleanup)
  const ignoreCleanupProposal = useStore((state) => state.ignoreCleanupProposal)
  const applyCleanup = useStore((state) => state.applyCleanup)
  const lastCleanup = useStore((state) => state.lastCleanup)
  const revertToOriginal = useStore((state) => state.revertToOriginal)
  const hasEdits = useStore((state) => state.hasEdits)
  const audioUrl = useStore((state) => state.audioUrl)
  const waveformReady = useStore((state) => state.waveformReady)
  const gapPacing = useStore((state) => state.gapPacing)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [showPacing, setShowPacing] = useState(false)
  const [showMarkers, setShowMarkers] = useState(false)
  const noiseId = useId()
  const noiseHintId = useId()
  const cleanupDialogTitleId = useId()
  const cleanupDialogDescriptionId = useId()
  const cleanupDialogRef = useRef<HTMLDivElement>(null)
  const cleanupButtonRefs = useRef<Partial<Record<CleanupKind, HTMLButtonElement | null>>>({})
  const ready = status === 'ready'
  const selectedNoise = NOISE_OPTIONS.find((option) => option.value === noiseReduction) ?? NOISE_OPTIONS[0]
  const previewKind = cleanupPreview?.kind ?? null

  const activeMode = previewKind ? modeConfig(previewKind) : null
  const proposalCount = cleanupPreview?.proposals.length ?? 0
  const selectedCleanupCount = cleanupPreview && previewKind ? modeCount(previewKind, cleanupPreview.selectedSummary) : 0
  const selectedProposalIds = new Set(cleanupPreview?.selectedProposalIds ?? [])
  const selectedProposalCount = selectedProposalIds.size
  const canAuditionCleanup = ready && Boolean(audioUrl) && waveformReady && !rendering
  const lastCleanupMode = lastCleanup ? modeConfig(lastCleanup.kind) : null
  const lastCleanupCount = lastCleanup ? modeCount(lastCleanup.kind, lastCleanup.summary) : 0

  useEffect(() => {
    if (previewKind && cleanupWorkbenchOpen) cleanupDialogRef.current?.focus({ preventScroll: true })
  }, [previewKind, cleanupWorkbenchOpen])

  const returnCleanupFocus = (kind: CleanupKind) => {
    window.setTimeout(() => cleanupButtonRefs.current[kind]?.focus({ preventScroll: true }), 0)
  }

  const cancelCleanupReview = () => {
    if (!previewKind) return
    closeCleanupWorkbench()
    returnCleanupFocus(previewKind)
  }

  const applyCleanupReview = () => {
    if (!previewKind) return
    applyCleanup()
    returnCleanupFocus(previewKind)
  }

  const visibleProposals = (cleanupPreview?.proposals ?? []).filter((proposal) => {
    const selected = selectedProposalIds.has(proposal.id)
    if (cleanupWorkbenchFilter === 'selected') return selected
    if (cleanupWorkbenchFilter === 'high') return proposal.confidence === 'high'
    if (cleanupWorkbenchFilter === 'review') return proposal.confidence !== 'high'
    return true
  })

  const moveCleanupFocus = (direction: -1 | 1) => {
    if (!visibleProposals.length) return
    const index = visibleProposals.findIndex((proposal) => proposal.id === focusedCleanupProposalId)
    const next = visibleProposals[(index + direction + visibleProposals.length) % visibleProposals.length]
    focusCleanupProposal(next.id)
  }

  return (
    <aside className={`workspace-inspector inspector-${panel ?? "closed"}`} aria-label="Editing tools" hidden={!panel || panel === "Project" || panel === "Settings"}><h2>{panel}</h2>
      {(!cleanupWorkbenchOpen || panel !== 'Cleanup') && <div className="inspector-controls">
        {panel === 'Cleanup' && <div className="cleanup-tools">
          {(['retakes', 'fillers', 'gaps'] as CleanupKind[]).map(kind => <button key={kind} ref={element => { cleanupButtonRefs.current[kind] = element }} disabled={!ready} onClick={() => openCleanupWorkbench(kind)}>
            <CleanupModeIcon kind={kind} /><span><strong>{kind === 'retakes' ? 'Remove retakes' : kind === 'fillers' ? 'Remove filler words' : 'Shorten word gaps'}</strong><small>{kind === 'retakes' ? 'Compare repeated attempts' : kind === 'fillers' ? 'Review words in context' : 'Adjust long pauses'}</small><em>Review</em></span>
          </button>)}
        </div>}
        {(panel === 'Cleanup' || panel === 'Properties') && <div className="audio-properties"><h3>Audio</h3>
          <button disabled={!ready} onClick={toggleStudio} aria-pressed={studioSound}><SparklesIcon /><span>Studio Sound<small>EQ, de-essing and compression</small></span><span className="state-label">{studioSound ? 'On' : 'Off'}</span></button>
          <label><NoiseIcon /><span>Noise reduction</span><select id={noiseId} value={noiseReduction} disabled={!ready} onChange={event => setNoiseReduction(event.target.value as NoiseLevel)} aria-describedby={noiseHintId}>{NOISE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.value === 'off' ? 'Off' : option.label}</option>)}</select></label>
          <small id={noiseHintId}>{selectedNoise.hint}</small>
          <button disabled={!ready} onClick={() => toggleNormalize()} aria-pressed={normalizeLoudness}><LevelsIcon /><span>Normalize audio<small>Even out loudness</small></span><span className="state-label">{normalizeLoudness ? 'On' : 'Off'}</span></button>
          <button disabled={!ready} onClick={() => setShowPacing(!showPacing)} aria-expanded={showPacing}><GapIcon /><span>Pacing settings<small>Retain {gapPacing.targetGapMs} ms of each shortened gap</small></span></button>
        </div>}
        {panel === 'Properties' && <>        <div className="relative">
          <button
            type="button"
            onClick={() => setConfirmRevert((open) => !open)}
            disabled={!ready || !hasEdits()}
            aria-haspopup="dialog"
            aria-expanded={confirmRevert}
            className="toolbar-secondary-button"
            title="Undo every cut, pause shortening, and insert in one step"
          >
            <RevertIcon />
            <span className="hidden 2xl:inline">Revert all</span>
          </button>
          {confirmRevert && (
            <div
              role="dialog"
              aria-label="Confirm revert to original"
              className="absolute left-0 top-[calc(100%+8px)] z-50 w-[300px] rounded-xl border border-line-strong bg-canvas-raised p-3.5 shadow-2xl shadow-ink/15"
            >
              <p className="text-[12px] leading-5 text-ink-muted">
                Restore every removed word, undo all shortened pauses, and take recorded inserts
                back out of the timeline. Studio sound, noise cleanup, and normalize are left as they are.
                This is undoable.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmRevert(false)}
                  className="h-8 px-3 rounded-lg text-[12px] font-medium text-ink-muted hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => { revertToOriginal(); setConfirmRevert(false) }}
                  className="h-8 px-3 rounded-lg bg-danger-dark hover:bg-danger text-[12px] font-semibold text-ink-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                >
                  Revert all edits
                </button>
              </div>
            </div>
          )}
        </div>

</>}
      </div>}

      <GapPacingDialog open={showPacing} onClose={() => setShowPacing(false)} />
      <MarkerPanel open={showMarkers || panel === "Chapters"} onClose={() => { setShowMarkers(false); if (panel === 'Chapters') onClosePanel() }} />

      {panel === "Cleanup" && cleanupPreview && previewKind && activeMode && cleanupWorkbenchOpen && (
        <div
          ref={cleanupDialogRef}
          role="dialog"
          aria-labelledby={cleanupDialogTitleId}
          aria-describedby={cleanupDialogDescriptionId}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              cancelCleanupReview()
            }
          }}
          className="cleanup-review rounded-xl border border-line bg-canvas-raised p-3 outline-none focus-visible:ring-2 focus-visible:ring-ember"
        >
          <div className="flex items-start gap-3">
            <span className={`h-9 w-9 shrink-0 rounded-xl grid place-items-center ${activeMode.iconClass}`}>
              <CleanupModeIcon kind={previewKind} className="h-5 w-5" />
            </span>
            <div className="min-w-0">
                <h2 id={cleanupDialogTitleId} className="text-sm font-semibold text-ink">{activeMode.dialogTitle}</h2>
              <p id={cleanupDialogDescriptionId} className="text-[12px] leading-5 text-ink-muted mt-0.5">
                {activeMode.previewCopy}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
            <div role="tablist" aria-label="Cleanup kinds" className="flex items-center gap-1 rounded-lg bg-canvas-soft p-1">
              {CLEANUP_MODES.map((mode) => (
                <button
                  key={mode.kind}
                  type="button"
                  role="tab"
                  aria-selected={previewKind === mode.kind}
                  onClick={() => openCleanupWorkbench(mode.kind)}
                  className={`h-8 rounded-md px-2.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember ${previewKind === mode.kind ? 'bg-canvas-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}
                >
                  {mode.kind === 'fillers' ? 'Fillers' : mode.kind === 'gaps' ? 'Gaps' : 'Retakes'}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1" role="group" aria-label="Cleanup suggestion filter">
              {([
                ['all', 'All'],
                ['high', 'High'],
                ['review', 'Review'],
                ['selected', 'Selected'],
              ] as const).map(([filter, label]) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setCleanupWorkbenchFilter(filter)}
                  aria-pressed={cleanupWorkbenchFilter === filter}
                  className={`h-7 rounded-md px-2 text-[10px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember ${cleanupWorkbenchFilter === filter ? 'bg-ember-soft text-ember-dark' : 'text-ink-muted hover:bg-canvas-soft hover:text-ink'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className={`mt-4 flex items-center justify-between rounded-xl border px-3.5 py-3 ${activeMode.metricClass}`}>
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] opacity-75">
              {visibleProposals.length} shown · {proposalCount} suggestion{proposalCount === 1 ? '' : 's'}
            </span>
            <span className="flex items-center gap-1.5">
              <button type="button" onClick={() => moveCleanupFocus(-1)} disabled={!visibleProposals.length} className="h-7 rounded-md px-2 text-[11px] font-semibold hover:bg-canvas-raised disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember" title="Previous suggestion">←</button>
              <span className="text-sm font-semibold tabular-nums">{selectedProposalCount} selected</span>
              <button type="button" onClick={() => moveCleanupFocus(1)} disabled={!visibleProposals.length} className="h-7 rounded-md px-2 text-[11px] font-semibold hover:bg-canvas-raised disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember" title="Next suggestion">→</button>
            </span>
          </div>
          {proposalCount === 0 && (
            <p className="mt-3 rounded-lg bg-forest-soft px-3 py-2 text-[12px] text-forest-dark">
              {previewKind === 'retakes' && cleanupPreview?.retakeDiagnostics
                ? `${activeMode.emptyCopy} ${cleanupPreview.retakeDiagnostics.candidateWindows} local comparison window${cleanupPreview.retakeDiagnostics.candidateWindows === 1 ? '' : 's'} ran; none met the review safeguards.`
                : previewKind === 'gaps' && cleanupPreview?.gapDiagnostics
                  ? describeEmptyGapReview(cleanupPreview.gapDiagnostics, gapPacing.detectionThresholdMs)
                  : activeMode.emptyCopy}
            </p>
          )}
          {proposalCount > 0 && (
            <div className="mt-3 max-h-[min(46vh,390px)] space-y-2 overflow-y-auto pr-1" role="group" aria-label="Cleanup suggestions">
              {!visibleProposals.length && <p className="rounded-lg bg-canvas-soft px-3 py-2 text-[12px] text-ink-muted">No suggestions match this filter.</p>}
              {visibleProposals.map((proposal) => {
                const selected = selectedProposalIds.has(proposal.id)
                const confidenceClass = proposal.confidence === 'high'
                  ? 'bg-forest-soft text-forest-dark'
                  : proposal.confidence === 'medium'
                    ? 'bg-ochre-soft text-ochre-dark'
                    : 'bg-canvas-soft text-ink-muted'
                return (
                  <div key={proposal.id} className={`block rounded-xl border p-3 transition-colors ${focusedCleanupProposalId === proposal.id ? 'ring-2 ring-ember/35' : ''} ${selected ? 'border-ember/35 bg-ember-soft/45' : 'border-line bg-canvas'}`}>
                    <span className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) => {
                          // Retakes need an explicit keep choice. Selecting the
                          // proposal checkbox is an affirmative request to use
                          // the visible recommendation, never an invisible
                          // default merely because the preview opened.
                          if (proposal.retakeGroup && event.target.checked && !cleanupPreview?.retakeCandidateChoices[proposal.id]) {
                            selectRetakeCandidate(proposal.id, proposal.retakeGroup.recommendedCandidateId)
                            return
                          }
                          const next = new Set(selectedProposalIds)
                          if (event.target.checked) next.add(proposal.id)
                          else next.delete(proposal.id)
                          setCleanupSelection([...next])
                        }}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-line accent-ember"
                        aria-label={`Select cleanup suggestion at ${fmtTime(proposal.startTime)}`}
                      />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => focusCleanupProposal(proposal.id)}
                              className="font-mono text-[11px] text-ember-dark tabular-nums hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember rounded"
                              title="Review this suggestion in the current timeline"
                            >
                              {fmtTime(proposal.startTime)}
                            </button>
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${confidenceClass}`}>{proposal.confidence}</span>
                          </span>
                        <span className="mt-1 block text-[12px] font-medium leading-4 text-ink">{proposal.reason}</span>
                        <span className="mt-1 block text-[11px] leading-4 text-ink-muted">“{proposal.context}”</span>
                        {proposal.originalGapMs !== undefined && proposal.targetGapMs !== undefined && (
                          <span className="mt-1 block text-[11px] text-ink-muted">{proposal.originalGapMs}ms pause → about {proposal.targetGapMs}ms</span>
                        )}
                        {proposal.retakeGroup ? (
                          <span className="mt-2 block rounded-lg border border-plum/20 bg-plum-soft/50 p-2">
                            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-plum-dark">Choose the take to keep</span>
                            {proposal.retakeGroup.candidates.map((candidate) => {
                              const choice = cleanupPreview.retakeCandidateChoices[proposal.id]
                              const recommended = candidate.id === proposal.retakeGroup?.recommendedCandidateId
                              return (
                                <span key={candidate.id} className="mt-1 flex items-start gap-1 rounded-md px-1 py-0.5 text-[11px] text-ink hover:bg-canvas-raised">
                                {recommended && <span className="rounded bg-plum/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-plum-dark">Recommended</span>}
                                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
                                  {recommended && <span className="sr-only">Recommended take. </span>}
                                  <input
                                    type="radio"
                                    name={`retake-${proposal.id}`}
                                    checked={choice === candidate.id}
                                    onChange={() => selectRetakeCandidate(proposal.id, candidate.id)}
                                    title={recommended ? 'Recommended take' : undefined}
                                    className="mt-0.5 h-3.5 w-3.5 accent-plum"
                                  />
                                  <span><strong className="font-semibold">{candidate.label}</strong> · {candidate.transcript}</span>
                                </label>
                                <button
                                  type="button"
                                  disabled={!canAuditionCleanup}
                                  onClick={() => auditionRetakeCandidate(proposal.id, candidate.id)}
                                  className="h-6 shrink-0 rounded px-1.5 text-[10px] font-semibold text-plum-dark hover:bg-canvas-raised disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-plum"
                                  title={canAuditionCleanup ? `Play ${candidate.label} in context` : 'Wait for the local audio preview to load'}
                                >
                                  Audition
                                </button>
                                </span>
                              )
                            })}
                            {!cleanupPreview.retakeCandidateChoices[proposal.id] && (
                              <span className="mt-2 flex items-center justify-between gap-2 text-[10px] text-ink-muted">
                                Choose a take before applying this suggestion.
                                <button
                                  type="button"
                                  onClick={() => selectRetakeCandidate(proposal.id, proposal.retakeGroup!.recommendedCandidateId)}
                                  className="rounded px-1.5 py-1 font-semibold text-plum-dark hover:bg-canvas-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-plum"
                                >
                                  Use recommended
                                </button>
                              </span>
                            )}
                            <span className="mt-1 block text-[10px] leading-4 text-ink-muted">{proposal.retakeGroup.recommendationReason}</span>
                          </span>
                        ) : proposal.recommendedKeepIds?.length ? (
                          <span className="mt-1 block text-[11px] text-ink-muted">Keeps the following {proposal.recommendedKeepIds.length}-word take.</span>
                        ) : null}
                      </span>
                    </span>
                    <span className="mt-2 flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        disabled={!canAuditionCleanup || Boolean(proposal.retakeGroup && !cleanupPreview.retakeCandidateChoices[proposal.id])}
                        onClick={(event) => { event.preventDefault(); auditionCleanupProposal(proposal.id) }}
                        className="h-7 rounded-md px-2 text-[11px] font-semibold text-ember-dark hover:bg-ember-soft disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                        title={proposal.retakeGroup && !cleanupPreview.retakeCandidateChoices[proposal.id] ? 'Choose a take to keep first' : canAuditionCleanup ? 'Preview the selected cuts' : 'Wait for the local audio preview to load'}
                      >
                          Audition cut
                      </button>
                      <button
                        type="button"
                        onClick={() => focusCleanupProposal(proposal.id)}
                        className="h-7 rounded-md px-2 text-[11px] font-semibold text-ink-muted hover:bg-canvas-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                        title="Seek to this proposal in the current timeline"
                      >
                        Review in timeline
                      </button>
                      <button
                        type="button"
                        onClick={(event) => { event.preventDefault(); ignoreCleanupProposal(proposal.id) }}
                        className="h-7 rounded-md px-2 text-[11px] font-semibold text-ink-muted hover:bg-canvas-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                        title="Keep this content and do not suggest this same item again"
                      >
                        Keep / ignore
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          <div className="flex justify-end gap-2 mt-4">
            {proposalCount > 0 && (
              <button
                type="button"
                onClick={selectHighConfidenceCleanup}
                className="h-9 px-3 rounded-lg text-[12px] font-medium text-ink-muted hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                title="Select only high-confidence suggestions"
              >
                Select high confidence
              </button>
            )}
            <button type="button" onClick={cancelCleanupReview} className="h-9 px-3 rounded-lg text-[12px] font-medium text-ink-muted hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember">
              Cancel
            </button>
            <button
              type="button"
              onClick={applyCleanupReview}
              disabled={selectedCleanupCount === 0}
              className={`h-9 px-4 rounded-lg disabled:opacity-40 text-[12px] font-semibold text-ink-inverse focus-visible:outline-none focus-visible:ring-2 ${activeMode.applyClass}`}
            >
              {applyLabel(previewKind, selectedCleanupCount)}
            </button>
          </div>
          <p className="mt-2 text-[10px] text-ink-muted">Keep / ignore choices are saved with this local project. Applied changes remain undoable and restorable from the transcript.</p>
        </div>
      )}

      {lastCleanup && lastCleanupMode && (
        <div role="status" className="mt-4 rounded-xl border border-forest/25 bg-canvas-raised px-4 py-3 flex items-center gap-3">
          <span className="h-7 w-7 rounded-full bg-forest-soft text-forest grid place-items-center">
            <CheckIcon className="h-4 w-4" />
          </span>
          <div>
            <div className="text-[12px] font-semibold text-ink">{appliedTitle(lastCleanup.kind)}</div>
            <div className="text-[11px] text-ink-muted">
              {appliedDetail(lastCleanup.kind, lastCleanupCount)}
            </div>
            {lastCleanup.kind === 'retakes' && <button disabled={!ready} onClick={() => openCleanupWorkbench('retakes')} className="mt-2 text-[12px] font-semibold text-ember-dark disabled:opacity-40">Review remaining retakes</button>}
          </div>
        </div>
      )}
    </aside>
  )
}
