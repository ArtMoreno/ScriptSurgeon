import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../store'
import type { GapPacing, GapPreset } from '../types'
import { GAP_PRESETS, normalizeGapPacing, pacingForPreset } from '../lib/gapPacing'

export default function GapPacingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const gapPacing = useStore((state) => state.gapPacing)
  const setGapPacing = useStore((state) => state.setGapPacing)
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<GapPacing>(gapPacing)

  // Reseed the draft as the dialog opens. React prefers this adjustment during
  // render to the same work in an effect, which renders once with stale values
  // and then immediately again. Reseeding only on open also means committing a
  // pacing change can no longer overwrite what is being typed.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setDraft(gapPacing)
  }

  useEffect(() => {
    if (!open) return
    window.setTimeout(() => dialogRef.current?.focus({ preventScroll: true }), 0)
  }, [open])

  if (!open) return null

  const updateNumber = (key: 'detectionThresholdMs' | 'targetGapMs', value: string) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return
    setDraft((current) => normalizeGapPacing({ ...current, preset: 'custom', [key]: Math.round(number) }))
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
      className="absolute right-3 top-[calc(100%+8px)] z-[60] w-[440px] max-w-[calc(100vw-24px)] rounded-2xl border border-line-strong bg-canvas-raised p-4 shadow-2xl shadow-ink/15 outline-none focus-visible:ring-2 focus-visible:ring-forest"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-sm font-semibold text-ink">Pacing and gap editor</h2>
          <p id={descriptionId} className="mt-1 text-[12px] leading-5 text-ink-muted">
            These values control new Cleanup suggestions and direct timeline actions. Existing shortened pauses keep their exact chosen duration. Keyboard and waveform shortening also preserve sentence breaks, speaker changes, slow delivery, and pauses you kept.
          </p>
        </div>
        <button type="button" onClick={onClose} className="h-8 px-2 rounded-lg text-[12px] text-ink-muted hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest">
          Close
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2" role="group" aria-label="Pacing presets">
        {(Object.keys(GAP_PRESETS) as GapPreset[]).filter((preset) => preset !== 'custom').map((preset) => {
          const selected = draft.preset === preset
          return (
            <button
              key={preset}
              type="button"
              onClick={() => setDraft(pacingForPreset(preset))}
              className={`rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest ${selected ? 'border-forest/45 bg-forest-soft text-forest-dark' : 'border-line hover:bg-canvas-soft text-ink'}`}
            >
              <span className="block text-[12px] font-semibold">{GAP_PRESETS[preset].label}</span>
              <span className="mt-0.5 block text-[10px] text-ink-muted">{GAP_PRESETS[preset].detectionThresholdMs} ms detect · {GAP_PRESETS[preset].targetGapMs} ms keep</span>
            </button>
          )
        })}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="block text-[11px] font-medium text-ink-muted">
          Detect pauses at or over (ms)
          <input
            type="number"
            min="200"
            max="5000"
            step="10"
            value={draft.detectionThresholdMs}
            onChange={(event) => updateNumber('detectionThresholdMs', event.target.value)}
            className="mt-1 block h-9 w-full rounded-lg border border-line bg-canvas px-2.5 text-[13px] text-ink outline-none focus:border-forest focus:ring-2 focus:ring-forest/25"
          />
        </label>
        <label className="block text-[11px] font-medium text-ink-muted">
          Keep room tone (ms)
          <input
            type="number"
            min="50"
            max="2000"
            step="10"
            value={draft.targetGapMs}
            onChange={(event) => updateNumber('targetGapMs', event.target.value)}
            className="mt-1 block h-9 w-full rounded-lg border border-line bg-canvas px-2.5 text-[13px] text-ink outline-none focus:border-forest focus:ring-2 focus:ring-forest/25"
          />
        </label>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-ink-muted">Allowed range: 200–5000 ms detection and 50–2000 ms retained room tone. The target is always kept shorter than the detection threshold.</p>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 px-3 rounded-lg text-[12px] font-medium text-ink-muted hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => { setGapPacing(normalizeGapPacing(draft)); onClose() }}
          className="h-9 px-4 rounded-lg bg-forest-dark hover:bg-forest text-[12px] font-semibold text-ink-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-forest"
        >
          Use this pacing
        </button>
      </div>
    </div>
  )
}
