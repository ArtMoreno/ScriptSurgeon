import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import TranscriptEditor from './components/TranscriptEditor'
import WaveformPanel from './components/WaveformPanel'
import RecordingDialog from './components/RecordingDialog'
import ShortcutsDialog from './components/ShortcutsDialog'
import { useStore } from './store'
import { useIntegrations } from './lib/integrations'
import { buildTimeline, editedTimeToSource, wordAtEditedTime } from './lib/timeline'
import { gapTargetsFromEdits } from './lib/gapPacing'
import { PRODUCT_NAME } from './lib/branding'
import {
  LEGACY_TIMELINE_COLLAPSED_KEY,
  LAST_OPEN_TIMELINE_SIZE_KEY,
  resolveOpenTimelineSize,
  resolveTimelineSize,
  resolveWorkspaceTheme,
  TIMELINE_SIZE_KEY,
  WORKSPACE_THEME_KEY,
  type TimelineSize,
  type WorkspaceTheme,
} from './lib/workspacePreferences'
import type { InsertClip } from './types'
import { AudioIcon, CheckIcon, CloseIcon, ScissorsIcon, SparklesIcon, UploadIcon } from './components/Icons'

type RecordingTarget =
  | { mode: 'create'; afterWordId: string | null; sourceTime: number; anchorLabel: string }
  | { mode: 'replace'; clip: InsertClip }
  | { mode: 'project'; returnProjectId: string | null }

export default function App() {
  const projectId = useStore((state) => state.projectId)
  const projectName = useStore((state) => state.projectName)
  const status = useStore((state) => state.status)
  const operationError = useStore((state) => state.operationError)
  const clearOperationError = useStore((state) => state.clearOperationError)
  const closeProject = useStore((state) => state.closeProject)
  const uploadFile = useStore((state) => state.uploadFile)
  const createRecordedProject = useStore((state) => state.createRecordedProject)
  const recordingBusy = useStore((state) => state.recordingBusy)
  const addRecording = useStore((state) => state.addRecording)
  const replaceRecording = useStore((state) => state.replaceRecording)
  const [zoom, setZoom] = useState(50)
  const [theme, setTheme] = useState<WorkspaceTheme>(() => {
    try {
      return resolveWorkspaceTheme(window.localStorage.getItem(WORKSPACE_THEME_KEY))
    } catch {
      return 'dark'
    }
  })
  const [timelineSize, setTimelineSize] = useState<TimelineSize>(() => {
    try {
      return resolveTimelineSize(
        window.localStorage.getItem(TIMELINE_SIZE_KEY),
        window.localStorage.getItem(LEGACY_TIMELINE_COLLAPSED_KEY),
      )
    } catch {
      return 'compact'
    }
  })
  const [lastOpenTimelineSize, setLastOpenTimelineSize] = useState<Exclude<TimelineSize, 'minimized'>>(() => {
    try {
      const currentSize = resolveTimelineSize(
        window.localStorage.getItem(TIMELINE_SIZE_KEY),
        window.localStorage.getItem(LEGACY_TIMELINE_COLLAPSED_KEY),
      )
      return currentSize === 'minimized'
        ? resolveOpenTimelineSize(window.localStorage.getItem(LAST_OPEN_TIMELINE_SIZE_KEY), currentSize)
        : currentSize
    } catch {
      return 'compact'
    }
  })
  const [recordingTarget, setRecordingTarget] = useState<RecordingTarget | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const shortcutsReturnFocus = useRef<HTMLElement | null>(null)
  const welcomeInput = useRef<HTMLInputElement>(null)
  const recordingReturnFocus = useRef<HTMLElement | null>(null)
  const projectCreationSaving = useRef(false)
  const focusCreatedProject = useRef(false)
  const projectHeadingRef = useRef<HTMLHeadingElement>(null)
  const workspaceOpen = Boolean(projectId) || status === 'uploading' || status === 'loading' || status === 'error' || status === 'cancelled'

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
    try { window.localStorage.setItem(WORKSPACE_THEME_KEY, theme) } catch { /* A locked-down WebView can still render safely. */ }
  }, [theme])

  const loadIntegrations = useIntegrations((state) => state.load)

  // The served target list is what the export picker renders, so it is fetched
  // once at startup.
  useEffect(() => {
    void loadIntegrations()
  }, [loadIntegrations])

  useEffect(() => {
    const flushIfNeeded = () => {
      const state = useStore.getState()
      if (state.dirty) void state.flushSave().catch(() => undefined)
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!useStore.getState().dirty && !window.__scriptcutUnsavedRecording) return
      flushIfNeeded()
      event.preventDefault()
      event.returnValue = ''
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') flushIfNeeded()
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return
      // Never steal "?" from a correction field or any other text entry.
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      setShortcutsOpen((open) => {
        if (open) return false
        shortcutsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        return true
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (recordingTarget?.mode === 'project' && projectCreationSaving.current) return
    setRecordingTarget(null)
    recordingReturnFocus.current = null
  }, [projectId])

  const updateTimelineSize = (next: TimelineSize) => {
    setTimelineSize(next)
    if (next !== 'minimized') setLastOpenTimelineSize(next)
    try {
      window.localStorage.setItem(TIMELINE_SIZE_KEY, next)
      if (next !== 'minimized') window.localStorage.setItem(LAST_OPEN_TIMELINE_SIZE_KEY, next)
    } catch { /* Preference storage can be unavailable. */ }
  }

  const toggleTheme = () => setTheme((current) => current === 'dark' ? 'light' : 'dark')

  const closeShortcuts = () => {
    setShortcutsOpen(false)
    const trigger = shortcutsReturnFocus.current
    shortcutsReturnFocus.current = null
    window.setTimeout(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }, 0)
  }

  const openShortcuts = (trigger?: HTMLElement | null) => {
    shortcutsReturnFocus.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setShortcutsOpen(true)
  }

  const rememberRecordingTrigger = (trigger?: HTMLElement | null) => {
    recordingReturnFocus.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  }

  const openRecording = (trigger?: HTMLElement | null, afterWordId?: string) => {
    const state = useStore.getState()
    if (state.status !== 'ready' || state.recordingBusy) return
    rememberRecordingTrigger(trigger)
    const shortened = new Set(state.shortenedGapIds)
    const gapTargets = gapTargetsFromEdits(state.gapEdits)
    const explicitWord = afterWordId ? state.words.find((word) => word.id === afterWordId && !word.isRemoved) : null
    const selected = state.selFocus === null ? null : state.words[state.selFocus]
    const playheadWord = explicitWord ?? (selected && !selected.isRemoved
      ? selected
      : wordAtEditedTime(state.words, shortened, state.playTime, state.sourceDuration, state.insertClips, gapTargets)
    )
    const model = buildTimeline(state.words, shortened, state.sourceDuration, state.insertClips, gapTargets)
    const sourceTime = playheadWord?.endTime ?? editedTimeToSource(model, state.playTime)
    setRecordingTarget({
      mode: 'create',
      afterWordId: playheadWord?.id ?? null,
      sourceTime,
      anchorLabel: playheadWord
        ? `after "${playheadWord.text}"`
        : state.playTime > 0
          ? 'at the playhead'
          : 'at the beginning',
    })
  }

  const openReplacement = (clip: InsertClip, trigger?: HTMLElement | null) => {
    if (useStore.getState().recordingBusy) return
    rememberRecordingTrigger(trigger)
    setRecordingTarget({ mode: 'replace', clip })
  }

  const openProjectRecording = (trigger?: HTMLElement | null) => {
    const state = useStore.getState()
    if (state.recordingBusy || state.status === 'uploading' || state.status === 'loading' || state.status === 'transcribing') return
    rememberRecordingTrigger(trigger)
    focusCreatedProject.current = false
    setRecordingTarget({ mode: 'project', returnProjectId: state.projectId })
  }

  const closeRecording = () => {
    const target = recordingTarget
    setRecordingTarget(null)
    const trigger = recordingReturnFocus.current
    recordingReturnFocus.current = null
    projectCreationSaving.current = false
    const created = focusCreatedProject.current
    focusCreatedProject.current = false

    const focusDestination = () => window.setTimeout(() => {
      if (created) {
        projectHeadingRef.current?.focus({ preventScroll: true })
        return
      }
      if (trigger?.isConnected) {
        trigger.focus({ preventScroll: true })
        return
      }
      const fallback = document.querySelector<HTMLElement>('[data-record-new-project]:not(:disabled)')
      if (fallback) fallback.focus({ preventScroll: true })
      else projectHeadingRef.current?.focus({ preventScroll: true })
    }, 0)

    const state = useStore.getState()
    const failedProjectCreation = target?.mode === 'project' && state.status === 'error' && !state.projectId
    if (!failedProjectCreation) {
      focusDestination()
      return
    }

    const restore = target.returnProjectId
      ? state.openProject(target.returnProjectId)
      : state.closeProject()
    // A failed restore/open must not escape as an unhandled browser rejection
    // while focus is returned to the editor. The called store actions surface
    // their own actionable error state.
    void restore.catch(() => undefined).finally(focusDestination)
  }

  return (
    <div className="h-full flex bg-canvas text-ink overflow-hidden">
      <Sidebar onRecordNewProject={openProjectRecording} theme={theme} onToggleTheme={toggleTheme} />
      <main className="flex-1 flex flex-col min-w-0 relative">
        {operationError && (
          <div role="alert" className="shrink-0 min-h-10 px-4 py-2 bg-danger-soft border-b border-danger/25 text-danger-dark flex items-center gap-3 text-[12px] relative z-50">
            <span className="h-2 w-2 shrink-0 rounded-full bg-danger" />
            <span className="flex-1 min-w-0">{operationError}</span>
            <button
              type="button"
              onClick={clearOperationError}
              className="h-7 w-7 shrink-0 grid place-items-center rounded-md text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
              aria-label="Dismiss error"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {workspaceOpen ? (
          <>
            <header className="h-12 shrink-0 px-4 border-b border-line bg-canvas-raised flex items-center gap-3">
              <button
                type="button"
                onClick={() => void closeProject().catch(() => undefined)}
                className="h-7 w-7 grid place-items-center rounded-lg text-ink-muted hover:bg-canvas-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                aria-label="Close project"
                title="Back to projects"
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
              <div className="min-w-0 flex-1">
                <h1
                  ref={projectHeadingRef}
                  tabIndex={-1}
                  className="truncate rounded-sm text-[13px] font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-ember"
                >
                  {projectName || 'New local project'}
                </h1>
              </div>
              <button
                type="button"
                onClick={(event) => openShortcuts(event.currentTarget)}
                className="h-7 w-7 grid place-items-center rounded-lg border border-line text-ink-muted hover:bg-canvas-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts (?)"
              >
                <span aria-hidden="true" className="text-[12px] font-semibold leading-none">?</span>
              </button>
              <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-canvas-raised px-2.5 py-1 text-[10px] text-ink-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-forest" />
                Local-only workspace
              </span>
            </header>
            {projectId && <TopBar onRecordInsert={() => openRecording()} />}
            <TranscriptEditor onRecordInsert={openRecording} onReplaceInsert={openReplacement} />
            {projectId && (
              <WaveformPanel
                zoom={zoom}
                setZoom={setZoom}
                timelineSize={timelineSize}
                onTimelineSizeChange={updateTimelineSize}
                onShowTimeline={() => updateTimelineSize(lastOpenTimelineSize)}
                theme={theme}
              />
            )}
          </>
        ) : (
          <WelcomeScreen
            inputRef={welcomeInput}
            onFile={(file) => void uploadFile(file).catch(() => undefined)}
            onRecordNewProject={openProjectRecording}
          />
        )}
      </main>
      {shortcutsOpen && <ShortcutsDialog onClose={closeShortcuts} />}
      {recordingTarget?.mode === 'project' ? (
        <RecordingDialog
          mode="project"
          busy={status === 'uploading'}
          onClose={closeRecording}
          onSaveProject={async (file, name) => {
            projectCreationSaving.current = true
            try {
              await createRecordedProject(file, name)
              focusCreatedProject.current = true
            } catch (error) {
              projectCreationSaving.current = false
              throw error
            }
          }}
        />
      ) : recordingTarget ? (
        <RecordingDialog
          mode={recordingTarget.mode}
          anchorLabel={recordingTarget.mode === 'create' ? recordingTarget.anchorLabel : undefined}
          initialText={recordingTarget.mode === 'replace' ? recordingTarget.clip.text : ''}
          busy={recordingBusy}
          onClose={closeRecording}
          onSave={async (file, text) => {
            if (recordingTarget.mode === 'create') {
              await addRecording(file, text, recordingTarget.afterWordId, recordingTarget.sourceTime)
              return
            }
            await replaceRecording(recordingTarget.clip.id, file, text)
          }}
        />
      ) : null}
    </div>
  )
}

function WelcomeScreen({
  inputRef,
  onFile,
  onRecordNewProject,
}: {
  inputRef: React.RefObject<HTMLInputElement>
  onFile: (file: File) => void
  onRecordNewProject: (trigger: HTMLElement) => void
}) {
  return (
    <section className="flex-1 min-h-0 overflow-y-auto relative bg-canvas">
      <div className="relative min-h-full max-w-5xl mx-auto px-6 py-12 lg:py-16 flex flex-col justify-center">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-forest/25 bg-forest-soft px-3 py-1.5 text-[11px] font-medium text-forest-dark">
            <span className="h-1.5 w-1.5 rounded-full bg-forest" />
            Private, transcript-first audio editing
          </div>
          <h1 className="mt-5 text-[clamp(34px,5vw,58px)] leading-[1.04] font-semibold tracking-[-0.04em] text-ink">
            Edit the recording<br />like a document.
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-7 text-ink-muted">
            Import or record a voiceover, podcast, or interview. {PRODUCT_NAME} transcribes it on this computer, then turns every text cut into a precise ripple edit.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.webm"
              className="sr-only"
              aria-label="Choose media to import"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) onFile(file)
                event.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="h-11 px-5 rounded-xl bg-ember hover:bg-ember-hover text-on-accent text-sm font-semibold inline-flex items-center gap-2.5 shadow-lg shadow-ember/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            >
              <UploadIcon className="h-[18px] w-[18px]" />
              Import media
            </button>
            <button
              type="button"
              data-record-new-project
              onClick={(event) => onRecordNewProject(event.currentTarget)}
              className="h-11 px-5 rounded-xl border border-ember/45 bg-canvas-raised hover:border-ember hover:bg-ember-soft text-ink text-sm font-semibold inline-flex items-center gap-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            >
              <AudioIcon className="h-[18px] w-[18px] text-ember-dark" />
              Record new project
            </button>
            <span className="basis-full text-[11px] text-ink-muted">MP3, WAV, M4A, FLAC, AAC, OGG, MP4, or WebM</span>
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-3 mt-12 lg:mt-16">
          <FeatureCard
            icon={<ScissorsIcon className="h-5 w-5" />}
            title="Ripple-cut with text"
            copy="Select words and press Backspace. The audio closes the gap automatically."
          />
          <FeatureCard
            icon={<SparklesIcon className="h-5 w-5" />}
            title="Review before cleanup"
            copy="Preview filler, pause, and retake suggestions before applying anything."
          />
          <FeatureCard
            icon={<CheckIcon className="h-5 w-5" />}
            title="Local and reversible"
            copy="Projects stay on this device, with restore controls and multi-step undo."
          />
        </div>
      </div>
    </section>
  )
}

function FeatureCard({ icon, title, copy }: { icon: React.ReactNode; title: string; copy: string }) {
  return (
    <div className="rounded-2xl border border-line bg-canvas-raised p-[18px] shadow-sm shadow-line/25">
      <span className="h-9 w-9 rounded-xl bg-ember-soft text-ember-dark grid place-items-center">{icon}</span>
      <h2 className="mt-3 text-[13px] font-semibold text-ink">{title}</h2>
      <p className="mt-1.5 text-[12px] leading-5 text-ink-muted">{copy}</p>
    </div>
  )
}
