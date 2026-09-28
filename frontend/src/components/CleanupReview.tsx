import { useEffect, useId, useMemo, useRef } from 'react'
import { useStore } from '../store'
import { describeEmptyGapReview } from '../lib/cleanup'
import type { CleanupKind, CleanupProposal, RetakeCandidate } from '../lib/cleanup'
import { fmtTime } from '../lib/timeline'
import type { CleanupSummary, Word } from '../types'
import { FillerIcon, GapIcon, PlayIcon, RetakeIcon } from './Icons'

export interface CleanupModeConfig {
  kind: CleanupKind
  buttonLabel: string
  dialogTitle: string
  previewCopy: string
  emptyCopy: string
  iconClass: string
  applyClass: string
}

export const CLEANUP_MODES: CleanupModeConfig[] = [
  {
    kind: 'fillers',
    buttonLabel: 'Remove fillers',
    dialogTitle: 'Review fillers',
    previewCopy: 'Filler words are tinted amber in the transcript. Nothing changes until you apply.',
    emptyCopy: 'No removable filler words were found in this transcript.',
    iconClass: 'bg-ochre-soft text-ochre-dark',
    applyClass: 'bg-ochre-dark hover:bg-ochre focus-visible:ring-ochre',
  },
  {
    kind: 'gaps',
    buttonLabel: 'Shorten gaps',
    dialogTitle: 'Review pauses',
    previewCopy: 'Long pauses are marked in the transcript. Nothing changes until you apply.',
    emptyCopy: 'No pauses long enough to shorten were found.',
    iconClass: 'bg-forest-soft text-forest-dark',
    applyClass: 'bg-forest-dark hover:bg-forest focus-visible:ring-forest',
  },
  {
    kind: 'retakes',
    buttonLabel: 'Remove retakes',
    dialogTitle: 'Review retakes',
    previewCopy: 'Each group is a choice between takes. Pick the one to keep; the others are cut when you apply.',
    emptyCopy: 'No repeated attempts were found.',
    iconClass: 'bg-plum-soft text-plum-dark',
    applyClass: 'bg-plum-dark hover:bg-plum focus-visible:ring-plum',
  },
]

export function modeConfig(kind: CleanupKind): CleanupModeConfig {
  return CLEANUP_MODES.find((mode) => mode.kind === kind) ?? CLEANUP_MODES[0]
}

export function modeCount(kind: CleanupKind, summary: CleanupSummary): number {
  return summary[kind]
}

export function countNoun(kind: CleanupKind, count: number): string {
  if (kind === 'fillers') return `filler word${count === 1 ? '' : 's'}`
  if (kind === 'gaps') return `pause${count === 1 ? '' : 's'}`
  return `word${count === 1 ? '' : 's'}`
}

export function CleanupModeIcon({ kind, className }: { kind: CleanupKind; className?: string }) {
  if (kind === 'fillers') return <FillerIcon className={className} />
  if (kind === 'gaps') return <GapIcon className={className} />
  return <RetakeIcon className={className} />
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9'\s]/g, '').trim()
}

function seconds(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)} s`
}

/** Words of a candidate, each flagged when no other candidate says it. */
const SPOKEN_MARKERS = ['let me try that again', 'let me redo that', 'let me try again', 'one more time', 'scratch that', 'start over', 'take two', 'take 2', 'sorry', 'again']

/** How many trailing tokens are a spoken correction; they leave with the take rather than being part of it. */
function trailingMarkerCount(tokens: string[]): number {
  let count = 0
  let rest = tokens
  for (;;) {
    const hit = SPOKEN_MARKERS.map((marker) => marker.split(' '))
      .sort((left, right) => right.length - left.length)
      .find((parts) => parts.length <= rest.length && parts.every((part, index) => rest[rest.length - parts.length + index] === part))
    if (!hit) return count
    count += hit.length
    rest = rest.slice(0, rest.length - hit.length)
  }
}

function diffTokens(candidate: RetakeCandidate, others: RetakeCandidate[]): { text: string; differs: boolean; marker: boolean }[] {
  const shared = new Set(others.flatMap((other) => other.transcript.split(/\s+/).map(norm)))
  const tokens = candidate.transcript.split(/\s+/).filter(Boolean)
  const markerFrom = tokens.length - trailingMarkerCount(tokens.map(norm))
  return tokens.map((text, index) => ({ text, differs: !shared.has(norm(text)), marker: index >= markerFrom }))
}

/** The words that follow a candidate up to the sentence end; they stay whichever take is kept. */
function continuation(words: Word[], candidate: RetakeCandidate): string {
  if (/[.!?][”"')\]]*$/.test(candidate.transcript.trim())) return ''
  const lastIndex = words.findIndex((word) => word.id === candidate.wordIds[candidate.wordIds.length - 1])
  if (lastIndex < 0) return ''
  const tail: string[] = []
  for (let index = lastIndex + 1; index < words.length && tail.length < 8; index += 1) {
    const word = words[index]
    if (word.isRemoved) continue
    tail.push(word.text)
    if (/[.!?][”"')\]]*$/.test(word.text.trim())) break
  }
  return tail.join(' ')
}

function shortReason(proposal: CleanupProposal): string {
  return proposal.reason.replace(/; .*$/, '').replace(/^\d+ closely aligned restart attempts.*$/, `${proposal.retakeGroup?.candidates.length ?? 3} attempts in a row`)
}

export default function CleanupReview({ onClose, returnFocus }: {
  onClose: () => void
  returnFocus: (kind: CleanupKind) => void
}) {
  const words = useStore((state) => state.words)
  const rendering = useStore((state) => state.rendering)
  const status = useStore((state) => state.status)
  const audioUrl = useStore((state) => state.audioUrl)
  const waveformReady = useStore((state) => state.waveformReady)
  const gapPacing = useStore((state) => state.gapPacing)
  const retakeSensitivity = useStore((state) => state.retakeSensitivity)
  const setRetakeSensitivity = useStore((state) => state.setRetakeSensitivity)
  const cleanupPreview = useStore((state) => state.cleanupPreview)
  const openCleanupWorkbench = useStore((state) => state.openCleanupWorkbench)
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

  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<string, HTMLElement>())

  const kind = cleanupPreview?.kind ?? 'retakes'
  const mode = modeConfig(kind)
  const proposals = useMemo(() => cleanupPreview?.proposals ?? [], [cleanupPreview])
  const selectedIds = useMemo(() => new Set(cleanupPreview?.selectedProposalIds ?? []), [cleanupPreview])
  const choices = useMemo(() => cleanupPreview?.retakeCandidateChoices ?? {}, [cleanupPreview])
  const canAudition = status === 'ready' && Boolean(audioUrl) && waveformReady && !rendering
  const selectedCount = cleanupPreview ? modeCount(kind, cleanupPreview.selectedSummary) : 0
  const decidedCount = proposals.filter((proposal) => selectedIds.has(proposal.id)).length
  const secondsCut = useMemo(() => proposals.reduce((total, proposal) => {
    if (!selectedIds.has(proposal.id)) return total
    if (proposal.retakeGroup) {
      const keep = choices[proposal.id]
      return total + proposal.retakeGroup.candidates
        .filter((candidate) => candidate.id !== keep)
        .reduce((sum, candidate) => sum + Math.max(0, candidate.endTime - candidate.startTime), 0)
    }
    if (proposal.originalGapMs !== undefined && proposal.targetGapMs !== undefined) {
      return total + Math.max(0, proposal.originalGapMs - proposal.targetGapMs) / 1000
    }
    return total + Math.max(0, proposal.endTime - proposal.startTime)
  }, 0), [proposals, selectedIds, choices])

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true })
  }, [kind])

  useEffect(() => {
    if (!focusedCleanupProposalId) return
    cardRefs.current.get(focusedCleanupProposalId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusedCleanupProposalId])

  if (!cleanupPreview) return null

  const visibleProposals = proposals.filter((proposal) => {
    if (kind === 'retakes') return true
    const selected = selectedIds.has(proposal.id)
    if (cleanupWorkbenchFilter === 'selected') return selected
    if (cleanupWorkbenchFilter === 'high') return proposal.confidence === 'high'
    if (cleanupWorkbenchFilter === 'review') return proposal.confidence !== 'high'
    return true
  })

  const cancel = () => {
    onClose()
    returnFocus(kind)
  }

  const apply = () => {
    applyCleanup()
    returnFocus(kind)
  }

  const toggleSelected = (proposal: CleanupProposal, selected: boolean) => {
    const next = new Set(selectedIds)
    if (selected) next.add(proposal.id)
    else next.delete(proposal.id)
    setCleanupSelection([...next])
  }

  const applyLabel = selectedCount === 0
    ? 'Apply'
    : kind === 'retakes'
    ? `Apply ${decidedCount} retake${decidedCount === 1 ? '' : 's'}`
    : kind === 'gaps'
      ? `Shorten ${selectedCount} ${countNoun('gaps', selectedCount)}`
      : `Remove ${selectedCount} ${countNoun('fillers', selectedCount)}`

  const emptyState = () => {
    if (kind === 'gaps' && cleanupPreview.gapDiagnostics) {
      return <p>{describeEmptyGapReview(cleanupPreview.gapDiagnostics, gapPacing.detectionThresholdMs)}</p>
    }
    if (kind === 'retakes') {
      return retakeSensitivity === 'strict'
        ? (
          <>
            <p>No repeated attempts met the strict rules. Balanced also looks for restarts longer than five words and takes separated by a spoken correction.</p>
            <button type="button" className="review-link" onClick={() => setRetakeSensitivity('balanced')}>Try Balanced →</button>
          </>
        )
        : (
          <>
            <p>{mode.emptyCopy}</p>
            <p className="review-hint">You can still select any words and choose “Remove selection as retake” from the menu.</p>
          </>
        )
    }
    return <p>{mode.emptyCopy}</p>
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      className="cleanup-review"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        }
      }}
    >
      <div className="review-head">
        <span className={`review-icon ${mode.iconClass}`}><CleanupModeIcon kind={kind} className="h-4 w-4" /></span>
        <div>
          <h2 id={titleId}>{mode.dialogTitle}</h2>
          <p id={descriptionId}>{mode.previewCopy}</p>
        </div>
      </div>

      <div role="tablist" aria-label="Cleanup kinds" className="review-tabs">
        {CLEANUP_MODES.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            role="tab"
            aria-selected={kind === tab.kind}
            onClick={() => openCleanupWorkbench(tab.kind)}
          >
            {tab.kind === 'fillers' ? 'Fillers' : tab.kind === 'gaps' ? 'Pauses' : 'Retakes'}
          </button>
        ))}
      </div>

      <div className="review-summary">
        <span>
          {kind === 'retakes'
            ? <><b>{proposals.length} group{proposals.length === 1 ? '' : 's'}</b> found · {decidedCount} decided</>
            : <><b>{proposals.length} suggestion{proposals.length === 1 ? '' : 's'}</b> · {decidedCount} selected</>}
        </span>
        {kind === 'retakes' ? (
          <div className="review-seg" role="group" aria-label="Retake detection sensitivity">
            {(['balanced', 'strict'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={retakeSensitivity === value}
                onClick={() => setRetakeSensitivity(value)}
                title={value === 'balanced'
                  ? 'Also finds long restarts and takes separated by a spoken correction'
                  : 'Only the narrowest restart shapes'}
              >
                {value === 'balanced' ? 'Balanced' : 'Strict'}
              </button>
            ))}
          </div>
        ) : (
          <div className="review-seg" role="group" aria-label="Cleanup suggestion filter">
            {([['all', 'All'], ['high', 'High'], ['review', 'Review'], ['selected', 'Selected']] as const).map(([filter, label]) => (
              <button key={filter} type="button" aria-pressed={cleanupWorkbenchFilter === filter} onClick={() => setCleanupWorkbenchFilter(filter)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {proposals.length === 0 && <div className="review-empty">{emptyState()}</div>}

      {proposals.length > 0 && (
        <div className="review-list" role="group" aria-label="Cleanup suggestions">
          {!visibleProposals.length && <p className="review-hint">No suggestions match this filter.</p>}
          {visibleProposals.map((proposal) => {
            const selected = selectedIds.has(proposal.id)
            const focused = focusedCleanupProposalId === proposal.id
            const group = proposal.retakeGroup
            const choice = group ? choices[proposal.id] : undefined
            const timecode = (
              <button
                type="button"
                className="review-tc"
                onClick={() => focusCleanupProposal(proposal.id)}
                title="Move the playhead here"
              >
                {fmtTime(proposal.startTime)}
              </button>
            )

            if (group) {
              const recommended = group.candidates.find((candidate) => candidate.id === group.recommendedCandidateId)
              return (
                <div
                  key={proposal.id}
                  ref={(element) => { if (element) cardRefs.current.set(proposal.id, element); else cardRefs.current.delete(proposal.id) }}
                  className={`review-card${focused ? ' is-focused' : ''}${choice ? ' is-decided' : ''}`}
                >
                  <div className="review-card-head">
                    {timecode}
                    <span>{shortReason(proposal)}</span>
                    <span className={`review-state${choice ? '' : ' is-open'}`}>{choice ? 'Decided' : 'Choose'}</span>
                  </div>
                  <div role="radiogroup" aria-label={`Take to keep at ${fmtTime(proposal.startTime)}`}>
                    {group.candidates.map((candidate, candidateIndex) => {
                      const chosen = choice === candidate.id
                      const isRecommended = candidate.id === group.recommendedCandidateId
                      const tokens = diffTokens(candidate, group.candidates.filter((other) => other.id !== candidate.id))
                      // Only the final take can be a partial restart whose
                      // sentence carries on; an earlier take is followed by
                      // the next attempt, which is not a continuation.
                      const tail = candidateIndex === group.candidates.length - 1 ? continuation(words, candidate) : ''
                      return (
                        <div key={candidate.id} className={`review-take${chosen ? ' is-chosen' : ''}`}>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={chosen}
                            aria-label={`Keep ${candidate.label}`}
                            className="review-radio"
                            onClick={() => selectRetakeCandidate(proposal.id, candidate.id)}
                          />
                          <div className="review-take-body">
                            <div className="review-take-label">
                              <span>{candidate.label} · {candidate.wordIds.length} word{candidate.wordIds.length === 1 ? '' : 's'}</span>
                              {isRecommended && <span className="review-rec">Recommended</span>}
                            </div>
                            <p className="review-take-text">
                              {tokens.map((token, index) => (
                                <span key={index} className={token.marker ? 'review-tail' : token.differs ? 'is-diff' : undefined}>{token.text}{index < tokens.length - 1 ? ' ' : ''}</span>
                              ))}
                              {tail && <span className="review-tail"> + {tail}</span>}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="review-play"
                            disabled={!canAudition}
                            onClick={() => auditionRetakeCandidate(proposal.id, candidate.id)}
                            aria-label={`Play ${candidate.label}`}
                            title={canAudition ? `Play ${candidate.label}` : 'Wait for the audio preview to load'}
                          >
                            <PlayIcon className="h-3 w-3" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  <p className="review-why">{group.recommendationReason}</p>
                  <div className="review-actions">
                    {choice ? (
                      <>
                        <button type="button" className="review-btn" disabled={!canAudition} onClick={() => auditionCleanupProposal(proposal.id)}>
                          <PlayIcon className="h-3 w-3" /> Hear the cut
                        </button>
                        <button type="button" className="review-btn is-ghost" onClick={() => toggleSelected(proposal, false)}>Undecide</button>
                      </>
                    ) : (
                      <>
                        {recommended && (
                          <button type="button" className="review-btn is-primary" onClick={() => selectRetakeCandidate(proposal.id, recommended.id)}>
                            Keep {recommended.label}
                          </button>
                        )}
                        {group.candidates.filter((candidate) => candidate.id !== recommended?.id).map((candidate) => (
                          <button key={candidate.id} type="button" className="review-btn" onClick={() => selectRetakeCandidate(proposal.id, candidate.id)}>
                            Keep {candidate.label}
                          </button>
                        ))}
                      </>
                    )}
                    <button type="button" className="review-btn is-ghost" onClick={() => ignoreCleanupProposal(proposal.id)} title="Keep every take and stop suggesting this group">
                      Not a retake
                    </button>
                  </div>
                </div>
              )
            }

            const confidenceLabel = proposal.confidence === 'high' ? 'Likely' : proposal.confidence === 'medium' ? 'Review' : 'Maybe'
            return (
              <div
                key={proposal.id}
                ref={(element) => { if (element) cardRefs.current.set(proposal.id, element); else cardRefs.current.delete(proposal.id) }}
                className={`review-card${focused ? ' is-focused' : ''}${selected ? ' is-decided' : ''}`}
              >
                <div className="review-card-head">
                  {timecode}
                  <span>{shortReason(proposal)}</span>
                  <span className={`review-conf is-${proposal.confidence}`}>{confidenceLabel}</span>
                </div>
                <label className="review-row">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(event) => toggleSelected(proposal, event.target.checked)}
                    aria-label={`Select suggestion at ${fmtTime(proposal.startTime)}`}
                  />
                  <span className="review-context">
                    “{proposal.context}”
                    {proposal.originalGapMs !== undefined && proposal.targetGapMs !== undefined && (
                      <span className="review-tail"> · {(proposal.originalGapMs / 1000).toFixed(1)} s → {proposal.targetGapMs} ms</span>
                    )}
                  </span>
                </label>
                <div className="review-actions">
                  <button type="button" className="review-btn" disabled={!canAudition} onClick={() => auditionCleanupProposal(proposal.id)}>
                    <PlayIcon className="h-3 w-3" /> Hear the cut
                  </button>
                  <button type="button" className="review-btn is-ghost" onClick={() => ignoreCleanupProposal(proposal.id)} title="Keep this and stop suggesting it">
                    Keep as is
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="review-apply">
        <span>
          {proposals.length === 0 ? 'Nothing to apply' : kind === 'retakes'
            ? <><b>{decidedCount} of {proposals.length}</b> decided</>
            : <><b>{decidedCount} of {proposals.length}</b> selected</>}
          {selectedCount > 0 && <> · removes {selectedCount} {countNoun(kind === 'gaps' ? 'gaps' : 'retakes', selectedCount)}{secondsCut > 0.05 ? ` · ${seconds(secondsCut)}` : ''}</>}
        </span>
        {kind !== 'retakes' && proposals.length > 0 && (
          <button type="button" className="review-btn is-ghost" onClick={selectHighConfidenceCleanup} title="Select only the likely suggestions">Likely only</button>
        )}
        <button type="button" className="review-btn is-ghost" onClick={cancel}>{proposals.length ? 'Cancel' : 'Close'}</button>
        {proposals.length > 0 && (
          <button type="button" className={`review-btn is-apply ${mode.applyClass}`} disabled={selectedCount === 0} onClick={apply}>
            {applyLabel}
          </button>
        )}
      </div>
    </div>
  )
}
