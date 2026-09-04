import { useEffect, useId, useRef } from 'react'
import { CloseIcon } from './Icons'

interface Shortcut {
  keys: string[]
  description: string
}

interface ShortcutGroup {
  title: string
  items: Shortcut[]
}

// Kept deliberately close to the handlers in TranscriptEditor and WaveformPanel.
// A shortcut listed here that no longer works is worse than one left undocumented.
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Playback',
    items: [
      { keys: ['Space'], description: 'Play or pause' },
      { keys: ['Enter'], description: 'Play from the focused word' },
      { keys: ['Alt', 'click'], description: 'Play from a word without moving the selection' },
      { keys: ['←'], description: 'Back 5 seconds (transport button)' },
      { keys: ['→'], description: 'Forward 5 seconds (transport button)' },
    ],
  },
  {
    title: 'Editing',
    items: [
      { keys: ['Backspace'], description: 'Ripple-cut the selected words' },
      { keys: ['Delete'], description: 'Ripple-cut the selected words' },
      { keys: ['Enter'], description: 'Restore a removed word' },
      { keys: ['F2'], description: 'Correct the focused word or insert' },
      { keys: ['double-click'], description: 'Correct a word' },
      { keys: ['G'], description: 'Shorten the eligible pause at the playhead' },
      { keys: ['Ctrl', 'Z'], description: 'Undo the last edit' },
    ],
  },
  {
    title: 'Moving around',
    items: [
      { keys: ['←'], description: 'Focus the previous word' },
      { keys: ['→'], description: 'Focus the next word' },
      { keys: ['Shift', 'F10'], description: 'Open the actions menu for the focused item' },
      { keys: ['Menu'], description: 'Open the actions menu for the focused item' },
      { keys: ['Esc'], description: 'Clear the waveform selection' },
      { keys: ['drag'], description: 'Select a range directly on the waveform' },
    ],
  },
  {
    title: 'Search',
    items: [
      { keys: ['Ctrl', 'F'], description: 'Find in the transcript' },
      { keys: ['Enter'], description: 'Jump to the next match' },
      { keys: ['Shift', 'Enter'], description: 'Jump to the previous match' },
      { keys: ['Esc'], description: 'Close the search bar' },
    ],
  },
  {
    title: 'This window',
    items: [
      { keys: ['?'], description: 'Open or close this list' },
      { keys: ['Esc'], description: 'Close this list' },
    ],
  },
]

function Key({ label }: { label: string }) {
  const isChord = /^[A-Za-z0-9?←→↑↓]$|^(Space|Enter|Esc|Alt|Ctrl|Shift|F2|F10|Menu|Backspace|Delete)$/.test(label)
  if (!isChord) {
    return <span className="text-[11px] italic text-ink-muted">{label}</span>
  }
  return (
    <kbd className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-md border border-line-strong bg-canvas-soft px-1.5 font-mono text-[11px] font-medium text-ink shadow-sm shadow-line/30">
      {label}
    </kbd>
  )
}

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/25 backdrop-blur-[2px] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
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
        className="w-[min(760px,100%)] max-h-[min(640px,calc(100vh-32px))] overflow-y-auto rounded-2xl border border-line-strong bg-canvas-raised shadow-2xl shadow-ink/20 outline-none focus-visible:ring-2 focus-visible:ring-ember"
      >
        <div className="sticky top-0 flex items-center gap-3 border-b border-line bg-canvas-raised/95 backdrop-blur px-5 py-4">
          <h2 id={titleId} className="text-sm font-semibold text-ink">Keyboard shortcuts</h2>
          <span className="text-[11px] text-ink-muted hidden sm:inline">
            Shortcuts are ignored while you are typing a correction
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-7 w-7 grid place-items-center rounded-lg text-ink-muted hover:bg-canvas-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            aria-label="Close keyboard shortcuts"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="grid gap-x-8 gap-y-6 p-5 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                {group.title}
              </h3>
              <dl className="mt-2.5 space-y-1.5">
                {group.items.map((item) => (
                  <div key={`${group.title}-${item.keys.join('+')}-${item.description}`} className="flex items-baseline gap-3">
                    <dt className="flex shrink-0 items-center gap-1">
                      {item.keys.map((key, index) => (
                        <span key={key} className="inline-flex items-center gap-1">
                          {index > 0 && <span className="text-[10px] text-ink-faint">+</span>}
                          <Key label={key} />
                        </span>
                      ))}
                    </dt>
                    <dd className="text-[12px] leading-5 text-ink-muted">{item.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
