import { useId, useRef, useState } from 'react'
import { useStore } from '../store'
import type { CleanupKind } from '../lib/cleanup'
import type { NoiseLevel } from '../types'
import GapPacingDialog from './GapPacingDialog'
import MarkerPanel from './MarkerPanel'
import CleanupReview, { CleanupModeIcon, modeConfig, modeCount, countNoun } from './CleanupReview'
import {
  CheckIcon,
  GapIcon,
  LevelsIcon,
  NoiseIcon,
  RevertIcon,
  SparklesIcon,
} from './Icons'

const NOISE_OPTIONS: { value: NoiseLevel; label: string; hint: string }[] = [
  { value: 'off', label: 'No noise cleanup', hint: 'Leave background noise untouched' },
  { value: 'light', label: 'Light', hint: 'Gentle hiss reduction; safest for quiet rooms' },
  { value: 'medium', label: 'Medium', hint: 'Removes steady hum, fans, and air conditioning' },
  { value: 'strong', label: 'Strong', hint: 'Most aggressive; can thin the voice on noisy takes' },
]

const CLEANUP_TOOLS: { kind: CleanupKind; title: string; hint: string }[] = [
  { kind: 'retakes', title: 'Remove retakes', hint: 'Compare repeated attempts and keep one' },
  { kind: 'fillers', title: 'Remove filler words', hint: 'Um, uh, you know, in context' },
  { kind: 'gaps', title: 'Shorten pauses', hint: 'Tighten long silences' },
]

function appliedTitle(kind: CleanupKind): string {
  if (kind === 'fillers') return 'Fillers removed'
  if (kind === 'gaps') return 'Pauses shortened'
  return 'Retakes applied'
}

function appliedDetail(kind: CleanupKind, count: number): string {
  const verb = kind === 'gaps' ? 'shortened' : 'removed'
  return `${count} ${countNoun(kind, count)} ${verb}. Undo is available.`
}

export default function TopBar({
  panel,
  onClosePanel,
}: {
  panel: string | null
  onClosePanel: () => void
}) {
  const status = useStore((state) => state.status)
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
  const lastCleanup = useStore((state) => state.lastCleanup)
  const revertToOriginal = useStore((state) => state.revertToOriginal)
  const hasEdits = useStore((state) => state.hasEdits)
  const gapPacing = useStore((state) => state.gapPacing)
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [showPacing, setShowPacing] = useState(false)
  const noiseId = useId()
  const noiseHintId = useId()
  const cleanupButtonRefs = useRef<Partial<Record<CleanupKind, HTMLButtonElement | null>>>({})
  const ready = status === 'ready'
  const selectedNoise = NOISE_OPTIONS.find((option) => option.value === noiseReduction) ?? NOISE_OPTIONS[0]
  const reviewOpen = panel === 'Cleanup' && cleanupWorkbenchOpen && Boolean(cleanupPreview)
  const lastCleanupMode = lastCleanup ? modeConfig(lastCleanup.kind) : null
  const lastCleanupCount = lastCleanup ? modeCount(lastCleanup.kind, lastCleanup.summary) : 0

  const returnCleanupFocus = (kind: CleanupKind) => {
    window.setTimeout(() => cleanupButtonRefs.current[kind]?.focus({ preventScroll: true }), 0)
  }

  return (
    <aside className={`workspace-inspector inspector-${panel ?? 'closed'}`} aria-label="Editing tools" hidden={!panel || panel === 'Project' || panel === 'Settings'}>
      <h2>{panel}</h2>
      {!reviewOpen && (
        <div className="inspector-controls">
          {panel === 'Cleanup' && (
            <div className="cleanup-tools">
              {CLEANUP_TOOLS.map((tool) => (
                <button
                  key={tool.kind}
                  type="button"
                  ref={(element) => { cleanupButtonRefs.current[tool.kind] = element }}
                  disabled={!ready}
                  onClick={() => openCleanupWorkbench(tool.kind)}
                >
                  <CleanupModeIcon kind={tool.kind} />
                  <span><strong>{tool.title}</strong><small>{tool.hint}</small><em>Review</em></span>
                </button>
              ))}
            </div>
          )}
          {(panel === 'Cleanup' || panel === 'Properties') && (
            <div className="audio-properties">
              <h3>Audio</h3>
              <button type="button" disabled={!ready} onClick={toggleStudio} aria-pressed={studioSound}>
                <SparklesIcon /><span>Studio Sound<small>EQ, de-essing and compression</small></span><span className="state-label">{studioSound ? 'On' : 'Off'}</span>
              </button>
              <label>
                <NoiseIcon /><span>Noise reduction</span>
                <select id={noiseId} className="app-select" value={noiseReduction} disabled={!ready} onChange={(event) => setNoiseReduction(event.target.value as NoiseLevel)} aria-describedby={noiseHintId}>
                  {NOISE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.value === 'off' ? 'Off' : option.label}</option>)}
                </select>
              </label>
              <small id={noiseHintId}>{selectedNoise.hint}</small>
              <button type="button" disabled={!ready} onClick={() => toggleNormalize()} aria-pressed={normalizeLoudness}>
                <LevelsIcon /><span>Normalize audio<small>Even out loudness</small></span><span className="state-label">{normalizeLoudness ? 'On' : 'Off'}</span>
              </button>
              <button type="button" disabled={!ready} onClick={() => setShowPacing(!showPacing)} aria-expanded={showPacing}>
                <GapIcon /><span>Pacing settings<small>Retain {gapPacing.targetGapMs} ms of each shortened pause</small></span>
              </button>
            </div>
          )}
          {panel === 'Properties' && (
            <div className="revert-block">
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
                <span>Revert all edits</span>
              </button>
              {confirmRevert && (
                <div role="dialog" aria-label="Confirm revert to original" className="revert-confirm">
                  <p>
                    Restore every removed word, undo all shortened pauses, and take recorded inserts
                    back out of the timeline. Studio sound, noise cleanup, and normalize are left as they are.
                    This is undoable.
                  </p>
                  <div className="review-actions">
                    <button type="button" className="review-btn is-ghost" onClick={() => setConfirmRevert(false)}>Cancel</button>
                    <button type="button" className="review-btn is-danger" onClick={() => { revertToOriginal(); setConfirmRevert(false) }}>Revert all edits</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <GapPacingDialog open={showPacing} onClose={() => setShowPacing(false)} />
      <MarkerPanel open={panel === 'Chapters'} onClose={() => { if (panel === 'Chapters') onClosePanel() }} />

      {reviewOpen && <CleanupReview onClose={closeCleanupWorkbench} returnFocus={returnCleanupFocus} />}

      {lastCleanup && lastCleanupMode && !reviewOpen && (
        <div role="status" className="cleanup-applied">
          <span className="cleanup-applied-icon"><CheckIcon className="h-4 w-4" /></span>
          <div>
            <div className="cleanup-applied-title">{appliedTitle(lastCleanup.kind)}</div>
            <div className="cleanup-applied-detail">{appliedDetail(lastCleanup.kind, lastCleanupCount)}</div>
            {lastCleanup.kind === 'retakes' && (
              <button type="button" disabled={!ready} onClick={() => openCleanupWorkbench('retakes')} className="review-link">Review remaining retakes</button>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
