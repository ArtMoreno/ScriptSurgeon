import { create } from 'zustand'
import type {
  ExportFormat,
  GapEdit,
  GapPacing,
  InsertClip,
  Marker,
  MarkerAnchor,
  NoiseLevel,
  Speaker,
  TranscriptFormat,
  Word,
  ProjectMeta,
  ProjectState,
  RetakeGroupState,
} from './types.ts'
import { formatTranscript, transcriptTokens } from './lib/subtitles.ts'
import { player } from './lib/player.ts'
import { api } from './lib/api.ts'
import { applyCleanupProposals, runCleanup, selectRetakeCandidate, withCleanupSelection } from './lib/cleanup.ts'
import type { CleanupFeedback, CleanupKind, CleanupResult } from './lib/cleanup.ts'
import {
  buildTimeline,
  editedDuration,
  editedGaps,
  inferredSourceDuration,
  sourceRangeToEdited,
  sourceTimeToEditedNearest,
  wordAtEditedTime,
} from './lib/timeline.ts'
import {
  DEFAULT_GAP_PACING,
  clampGapTargetMs,
  eligibleGapWordIds,
  gapTargetsFromEdits,
  normalizeGapPacing,
} from './lib/gapPacing.ts'
import { formatChapterSidecar, markerAnchorAtEditedTime, resolveChapterRanges, resolveMarkers } from './lib/markers.ts'
import { normalizeProjectName, projectNameFromFilename, PROJECT_NAME_MAX_LENGTH } from './lib/projectRecording.ts'
import { isTerminalTranscriptionStatus, transcriptionErrorCopy } from './lib/transcriptionStatus.ts'
import { PRODUCT_NAME } from './lib/branding.ts'
import { reportRetakeAnalysis, retakeDiagnosticExceptionType } from './lib/clientErrors.ts'
import type { ProjectStatus, StatusPayload } from './types.ts'

type AppStatus = 'idle' | 'loading' | 'uploading' | 'transcribing' | 'ready' | 'error' | 'cancelled'

interface Snapshot {
  words: Word[]
  insertClips: InsertClip[]
  shortenedGapIds: string[]
  gapEdits: GapEdit[]
  gapPacing: GapPacing
  collapsedRetakes: string[][]
  retakeGroups: RetakeGroupState[]
  cleanupKeepWordIds: string[]
  cleanupKeepGapIds: string[]
  studioSound: boolean
  noiseReduction: NoiseLevel
  normalizeLoudness: boolean
  speakers: Speaker[]
  speakerByWord: Record<string, string>
  markers: Marker[]
}

export type CleanupWorkbenchFilter = 'all' | 'selected' | 'high' | 'review'

interface Store {
  projects: ProjectMeta[]
  projectId: string | null
  projectName: string
  words: Word[]
  insertClips: InsertClip[]
  shortenedGapIds: string[]
  gapEdits: GapEdit[]
  gapPacing: GapPacing
  collapsedRetakes: string[][]
  retakeGroups: RetakeGroupState[]
  cleanupKeepWordIds: string[]
  cleanupKeepGapIds: string[]
  studioSound: boolean
  noiseReduction: NoiseLevel
  normalizeLoudness: boolean
  speakers: Speaker[]
  speakerByWord: Record<string, string>
  markers: Marker[]
  sourceDuration: number
  sourceSampleRate: number | null
  sourceChannels: number | null
  status: AppStatus
  statusDetail: string
  progress: number
  errorMsg: string
  transcriptionRetryable: boolean
  operationError: string
  dirty: boolean
  saving: boolean
  rendering: boolean
  exporting: boolean
  recordingBusy: boolean
  // playback
  audioUrl: string | null
  editedAudioUrl: string | null
  editedAudioDuration: number
  audioPreviewMode: 'edited' | 'original'
  waveformReady: boolean
  playTime: number
  playing: boolean
  duration: number
  // selection (indices into words)
  selAnchor: number | null
  selFocus: number | null
  // cleanup feedback/review
  cleanupPreview: CleanupResult | null
  cleanupWorkbenchOpen: boolean
  cleanupWorkbenchFilter: CleanupWorkbenchFilter
  focusedCleanupProposalId: string | null
  lastCleanup: CleanupFeedback | null
  undoStack: Snapshot[]
  redoStack: Snapshot[]

  loadProjects: () => Promise<void>
  uploadFile: (file: File) => Promise<void>
  createRecordedProject: (file: File, name: string) => Promise<void>
  openProject: (id: string) => Promise<void>
  retryTranscription: () => Promise<void>
  deleteProject: (id: string) => Promise<void>
  closeProject: () => Promise<void>
  flushSave: () => Promise<void>
  exportProject: (format?: ExportFormat, range?: { start: number; end: number } | null, suffix?: string) => Promise<void>
  exportTranscript: (format: TranscriptFormat, options?: { includeChapterHeadings?: boolean; includeChapterCues?: boolean }) => void
  exportIntegration: (targetId: string, extension: string) => Promise<void>
  exportChapterList: () => void
  audioExportFormat: ExportFormat
  setAudioExportFormat: (format: ExportFormat) => void
  playbackRate: number
  setPlaybackRate: (rate: number) => void
  waveformGain: number
  setWaveformGain: (gain: number) => void
  clearOperationError: () => void
  reportError: (message: string) => void
  setPlayTime: (time: number) => void
  setPlaying: (playing: boolean) => void
  setWaveformReady: (ready: boolean) => void
  setAudioPreviewMode: (mode: 'edited' | 'original') => void
  setSelection: (anchor: number | null, focus: number | null) => void
  removeWords: (ids: string[]) => void
  removeSelection: () => void
  restoreWords: (ids: string[]) => void
  removeRetakeGroup: (group: string[]) => void
  restoreRetakeGroup: (group: string[]) => void
  chooseRetakeCandidate: (groupId: string, candidateIndex: number) => void
  restoreRetakeGroupById: (groupId: string) => void
  shortenGaps: (ids: string[]) => void
  unshortenGaps: (ids: string[]) => void
  setGapPacing: (pacing: GapPacing) => void
  setGapTarget: (afterWordId: string, targetGapMs: number) => void
  restoreGaps: (ids: string[]) => void
  keepOriginalGaps: (ids: string[]) => void
  previewCleanup: (kind: CleanupKind) => void
  setCleanupSelection: (proposalIds: string[]) => void
  selectRetakeCandidate: (proposalId: string, candidateId: string) => void
  selectHighConfidenceCleanup: () => void
  ignoreCleanupProposal: (proposalId: string) => void
  applyCleanup: () => void
  cancelCleanup: () => void
  openCleanupWorkbench: (kind: CleanupKind) => void
  closeCleanupWorkbench: () => void
  setCleanupWorkbenchFilter: (filter: CleanupWorkbenchFilter) => void
  focusCleanupProposal: (proposalId: string | null) => void
  auditionCleanupProposal: (proposalId: string) => void
  auditionRetakeCandidate: (proposalId: string, candidateId: string) => void
  correctWord: (id: string, text: string) => void
  addRecording: (file: File, text: string, afterWordId: string | null, sourceTime?: number) => Promise<void>
  replaceRecording: (insertId: string, file: File, text?: string) => Promise<void>
  correctInsertText: (insertId: string, text: string) => void
  removeInsert: (insertId: string) => void
  restoreInsert: (insertId: string) => void
  toggleStudio: () => void
  toggleNormalize: () => void
  revertToOriginal: () => void
  hasEdits: () => boolean
  assignSpeaker: (wordId: string, speakerId: string | null) => void
  addSpeaker: (name: string) => string | null
  renameSpeaker: (speakerId: string, name: string) => void
  setNoiseReduction: (level: NoiseLevel) => void
  addMarker: (kind: Marker['kind'], title?: string, anchor?: MarkerAnchor, end?: MarkerAnchor) => string | null
  updateMarker: (id: string, update: Partial<Pick<Marker, 'title' | 'kind' | 'anchor' | 'end'>>) => void
  deleteMarker: (id: string) => void
  seekMarker: (id: string) => void
  exportChapter: (id: string, format?: ExportFormat) => Promise<void>
  undo: () => void
  redo: () => void
  shortenGapAtPlayhead: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let renderTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let cleanupTimer: ReturnType<typeof setTimeout> | null = null
let lifecycleGeneration = 0
let lifecycleController = new AbortController()
let stateRevision = 0
let savedRevision = 0
let savedServerRevision: number | null = null
let renderRequest = 0
let projectListRequest = 0
let saveRun: { generation: number; projectId: string; promise: Promise<void> } | null = null

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) clearTimeout(timer)
  return null
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

function boundedMediaFormat(value: number | null | undefined, maximum: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximum
    ? value
    : null
}

function sameGroup(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id))
}

function removedRetakeIds(group: RetakeGroupState, keepIndex: number): string[] {
  return group.candidates
    .filter((_candidate, index) => index !== keepIndex)
    .flat()
}

function collapseRetakeSelection(
  groups: readonly string[][],
  group: RetakeGroupState,
  oldKeepIndex: number,
  newKeepIndex: number | null,
): string[][] {
  const oldRemoved = removedRetakeIds(group, oldKeepIndex)
  const retained = groups.filter((candidate) => !sameIdSet(candidate, oldRemoved))
  if (newKeepIndex === null) return retained
  const nextRemoved = removedRetakeIds(group, newKeepIndex)
  return nextRemoved.length ? [...retained, nextRemoved] : retained
}

function randomHexId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** Keep the legacy ID projection and exact per-gap targets in lockstep. */
function canonicalGapEdits(
  edits: readonly GapEdit[] | undefined,
  legacyIds: readonly string[] | undefined,
): GapEdit[] {
  const output: GapEdit[] = []
  const seen = new Set<string>()
  for (const edit of edits || []) {
    const afterWordId = edit?.afterWordId?.trim()
    if (!afterWordId || seen.has(afterWordId)) continue
    seen.add(afterWordId)
    output.push({ afterWordId, targetGapMs: clampGapTargetMs(edit.targetGapMs) })
  }
  for (const afterWordId of legacyIds || []) {
    if (!afterWordId || seen.has(afterWordId)) continue
    seen.add(afterWordId)
    output.push({ afterWordId, targetGapMs: DEFAULT_GAP_PACING.targetGapMs })
  }
  return output
}

function shortenedIdsFor(edits: readonly GapEdit[]): string[] {
  return edits.map((edit) => edit.afterWordId)
}

function wordConfidenceById(words: readonly Word[]): Record<string, number> {
  return words.reduce<Record<string, number>>((output, word) => {
    if (typeof word.asrConfidence === 'number' && Number.isFinite(word.asrConfidence)) {
      output[word.id] = Math.max(0, Math.min(1, word.asrConfidence))
    }
    return output
  }, {})
}

function markerAnchorAtPlayhead(state: Pick<Store, 'audioPreviewMode' | 'playTime' | 'words' | 'shortenedGapIds' | 'gapEdits' | 'sourceDuration' | 'insertClips'>): MarkerAnchor {
  if (state.audioPreviewMode === 'original') return { sourceTime: Math.max(0, Math.min(state.sourceDuration, state.playTime)) }
  const model = buildTimeline(
    state.words,
    new Set(state.shortenedGapIds),
    state.sourceDuration,
    state.insertClips,
    gapTargetsFromEdits(state.gapEdits),
  )
  return markerAnchorAtEditedTime(model, state.playTime)
}

function cleanupOptionsFor(state: Pick<Store, 'speakerByWord' | 'words' | 'gapPacing'>) {
  return {
    speakerByWord: state.speakerByWord,
    wordConfidenceById: wordConfidenceById(state.words),
    gapThresholdMs: state.gapPacing.detectionThresholdMs,
    gapTargetMs: state.gapPacing.targetGapMs,
  }
}

function beginLifecycle(): number {
  lifecycleGeneration += 1
  lifecycleController.abort()
  lifecycleController = new AbortController()
  saveTimer = clearTimer(saveTimer)
  renderTimer = clearTimer(renderTimer)
  pollTimer = clearTimer(pollTimer)
  cleanupTimer = clearTimer(cleanupTimer)
  stateRevision = 0
  savedRevision = 0
  savedServerRevision = null
  renderRequest += 1
  return lifecycleGeneration
}

function downloadBlob(
  blob: Blob,
  projectName: string,
  // Widened past the audio/transcript unions for delivery integrations, whose
  // extensions are served by the backend rather than known at build time.
  format: ExportFormat | TranscriptFormat | string,
  suffix = '_clean',
) {
  const safeName = projectName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || `${PRODUCT_NAME} export`
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${safeName}${suffix}.${format}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const useStore = create<Store>((set, get) => {
  function snapshot(): Snapshot {
    const state = get()
    return {
      words: state.words.map((word) => ({ ...word })),
      insertClips: state.insertClips.map((clip) => ({ ...clip })),
      shortenedGapIds: [...state.shortenedGapIds],
      gapEdits: state.gapEdits.map((edit) => ({ ...edit })),
      gapPacing: { ...state.gapPacing },
      collapsedRetakes: state.collapsedRetakes.map((group) => [...group]),
      retakeGroups: state.retakeGroups.map((group) => ({
        ...group,
        candidates: group.candidates.map((candidate) => [...candidate]),
      })),
      cleanupKeepWordIds: [...state.cleanupKeepWordIds],
      cleanupKeepGapIds: [...state.cleanupKeepGapIds],
      studioSound: state.studioSound,
      noiseReduction: state.noiseReduction,
      normalizeLoudness: state.normalizeLoudness,
      speakers: state.speakers.map((speaker) => ({ ...speaker })),
      speakerByWord: { ...state.speakerByWord },
      markers: state.markers.map((marker) => ({
        ...marker,
        anchor: { ...marker.anchor },
        ...(marker.end ? { end: { ...marker.end } } : {}),
      })),
    }
  }

  function projectState(): ProjectState {
    const state = get()
    return {
      words: state.words,
      insertClips: state.insertClips,
      shortenedGapIds: state.shortenedGapIds,
      gapEdits: state.gapEdits,
      gapPacing: state.gapPacing,
      studioSound: state.studioSound,
      noiseReduction: state.noiseReduction,
      normalizeLoudness: state.normalizeLoudness,
      speakers: state.speakers,
      speakerByWord: state.speakerByWord,
      collapsedRetakes: state.collapsedRetakes,
      retakeGroups: state.retakeGroups,
      cleanupKeepWordIds: state.cleanupKeepWordIds,
      cleanupKeepGapIds: state.cleanupKeepGapIds,
      markers: state.markers,
    }
  }

  function sameContext(generation: number, projectId: string): boolean {
    return generation === lifecycleGeneration && get().projectId === projectId
  }

  async function flushSave(): Promise<void> {
    saveTimer = clearTimer(saveTimer)
    const projectId = get().projectId
    const generation = lifecycleGeneration
    if (!projectId || savedRevision >= stateRevision) return
    if (saveRun && saveRun.generation === generation && saveRun.projectId === projectId) return saveRun.promise

    const signal = lifecycleController.signal
    const record = {
      generation,
      projectId,
      promise: Promise.resolve(),
    }
    record.promise = (async () => {
      set({ saving: true })
      try {
        while (sameContext(generation, projectId) && savedRevision < stateRevision) {
          const revision = stateRevision
          const state = projectState()
          const saved = await api.saveState(projectId, state, signal)
          if (!sameContext(generation, projectId)) return
          savedServerRevision = saved.revision
          savedRevision = Math.max(savedRevision, revision)
          set({ dirty: savedRevision < stateRevision, operationError: '' })
        }
      } catch (error) {
        if (!isAbort(error) && sameContext(generation, projectId)) {
          set({ dirty: true, operationError: `Could not save this edit. ${errorText(error, 'Try again.')}` })
        }
        throw error
      } finally {
        if (sameContext(generation, projectId)) set({ saving: false })
        if (saveRun === record) saveRun = null
      }
    })()
    saveRun = record
    return record.promise
  }

  async function refreshAudio(preservePosition: boolean): Promise<void> {
    renderTimer = clearTimer(renderTimer)
    const projectId = get().projectId
    const generation = lifecycleGeneration
    if (!projectId || get().status !== 'ready') {
      if (projectId && sameContext(generation, projectId)) set({ rendering: false })
      return
    }
    const request = ++renderRequest
    const wasTime = get().playTime
    const wasPlaying = get().playing
    let renderRequested = false

    try {
      await flushSave()
      if (!sameContext(generation, projectId) || request !== renderRequest) return
      set({ rendering: true })
      const studioSound = get().studioSound
      renderRequested = true
      const result = await api.render(projectId, studioSound, get().noiseReduction, get().normalizeLoudness, savedServerRevision, lifecycleController.signal)
      if (!sameContext(generation, projectId) || request !== renderRequest) return
      const calculatedDuration = editedDuration(
        get().words,
        new Set(get().shortenedGapIds),
        get().sourceDuration,
        get().insertClips,
        gapTargetsFromEdits(get().gapEdits),
      )
      const duration = Number.isFinite(result.duration) && result.duration >= 0
        ? result.duration
        : calculatedDuration
      const reviewingEditedAudio = get().audioPreviewMode === 'edited'
      const previewUnchanged = reviewingEditedAudio && get().audioUrl === result.url
      set({
        editedAudioUrl: result.url,
        editedAudioDuration: duration,
        ...(reviewingEditedAudio ? {
          audioUrl: result.url,
          waveformReady: previewUnchanged ? get().waveformReady : false,
          duration,
          playTime: preservePosition ? Math.min(wasTime, duration) : 0,
          playing: preservePosition ? wasPlaying : false,
        } : {}),
        rendering: false,
        operationError: '',
      })
    } catch (error) {
      if (!isAbort(error) && sameContext(generation, projectId) && request === renderRequest) {
        // `flushSave` owns save failures and has already surfaced a precise
        // message. Do not overwrite it with a misleading audio-preview error
        // when render was never requested (the screenshot's failure path).
        if (!renderRequested) {
          set({ rendering: false })
        } else {
          set({
            rendering: false,
            operationError: `The audio preview could not be updated. ${errorText(error, 'Your edit is still saved.')}`,
          })
        }
      }
    }
  }

  function queuePersistence(renderAudio: boolean) {
    stateRevision += 1
    if (renderAudio) renderRequest += 1
    set({ dirty: true, cleanupPreview: null, operationError: '', ...(renderAudio ? { rendering: true } : {}) })
    saveTimer = clearTimer(saveTimer)
    saveTimer = setTimeout(() => {
      void flushSave().catch(() => undefined)
    }, 300)
    if (renderAudio) {
      renderTimer = clearTimer(renderTimer)
      renderTimer = setTimeout(() => {
        void refreshAudio(true)
      }, 650)
    }
  }

  function applyEdit(mutator: (state: Store) => Partial<Store>, renderAudio = true) {
    if (!get().projectId || get().status !== 'ready') return
    const undoStack = [...get().undoStack, snapshot()].slice(-60)
    // Any new edit forms a new history branch. A stale redo would otherwise
    // reintroduce an edit from a different timeline state.
    set({ ...mutator(get()), undoStack, redoStack: [] })
    queuePersistence(renderAudio)
  }

  function loadReadyProject(
    projectId: string,
    projectMeta: ProjectMeta,
    state: ProjectState,
  ) {
    const originalDuration = inferredSourceDuration(state.words, projectMeta.duration)
    const gapEdits = canonicalGapEdits(state.gapEdits, state.shortenedGapIds)
    const shortenedGapIds = shortenedIdsFor(gapEdits)
    const duration = editedDuration(
      state.words,
      new Set(shortenedGapIds),
      originalDuration,
      state.insertClips || [],
      gapTargetsFromEdits(gapEdits),
    )
    stateRevision = 0
    savedRevision = 0
    savedServerRevision = state.revision ?? null
    set({
      projectId,
      projectName: projectMeta.name,
      words: state.words,
      insertClips: state.insertClips || [],
      shortenedGapIds,
      gapEdits,
      gapPacing: normalizeGapPacing(state.gapPacing),
      collapsedRetakes: state.collapsedRetakes || [],
      retakeGroups: state.retakeGroups || [],
      cleanupKeepWordIds: state.cleanupKeepWordIds || [],
      cleanupKeepGapIds: state.cleanupKeepGapIds || [],
      studioSound: state.studioSound || false,
      noiseReduction: state.noiseReduction || 'off',
      // Loudness used to live inside Studio sound; keep older projects sounding the same.
      normalizeLoudness: state.normalizeLoudness ?? Boolean(state.studioSound),
      speakers: state.speakers || [],
      speakerByWord: state.speakerByWord || {},
      markers: state.markers || [],
      sourceDuration: originalDuration,
      sourceSampleRate: boundedMediaFormat(projectMeta.sampleRate, 384_000),
      sourceChannels: boundedMediaFormat(projectMeta.channels, 64),
      duration,
      status: 'ready',
      statusDetail: '',
      progress: 1,
      errorMsg: '',
      transcriptionRetryable: false,
      operationError: '',
      dirty: false,
      saving: false,
      rendering: true,
      exporting: false,
      recordingBusy: false,
      undoStack: [],
      redoStack: [],
      cleanupPreview: null,
      cleanupWorkbenchOpen: false,
      cleanupWorkbenchFilter: 'all',
      focusedCleanupProposalId: null,
      lastCleanup: null,
      selAnchor: null,
      selFocus: null,
      playTime: 0,
      playing: false,
      audioUrl: null,
      editedAudioUrl: null,
      editedAudioDuration: duration,
      audioPreviewMode: 'edited',
      waveformReady: false,
    })
  }

  function setListedProjectStatus(projectId: string, status: ProjectStatus) {
    set((state) => ({
      projects: state.projects.map((project) => project.id === projectId ? { ...project, status } : project),
    }))
  }

  function applyTerminalTranscriptionStatus(projectId: string, payload: StatusPayload): boolean {
    const terminalStatus = payload.status
    if (!isTerminalTranscriptionStatus(terminalStatus)) return false
    pollTimer = clearTimer(pollTimer)
    set((state) => ({
      status: terminalStatus,
      progress: Math.max(0, Math.min(1, payload.progress ?? state.progress)),
      statusDetail: '',
      errorMsg: transcriptionErrorCopy(payload),
      transcriptionRetryable: true,
      projects: state.projects.map((project) => project.id === projectId
        ? { ...project, status: terminalStatus }
        : project),
    }))
    void get().loadProjects()
    return true
  }

  function startPolling(projectId: string, generation: number) {
    const poll = async () => {
      if (!sameContext(generation, projectId)) return
      try {
        const status = await api.status(projectId, lifecycleController.signal)
        if (!sameContext(generation, projectId)) return
        if (status.status === 'ready') {
          const project = await api.getProject(projectId, lifecycleController.signal)
          if (!sameContext(generation, projectId)) return
          if (project.state) {
            loadReadyProject(projectId, project.meta, project.state)
            void refreshAudio(false)
            void get().loadProjects()
            return
          }
        }
        if (applyTerminalTranscriptionStatus(projectId, status)) return
        const listedStatus: ProjectStatus = status.status === 'queued' ? 'queued' : 'transcribing'
        set((state) => ({
          status: 'transcribing',
          progress: Math.max(0, Math.min(1, status.progress ?? 0)),
          statusDetail: status.message || status.stage || ((status.progress ?? 0) <= 0.03
            ? 'Preparing the local speech model. The first run can take a few minutes.'
            : 'Transcribing locally on this computer.'),
          errorMsg: '',
          transcriptionRetryable: false,
          projects: state.projects.map((project) => project.id === projectId
            ? { ...project, status: listedStatus }
            : project),
        }))
        pollTimer = setTimeout(poll, 700)
      } catch (error) {
        if (!isAbort(error) && sameContext(generation, projectId)) {
          set({
            status: 'error',
            errorMsg: `Transcription status could not be checked. ${errorText(error, `Restart ${PRODUCT_NAME} and try again.`)}`,
            transcriptionRetryable: false,
          })
        }
      }
    }
    pollTimer = setTimeout(poll, 250)
  }

  async function createProject(
    file: File,
    kind: 'import' | 'recording',
    requestedName?: string,
  ): Promise<void> {
    const trimmedName = requestedName?.trim()
    if (kind === 'recording') {
      if (!trimmedName) throw new Error('Enter a project name before saving this recording.')
      if (trimmedName.length > PROJECT_NAME_MAX_LENGTH) {
        throw new Error(`Project names can be no longer than ${PROJECT_NAME_MAX_LENGTH} characters.`)
      }
    }
    const displayName = trimmedName
      ? normalizeProjectName(trimmedName)
      : projectNameFromFilename(file.name) || 'Untitled'

    await flushSave()
    const generation = beginLifecycle()
    set({
      projectId: null,
      projectName: displayName,
      words: [],
      insertClips: [],
      shortenedGapIds: [],
      gapEdits: [],
      gapPacing: { ...DEFAULT_GAP_PACING },
      collapsedRetakes: [],
      retakeGroups: [],
      cleanupKeepWordIds: [],
      cleanupKeepGapIds: [],
      studioSound: false,
      noiseReduction: 'off',
      normalizeLoudness: false,
      speakers: [],
      speakerByWord: {},
      markers: [],
      sourceDuration: 0,
      sourceSampleRate: null,
      sourceChannels: null,
      duration: 0,
      status: 'uploading',
      statusDetail: kind === 'recording'
        ? 'Saving the recording into your local project library.'
        : 'Copying the media into your local project library.',
      progress: 0,
      errorMsg: '',
      transcriptionRetryable: false,
      operationError: '',
      dirty: false,
      saving: false,
      rendering: false,
      exporting: false,
      recordingBusy: false,
      audioUrl: null,
      editedAudioUrl: null,
      editedAudioDuration: 0,
      audioPreviewMode: 'edited',
      waveformReady: false,
      playTime: 0,
      playing: false,
      selAnchor: null,
      selFocus: null,
      cleanupPreview: null,
      cleanupWorkbenchOpen: false,
      cleanupWorkbenchFilter: 'all',
      focusedCleanupProposalId: null,
      lastCleanup: null,
      undoStack: [],
      redoStack: [],
    })
    try {
      const { id, name } = await api.upload(
        file,
        lifecycleController.signal,
        kind === 'recording' ? displayName : undefined,
      )
      if (generation !== lifecycleGeneration) return
      set({
        projectId: id,
        projectName: name,
        status: 'transcribing',
        statusDetail: 'Preparing local transcription.',
        transcriptionRetryable: false,
      })
      void get().loadProjects()
      startPolling(id, generation)
    } catch (error) {
      if (!isAbort(error) && generation === lifecycleGeneration) {
        const message = kind === 'recording'
          ? `The recording could not be saved as a project. ${errorText(error, 'Check the recording and try again.')}`
          : `The file could not be imported. ${errorText(error, 'Try a supported audio or video file.')}`
        set({
          status: 'error',
          errorMsg: message,
          transcriptionRetryable: false,
          // The recording dialog owns its retryable error while it remains open.
          operationError: kind === 'recording' ? '' : message,
        })
        // A timeout or dropped response can happen after the backend has
        // committed the project. Refresh without closing the retryable dialog
        // so that committed local work remains discoverable in the sidebar.
        void get().loadProjects()
        if (kind === 'recording') throw new Error(message)
      }
      throw error
    }
  }

  return {
    projects: [],
    projectId: null,
    projectName: '',
    words: [],
    insertClips: [],
    shortenedGapIds: [],
    gapEdits: [],
    gapPacing: { ...DEFAULT_GAP_PACING },
    collapsedRetakes: [],
    retakeGroups: [],
    cleanupKeepWordIds: [],
    cleanupKeepGapIds: [],
    studioSound: false,
    noiseReduction: 'off',
    normalizeLoudness: false,
    speakers: [],
    speakerByWord: {},
    markers: [],
    sourceDuration: 0,
    sourceSampleRate: null,
    sourceChannels: null,
    status: 'idle',
    statusDetail: '',
    progress: 0,
    errorMsg: '',
    transcriptionRetryable: false,
    operationError: '',
    dirty: false,
    saving: false,
    rendering: false,
    exporting: false,
    recordingBusy: false,
    audioUrl: null,
    editedAudioUrl: null,
    editedAudioDuration: 0,
    audioPreviewMode: 'edited',
    waveformReady: false,
    playTime: 0,
    playing: false,
    duration: 0,
    selAnchor: null,
    selFocus: null,
    cleanupPreview: null,
    cleanupWorkbenchOpen: false,
    cleanupWorkbenchFilter: 'all',
    focusedCleanupProposalId: null,
    lastCleanup: null,
    undoStack: [],
    redoStack: [],

    loadProjects: async () => {
      const request = ++projectListRequest
      try {
        const projects = await api.listProjects()
        if (request === projectListRequest) set({ projects })
      } catch (error) {
        if (request === projectListRequest) {
          set({ operationError: `Projects could not be loaded. ${errorText(error, `Check that ${PRODUCT_NAME} is running.`)}` })
        }
      }
    },

    uploadFile: (file) => createProject(file, 'import'),

    createRecordedProject: (file, name) => createProject(file, 'recording', name),

    openProject: async (id) => {
      if (id === get().projectId && !isTerminalTranscriptionStatus(get().status)) return
      await flushSave()
      const generation = beginLifecycle()
      const known = get().projects.find((project) => project.id === id)
      set({
        projectId: id,
        projectName: known?.name || 'Opening project',
        words: [],
        insertClips: [],
        shortenedGapIds: [],
        gapEdits: [],
        gapPacing: { ...DEFAULT_GAP_PACING },
        collapsedRetakes: [],
        retakeGroups: [],
        cleanupKeepWordIds: [],
        cleanupKeepGapIds: [],
        markers: [],
        sourceDuration: 0,
        sourceSampleRate: null,
        sourceChannels: null,
        duration: 0,
        status: 'loading',
        statusDetail: 'Opening the local project...',
        progress: 0,
        errorMsg: '',
        transcriptionRetryable: false,
        operationError: '',
        dirty: false,
        saving: false,
        rendering: false,
        exporting: false,
        recordingBusy: false,
        audioUrl: null,
        editedAudioUrl: null,
        editedAudioDuration: 0,
        audioPreviewMode: 'edited',
        waveformReady: false,
        playTime: 0,
        playing: false,
        selAnchor: null,
        selFocus: null,
        cleanupPreview: null,
        cleanupWorkbenchOpen: false,
        cleanupWorkbenchFilter: 'all',
        focusedCleanupProposalId: null,
        lastCleanup: null,
        undoStack: [],
        redoStack: [],
      })
      try {
        const project = await api.getProject(id, lifecycleController.signal)
        if (!sameContext(generation, id)) return
        if (project.state) {
          loadReadyProject(id, project.meta, project.state)
          void refreshAudio(false)
        } else if (applyTerminalTranscriptionStatus(id, project.status)) {
          set({ projectName: project.meta.name })
        } else {
          const listedStatus: ProjectStatus = project.status.status === 'queued' ? 'queued' : 'transcribing'
          set({
            projectName: project.meta.name,
            status: 'transcribing',
            statusDetail: project.status.message || 'Resuming local transcription.',
            transcriptionRetryable: false,
          })
          setListedProjectStatus(id, listedStatus)
          startPolling(id, generation)
        }
      } catch (error) {
        if (!isAbort(error) && sameContext(generation, id)) {
          set({
            status: 'error',
            errorMsg: `This project could not be opened. ${errorText(error, 'Try again.')}`,
            transcriptionRetryable: false,
          })
        }
      }
    },

    retryTranscription: async () => {
      const state = get()
      const projectId = state.projectId
      if (!projectId || !state.transcriptionRetryable || !isTerminalTranscriptionStatus(state.status)) return
      const generation = lifecycleGeneration
      const previousStatus = state.status
      pollTimer = clearTimer(pollTimer)
      set({
        status: 'transcribing',
        statusDetail: 'Restarting local transcription.',
        progress: 0,
        errorMsg: '',
        transcriptionRetryable: false,
        operationError: '',
      })
      try {
        await api.retryTranscription(projectId, lifecycleController.signal)
        if (!sameContext(generation, projectId)) return
        set({
          status: 'transcribing',
          statusDetail: 'Waiting for the local transcriber.',
          progress: 0,
          errorMsg: '',
          transcriptionRetryable: false,
        })
        setListedProjectStatus(projectId, 'queued')
        void get().loadProjects()
        startPolling(projectId, generation)
      } catch (error) {
        if (!isAbort(error) && sameContext(generation, projectId)) {
          set({
            status: previousStatus,
            statusDetail: '',
            errorMsg: `Transcription could not be restarted. ${errorText(error, 'Try again.')}`,
            transcriptionRetryable: true,
          })
          setListedProjectStatus(projectId, previousStatus)
        }
      }
    },

    deleteProject: async (id) => {
      try {
        await api.deleteProject(id)
        // Keep the current project intact until the backend confirms deletion.
        // A lease or recording import can legitimately reject deletion; clearing
        // first would strand the editor on an empty screen even though the local
        // project still exists. Also avoid closing a different project that the
        // user opened while this request was in flight.
        if (get().projectId === id) {
          beginLifecycle()
          set({
            projectId: null,
            projectName: '',
            words: [],
            insertClips: [],
            shortenedGapIds: [],
            gapEdits: [],
            gapPacing: { ...DEFAULT_GAP_PACING },
            collapsedRetakes: [],
            retakeGroups: [],
            cleanupKeepWordIds: [],
            cleanupKeepGapIds: [],
            markers: [],
            sourceDuration: 0,
            sourceSampleRate: null,
            sourceChannels: null,
            duration: 0,
            status: 'idle',
            transcriptionRetryable: false,
            statusDetail: '',
            audioUrl: null,
            editedAudioUrl: null,
            editedAudioDuration: 0,
            audioPreviewMode: 'edited',
            waveformReady: false,
            playTime: 0,
            playing: false,
            rendering: false,
            exporting: false,
            recordingBusy: false,
            dirty: false,
            saving: false,
            errorMsg: '',
            operationError: '',
            undoStack: [],
            redoStack: [],
          })
        }
        await get().loadProjects()
      } catch (error) {
        set({ operationError: `The project could not be deleted. ${errorText(error, 'Try again.')}` })
        throw error
      }
    },

    closeProject: async () => {
      await flushSave()
      beginLifecycle()
      set({
        projectId: null,
        projectName: '',
        words: [],
        insertClips: [],
        shortenedGapIds: [],
        gapEdits: [],
        gapPacing: { ...DEFAULT_GAP_PACING },
        collapsedRetakes: [],
        retakeGroups: [],
        cleanupKeepWordIds: [],
        cleanupKeepGapIds: [],
        studioSound: false,
        noiseReduction: 'off',
        normalizeLoudness: false,
        speakers: [],
        speakerByWord: {},
        markers: [],
        sourceDuration: 0,
        sourceSampleRate: null,
        sourceChannels: null,
        duration: 0,
        status: 'idle',
        statusDetail: '',
        progress: 0,
        errorMsg: '',
        transcriptionRetryable: false,
        operationError: '',
        dirty: false,
        saving: false,
        rendering: false,
        exporting: false,
        recordingBusy: false,
        audioUrl: null,
        editedAudioUrl: null,
        editedAudioDuration: 0,
        audioPreviewMode: 'edited',
        waveformReady: false,
        playTime: 0,
        playing: false,
        undoStack: [],
        redoStack: [],
        cleanupPreview: null,
        cleanupWorkbenchOpen: false,
        cleanupWorkbenchFilter: 'all',
        focusedCleanupProposalId: null,
        lastCleanup: null,
        selAnchor: null,
        selFocus: null,
      })
    },

    flushSave,

    exportProject: async (
      format: ExportFormat = 'wav',
      range: { start: number; end: number } | null = null,
      suffix?: string,
    ) => {
      const state = get()
      if (!state.projectId || state.status !== 'ready' || state.exporting) return
      const projectId = state.projectId
      const generation = lifecycleGeneration
      set({ exporting: true, operationError: '' })
      try {
        await flushSave()
        if (!sameContext(generation, projectId)) return
        const blob = await api.exportAudio(
          projectId,
          get().studioSound,
          get().noiseReduction,
          get().normalizeLoudness,
          format,
          savedServerRevision,
          lifecycleController.signal,
          range,
        )
        if (!sameContext(generation, projectId)) return
        downloadBlob(blob, get().projectName, format, suffix || (range ? '_clip' : '_clean'))
        set({ exporting: false })
      } catch (error) {
        if (!isAbort(error) && sameContext(generation, projectId)) {
          set({ exporting: false, operationError: `Export failed. ${errorText(error, 'Try again.')}` })
        }
      }
    },

    /**
     * Run a served delivery target and save what it produces.
     *
     * Unlike the transcript formats, these are composed on the backend from the
     * saved state, so the pending edit is flushed first or the handoff would
     * describe an older cut than the one on screen.
     */
    exportIntegration: async (targetId: string, extension: string) => {
      const state = get()
      if (!state.projectId || state.status !== 'ready' || state.exporting) return
      const projectId = state.projectId
      const generation = lifecycleGeneration
      set({ exporting: true, operationError: '' })
      try {
        await flushSave()
        if (!sameContext(generation, projectId)) return
        const blob = await api.exportIntegration(projectId, targetId, lifecycleController.signal)
        if (!sameContext(generation, projectId)) return
        downloadBlob(blob, get().projectName, extension, '_edit')
        set({ exporting: false })
      } catch (error) {
        if (!isAbort(error) && sameContext(generation, projectId)) {
          set({ exporting: false, operationError: `Export failed. ${errorText(error, 'Try again.')}` })
        }
      }
    },

    // Timings come from the edited timeline, so the file lines up with the
    // exported audio. No backend round-trip is needed for text.
    exportTranscript: (format: TranscriptFormat, options = {}) => {
      const state = get()
      if (!state.projectId || state.status !== 'ready') return
      set({ operationError: '' })
      const targets = gapTargetsFromEdits(state.gapEdits)
      const tokens = transcriptTokens(
        state.words,
        new Set(state.shortenedGapIds),
        state.sourceDuration,
        state.insertClips,
        targets,
      )
      if (!tokens.length) {
        set({ operationError: 'There is no transcript text left to export.' })
        return
      }
      const timeline = buildTimeline(
        state.words,
        new Set(state.shortenedGapIds),
        state.sourceDuration,
        state.insertClips,
        targets,
      )
      const chapters = resolveChapterRanges(state.markers, timeline)
        .map((chapter) => ({ title: chapter.title, start: chapter.start, end: chapter.end }))
      const text = formatTranscript(tokens, format, { chapters, ...options })
      const mime = format === 'txt' ? 'text/plain' : format === 'vtt' ? 'text/vtt' : 'application/x-subrip'
      const suffix = options.includeChapterHeadings || options.includeChapterCues ? '_chapters' : '_clean'
      downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), state.projectName, format, suffix)
    },

    exportChapterList: () => {
      const state = get()
      if (!state.projectId || state.status !== 'ready') return
      const timeline = buildTimeline(
        state.words,
        new Set(state.shortenedGapIds),
        state.sourceDuration,
        state.insertClips,
        gapTargetsFromEdits(state.gapEdits),
      )
      const chapters = resolveChapterRanges(state.markers, timeline)
      if (!chapters.length) {
        set({ operationError: 'Add at least one chapter before exporting a chapter list.' })
        return
      }
      const text = formatChapterSidecar(chapters)
      downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), state.projectName, 'txt', '_chapters')
    },

    // A UI preference rather than project state: the transport's range export
    // and the toolbar button must agree on which audio format to produce.
    audioExportFormat: 'wav',
    setAudioExportFormat: (format: ExportFormat) => set({ audioExportFormat: format }),

    // Review-only view settings: they never touch the render, so they are not
    // part of project state and never mark the project dirty.
    playbackRate: 1,
    setPlaybackRate: (rate: number) => {
      const current = get().playbackRate
      const next = Number.isFinite(rate) ? Math.max(0.25, Math.min(4, rate)) : current
      if (next === current) return
      player.setRate(next)
      set({ playbackRate: next })
    },
    waveformGain: 1,
    setWaveformGain: (gain: number) => {
      const current = get().waveformGain
      const next = Number.isFinite(gain) ? Math.max(1, Math.min(8, gain)) : current
      if (next !== current) set({ waveformGain: next })
    },

    clearOperationError: () => set({ operationError: '' }),
    reportError: (message) => set({ operationError: message }),
    setPlayTime: (time) => {
      if (!Number.isFinite(time)) return
      set((state) => ({ playTime: Math.max(0, Math.min(state.duration, time)) }))
    },
    setPlaying: (playing) => set({ playing }),
    setWaveformReady: (ready) => set({ waveformReady: ready }),
    setAudioPreviewMode: (mode) => {
      const state = get()
      if (!state.projectId || state.status !== 'ready' || state.audioPreviewMode === mode) return
      const url = mode === 'original' ? api.originalAudioUrl(state.projectId) : state.editedAudioUrl
      if (!url) {
        if (mode === 'edited') {
          set({ audioPreviewMode: 'edited', audioUrl: null, waveformReady: false, playTime: 0, playing: false })
          void refreshAudio(false)
        }
        return
      }
      player.get()?.pause()
      set({
        audioPreviewMode: mode,
        audioUrl: url,
        waveformReady: false,
        playTime: 0,
        playing: false,
        duration: mode === 'original' ? state.sourceDuration : state.editedAudioDuration,
        operationError: '',
      })
    },
    setSelection: (anchor, focus) => set({ selAnchor: anchor, selFocus: focus }),

    removeWords: (ids) => {
      if (!ids.length) return
      const idSet = new Set(ids)
      const invalidGapIds = new Set(ids)
      get().words.forEach((word, index) => {
        if (idSet.has(word.id) && index > 0) invalidGapIds.add(get().words[index - 1].id)
      })
      applyEdit((state) => ({
        // A direct word cut is deliberately independent from an automatic
        // filler/retake decision. This lets it be restored as a normal word.
        words: state.words.map((word) => (idSet.has(word.id)
          ? { ...word, isRemoved: true, isFiller: false, isRetake: false }
          : word)),
        collapsedRetakes: state.collapsedRetakes
          .map((group) => group.filter((id) => !idSet.has(id)))
          .filter((group) => group.length > 0),
        retakeGroups: state.retakeGroups.filter((group) => !group.candidates.some((candidate) => candidate.some((id) => idSet.has(id)))),
        gapEdits: state.gapEdits.filter((edit) => !invalidGapIds.has(edit.afterWordId)),
        shortenedGapIds: shortenedIdsFor(state.gapEdits.filter((edit) => !invalidGapIds.has(edit.afterWordId))),
        cleanupKeepWordIds: state.cleanupKeepWordIds.filter((id) => !idSet.has(id)),
        selAnchor: null,
        selFocus: null,
      }))
    },

    removeSelection: () => {
      const state = get()
      if (state.selAnchor === null || state.selFocus === null) return
      const [low, high] = [Math.min(state.selAnchor, state.selFocus), Math.max(state.selAnchor, state.selFocus)]
      const ids = state.words.slice(low, high + 1).filter((word) => !word.isRemoved).map((word) => word.id)
      get().removeWords(ids)
    },

    restoreWords: (ids) => {
      const knownIds = new Set(get().words.map((word) => word.id))
      const validIds = [...new Set(ids)].filter((id) => knownIds.has(id))
      if (!validIds.length) return
      const idSet = new Set(validIds)
      const invalidGapIds = new Set(validIds)
      get().words.forEach((word, index) => {
        if (idSet.has(word.id) && index > 0) invalidGapIds.add(get().words[index - 1].id)
      })
      applyEdit((state) => {
        const gapEdits = state.gapEdits.filter((edit) => !invalidGapIds.has(edit.afterWordId))
        return {
        words: state.words.map((word) => (idSet.has(word.id)
          ? { ...word, isRemoved: false, isFiller: false, isRetake: false }
          : word)),
        gapEdits,
        shortenedGapIds: shortenedIdsFor(gapEdits),
        collapsedRetakes: state.collapsedRetakes
          .map((group) => group.filter((id) => !idSet.has(id)))
          .filter((group) => group.length > 0),
        retakeGroups: state.retakeGroups.filter((group) => !group.candidates.some((candidate) => candidate.some((id) => idSet.has(id)))),
        cleanupKeepWordIds: [...new Set([...state.cleanupKeepWordIds, ...validIds])],
        }
      })
    },

    removeRetakeGroup: (group) => {
      const knownIds = new Set(get().words.map((word) => word.id))
      const validGroup = [...new Set(group)].filter((id) => knownIds.has(id))
      if (!validGroup.length) return
      const idSet = new Set(validGroup)
      const invalidGapIds = new Set(validGroup)
      get().words.forEach((word, index) => {
        if (idSet.has(word.id) && index > 0) invalidGapIds.add(get().words[index - 1].id)
      })
      applyEdit((state) => {
        const gapEdits = state.gapEdits.filter((edit) => !invalidGapIds.has(edit.afterWordId))
        return {
          words: state.words.map((word) => (idSet.has(word.id)
            ? { ...word, isRemoved: true, isRetake: true }
            : word)),
          gapEdits,
          shortenedGapIds: shortenedIdsFor(gapEdits),
          collapsedRetakes: state.collapsedRetakes.some((candidate) => sameGroup(candidate, validGroup))
            ? state.collapsedRetakes
            : [...state.collapsedRetakes, validGroup],
          retakeGroups: state.retakeGroups.filter((candidate) => !candidate.candidates.some((take) => take.some((id) => idSet.has(id)))),
          cleanupKeepWordIds: state.cleanupKeepWordIds.filter((id) => !idSet.has(id)),
          selAnchor: null,
          selFocus: null,
        }
      })
    },

    restoreRetakeGroup: (group) => {
      const knownIds = new Set(get().words.map((word) => word.id))
      const validGroup = [...new Set(group)].filter((id) => knownIds.has(id))
      if (!validGroup.length) return
      const idSet = new Set(validGroup)
      const invalidGapIds = new Set(validGroup)
      get().words.forEach((word, index) => {
        if (idSet.has(word.id) && index > 0) invalidGapIds.add(get().words[index - 1].id)
      })
      applyEdit((state) => {
        const gapEdits = state.gapEdits.filter((edit) => !invalidGapIds.has(edit.afterWordId))
        return {
        // Keep the group metadata while it is restored so the user can remove
        // the same retake again without rerunning automatic cleanup.
        words: state.words.map((word) => (idSet.has(word.id)
          ? { ...word, isRemoved: false, isRetake: true }
          : word)),
        gapEdits,
        shortenedGapIds: shortenedIdsFor(gapEdits),
        collapsedRetakes: state.collapsedRetakes.some((candidate) => sameGroup(candidate, validGroup))
          ? state.collapsedRetakes
          : [...state.collapsedRetakes, validGroup],
        cleanupKeepWordIds: [...new Set([...state.cleanupKeepWordIds, ...validGroup])],
        }
      })
    },

    chooseRetakeCandidate: (groupId, candidateIndex) => {
      const stored = get().retakeGroups.find((group) => group.id === groupId)
      if (!stored || candidateIndex < 0 || candidateIndex >= stored.candidates.length || candidateIndex === stored.selectedKeepIndex) return
      const allIds = new Set(stored.candidates.flat())
      if (!allIds.size || [...allIds].some((id) => !get().words.some((word) => word.id === id))) return
      const keepIds = new Set(stored.candidates[candidateIndex])
      const invalidGapIds = new Set(allIds)
      get().words.forEach((word, index) => {
        if (allIds.has(word.id) && index > 0) invalidGapIds.add(get().words[index - 1].id)
      })
      applyEdit((state) => {
        const live = state.retakeGroups.find((group) => group.id === groupId)
        if (!live || candidateIndex >= live.candidates.length) return {}
        const gapEdits = state.gapEdits.filter((edit) => !invalidGapIds.has(edit.afterWordId))
        return {
          words: state.words.map((word) => {
            if (!allIds.has(word.id)) return word
            return keepIds.has(word.id)
              ? { ...word, isRemoved: false, isRetake: false }
              : { ...word, isRemoved: true, isRetake: true }
          }),
          gapEdits,
          shortenedGapIds: shortenedIdsFor(gapEdits),
          collapsedRetakes: collapseRetakeSelection(
            state.collapsedRetakes,
            live,
            live.selectedKeepIndex,
            candidateIndex,
          ),
          retakeGroups: state.retakeGroups.map((group) => group.id === groupId
            ? { ...group, selectedKeepIndex: candidateIndex }
            : group),
          selAnchor: null,
          selFocus: null,
        }
      })
    },

    restoreRetakeGroupById: (groupId) => {
      const stored = get().retakeGroups.find((group) => group.id === groupId)
      if (!stored) return
      const ids = new Set(stored.candidates.flat())
      if (!ids.size || [...ids].some((id) => !get().words.some((word) => word.id === id))) return
      const invalidGapIds = new Set(ids)
      get().words.forEach((word, index) => {
        if (ids.has(word.id) && index > 0) invalidGapIds.add(get().words[index - 1].id)
      })
      applyEdit((state) => {
        const live = state.retakeGroups.find((group) => group.id === groupId)
        if (!live) return {}
        const gapEdits = state.gapEdits.filter((edit) => !invalidGapIds.has(edit.afterWordId))
        return {
          words: state.words.map((word) => ids.has(word.id)
            ? { ...word, isRemoved: false, isRetake: false }
            : word),
          gapEdits,
          shortenedGapIds: shortenedIdsFor(gapEdits),
          collapsedRetakes: collapseRetakeSelection(
            state.collapsedRetakes,
            live,
            live.selectedKeepIndex,
            null,
          ),
          selAnchor: null,
          selFocus: null,
        }
      })
    },

    shortenGaps: (ids) => {
      const state = get()
      const targetGapMs = state.gapPacing.targetGapMs
      // Direct waveform and keyboard actions use the same candidate policy as
      // Cleanup review. This keeps meaningful sentence/speaker pauses and
      // deliberately slow delivery from being shortened by a bypass path.
      const eligible = new Set(eligibleGapWordIds(
        state.words,
        state.gapPacing,
        state.speakerByWord,
        state.cleanupKeepGapIds,
      ))
      const valid = new Set(
        editedGaps(state.words, new Set<string>(), state.sourceDuration)
          .filter((gap) => !gap.shortened && eligible.has(gap.wordId) && gap.origGap * 1000 > targetGapMs)
          .map((gap) => gap.wordId),
      )
      const requested = [...new Set(ids)].filter((id) => valid.has(id))
      if (!requested.length) return
      const requestedSet = new Set(requested)
      applyEdit((current) => {
        const editsByWord = new Map(current.gapEdits.map((edit) => [edit.afterWordId, edit]))
        requested.forEach((afterWordId) => editsByWord.set(afterWordId, { afterWordId, targetGapMs }))
        const gapEdits = current.words
          .map((word) => editsByWord.get(word.id))
          .filter((edit): edit is GapEdit => Boolean(edit))
        return {
          gapEdits,
          shortenedGapIds: shortenedIdsFor(gapEdits),
          cleanupKeepGapIds: current.cleanupKeepGapIds.filter((id) => !requestedSet.has(id)),
        }
      })
    },

    restoreGaps: (ids) => {
      if (!ids.length) return
      const idSet = new Set(ids)
      applyEdit((state) => {
        const gapEdits = state.gapEdits.filter((edit) => !idSet.has(edit.afterWordId))
        return { gapEdits, shortenedGapIds: shortenedIdsFor(gapEdits) }
      })
    },

    // Backward-compatible name used by existing transcript/waveform actions.
    unshortenGaps: (ids) => get().restoreGaps(ids),

    keepOriginalGaps: (ids) => {
      const knownIds = new Set(get().words.map((word) => word.id))
      const validIds = [...new Set(ids)].filter((id) => knownIds.has(id))
      if (!validIds.length) return
      const idSet = new Set(validIds)
      applyEdit((state) => {
        const gapEdits = state.gapEdits.filter((edit) => !idSet.has(edit.afterWordId))
        return {
          gapEdits,
          shortenedGapIds: shortenedIdsFor(gapEdits),
          cleanupKeepGapIds: [...new Set([...state.cleanupKeepGapIds, ...validIds])],
        }
      }, false)
    },

    setGapPacing: (pacing) => {
      const next = normalizeGapPacing(pacing)
      const current = get().gapPacing
      if (
        next.preset === current.preset
        && next.detectionThresholdMs === current.detectionThresholdMs
        && next.targetGapMs === current.targetGapMs
      ) return
      applyEdit(() => ({ gapPacing: next }), false)
    },

    setGapTarget: (afterWordId, targetGapMs) => {
      const state = get()
      const index = state.words.findIndex((word) => word.id === afterWordId)
      const next = index >= 0 ? state.words[index + 1] : undefined
      const current = index >= 0 ? state.words[index] : undefined
      if (!current || !next || current.isRemoved || next.isRemoved) return
      const target = clampGapTargetMs(targetGapMs)
      const sourceGapMs = Math.max(0, Math.round((next.startTime - current.endTime) * 1000))
      if (target >= sourceGapMs) {
        get().restoreGaps([afterWordId])
        return
      }
      applyEdit((live) => {
        const byWord = new Map(live.gapEdits.map((edit) => [edit.afterWordId, edit]))
        byWord.set(afterWordId, { afterWordId, targetGapMs: target })
        const gapEdits = live.words
          .map((word) => byWord.get(word.id))
          .filter((edit): edit is GapEdit => Boolean(edit))
        return {
          gapEdits,
          shortenedGapIds: shortenedIdsFor(gapEdits),
          cleanupKeepGapIds: live.cleanupKeepGapIds.filter((id) => id !== afterWordId),
        }
      })
    },

    previewCleanup: (kind) => {
      const state = get()
      if (state.status !== 'ready' || !state.words.length) return
      const correlationId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().split('-').join('')
        : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, 32).padEnd(32, '0')
      try {
        const cleanupPreview = runCleanup(
          kind,
          state.words,
          state.shortenedGapIds,
          state.collapsedRetakes,
          state.cleanupKeepWordIds,
          state.cleanupKeepGapIds,
          cleanupOptionsFor(state),
        )
        if (kind === 'retakes' && state.projectId && cleanupPreview.retakeDiagnostics) {
          const diagnostics = cleanupPreview.retakeDiagnostics
          reportRetakeAnalysis({
            correlationId,
            projectId: state.projectId,
            mediaAssetId: state.projectId,
            jobId: correlationId,
            jobStatus: 'completed',
            stage: 'retake-preview',
            transcriptRevision: savedServerRevision ?? 0,
            wordCount: diagnostics.analyzedWordCount,
            sourceStart: diagnostics.sourceStart,
            sourceEnd: diagnostics.sourceEnd,
            sourceDuration: state.sourceDuration,
            processedDuration: state.duration,
            sourceSampleRate: state.sourceSampleRate,
            sourceChannels: state.sourceChannels,
            // Preview is transcript-only; a rendered media format is not known yet.
            processedSampleRate: null,
            processedChannels: null,
            candidateWindows: diagnostics.candidateWindows,
            rejected: diagnostics.rejected,
            groups: diagnostics.groups,
            suggestions: cleanupPreview.proposals.length,
            noiseReduction: state.noiseReduction,
            exceptionType: null,
            exceptionLocation: null,
          })
          console.info('[ScriptSurgeon retake analysis]', {
            correlationId,
            projectId: state.projectId,
            candidateWindows: diagnostics.candidateWindows,
            rejected: diagnostics.rejected,
            groups: diagnostics.groups,
            suggestions: cleanupPreview.proposals.length,
          })
        }
        set({ cleanupPreview, focusedCleanupProposalId: null, lastCleanup: null })
      } catch (error) {
        console.error('[ScriptSurgeon retake analysis failed]', { correlationId, error })
        if (kind === 'retakes' && state.projectId) {
          reportRetakeAnalysis({
            correlationId,
            projectId: state.projectId,
            mediaAssetId: state.projectId,
            jobId: correlationId,
            jobStatus: 'failed',
            stage: 'retake-preview',
            transcriptRevision: savedServerRevision ?? 0,
            wordCount: state.words.length,
            sourceStart: 0,
            sourceEnd: state.sourceDuration,
            sourceDuration: state.sourceDuration,
            processedDuration: state.duration,
            sourceSampleRate: state.sourceSampleRate,
            sourceChannels: state.sourceChannels,
            processedSampleRate: null,
            processedChannels: null,
            candidateWindows: 0,
            rejected: {},
            groups: 0,
            suggestions: 0,
            noiseReduction: state.noiseReduction,
            exceptionType: retakeDiagnosticExceptionType(error),
            exceptionLocation: 'retake-preview',
          })
        }
        get().reportError(`Cleanup analysis could not be completed (reference ${correlationId.slice(0, 8)}).`)
      }
    },

    openCleanupWorkbench: (kind) => {
      get().previewCleanup(kind)
      if (get().cleanupPreview) {
        set({ cleanupWorkbenchOpen: true, cleanupWorkbenchFilter: 'all', focusedCleanupProposalId: null })
      }
    },

    closeCleanupWorkbench: () => set({
      cleanupWorkbenchOpen: false,
      cleanupPreview: null,
      focusedCleanupProposalId: null,
    }),

    setCleanupWorkbenchFilter: (cleanupWorkbenchFilter) => set({ cleanupWorkbenchFilter }),

    focusCleanupProposal: (proposalId) => {
      const state = get()
      const proposal = state.cleanupPreview?.proposals.find((candidate) => candidate.id === proposalId)
      if (!proposal) {
        set({ focusedCleanupProposalId: null })
        return
      }
      const timeline = buildTimeline(
        state.words,
        new Set(state.shortenedGapIds),
        state.sourceDuration,
        state.insertClips,
        gapTargetsFromEdits(state.gapEdits),
      )
      const time = state.audioPreviewMode === 'original'
        ? proposal.startTime
        : sourceRangeToEdited(timeline, proposal.startTime, proposal.endTime).start
      player.get()?.setTime(time)
      set({ focusedCleanupProposalId: proposalId, playTime: time })
    },

    auditionCleanupProposal: (proposalId) => {
      const state = get()
      const proposal = state.cleanupPreview?.proposals.find((candidate) => candidate.id === proposalId)
      if (!proposal || !state.waveformReady || state.rendering) return
      const choice = state.cleanupPreview?.retakeCandidateChoices[proposalId]
      if (proposal.retakeGroup && !choice) return
      const cuts = proposal.retakeGroup
        ? proposal.retakeGroup.candidates.filter(c => c.id !== choice).map(c => ({ start: c.startTime, end: c.endTime }))
        : [{ start: proposal.previewStart, end: proposal.previewEnd }]
      const ranges = cuts.map(cut => state.audioPreviewMode === 'original'
        ? cut
        : sourceRangeToEdited(
          buildTimeline(
            state.words,
            new Set(state.shortenedGapIds),
            state.sourceDuration,
            state.insertClips,
            gapTargetsFromEdits(state.gapEdits),
          ),
          cut.start,
          cut.end,
        ))
      player.auditionCuts(ranges)
      set({ focusedCleanupProposalId: proposalId })
    },

    auditionRetakeCandidate: (proposalId, candidateId) => {
      const state = get()
      const candidate = state.cleanupPreview?.proposals
        .find((proposal) => proposal.id === proposalId)
        ?.retakeGroup?.candidates
        .find((item) => item.id === candidateId)
      if (!candidate || !state.waveformReady || state.rendering) return
      const range = state.audioPreviewMode === 'original'
        ? { start: candidate.startTime, end: candidate.endTime }
        : sourceRangeToEdited(
          buildTimeline(
            state.words,
            new Set(state.shortenedGapIds),
            state.sourceDuration,
            state.insertClips,
            gapTargetsFromEdits(state.gapEdits),
          ),
          candidate.startTime,
          candidate.endTime,
        )
      player.auditionRange(range.start, range.end)
      set({ focusedCleanupProposalId: proposalId })
    },

    setCleanupSelection: (proposalIds) => {
      const preview = get().cleanupPreview
      if (!preview) return
      const known = new Set(preview.proposals.map((proposal) => proposal.id))
      set({ cleanupPreview: withCleanupSelection(preview, [...new Set(proposalIds)].filter((id) => known.has(id))) })
    },

    selectRetakeCandidate: (proposalId, candidateId) => {
      const preview = get().cleanupPreview
      if (!preview) return
      set({ cleanupPreview: selectRetakeCandidate(preview, proposalId, candidateId), focusedCleanupProposalId: proposalId })
    },

    selectHighConfidenceCleanup: () => {
      const preview = get().cleanupPreview
      if (!preview) return
      get().setCleanupSelection(preview.proposals
        .filter((proposal) => proposal.confidence === 'high')
        .map((proposal) => proposal.id))
    },

    ignoreCleanupProposal: (proposalId) => {
      const preview = get().cleanupPreview
      const proposal = preview?.proposals.find((candidate) => candidate.id === proposalId)
      if (!preview || !proposal) return
      const ignoredWordIds = proposal.retakeGroup
        ? proposal.retakeGroup.candidates.flatMap((candidate) => candidate.wordIds)
        : proposal.wordIds
      const ignoredGapIds = proposal.gapWordId ? [proposal.gapWordId] : []
      applyEdit((state) => ({
        cleanupKeepWordIds: [...new Set([...state.cleanupKeepWordIds, ...ignoredWordIds])],
        cleanupKeepGapIds: [...new Set([...state.cleanupKeepGapIds, ...ignoredGapIds])],
      }), false)
      const current = get()
      set({
        cleanupPreview: runCleanup(
          preview.kind,
          current.words,
          current.shortenedGapIds,
          current.collapsedRetakes,
          current.cleanupKeepWordIds,
          current.cleanupKeepGapIds,
          cleanupOptionsFor(current),
        ),
        lastCleanup: null,
      })
    },

    applyCleanup: () => {
      const preview = get().cleanupPreview
      if (!preview) return
      const current = get()
      const applied = applyCleanupProposals(
        preview.kind,
        current.words,
        current.shortenedGapIds,
        current.collapsedRetakes,
        preview.proposals,
        preview.selectedProposalIds,
        preview.retakeCandidateChoices,
      )
      const appliedCount = applied.selectedSummary[preview.kind]
      if (!appliedCount) {
        set({ cleanupPreview: null })
        return
      }
      const appliedProposalIds = new Set(applied.appliedProposalIds)
      const appliedWordIds = new Set(preview.proposals
        .filter((proposal) => appliedProposalIds.has(proposal.id))
        .flatMap((proposal) => {
          const keepId = preview.retakeCandidateChoices[proposal.id]
            ?? proposal.retakeGroup?.recommendedCandidateId
          return proposal.retakeGroup
            ? proposal.retakeGroup.candidates
              .filter((candidate) => candidate.id !== keepId)
              .flatMap((candidate) => candidate.wordIds)
            : proposal.wordIds
        }))
      const appliedGapIds = new Set(preview.proposals
        .filter((proposal) => appliedProposalIds.has(proposal.id))
        .map((proposal) => proposal.gapWordId)
        .filter((id): id is string => Boolean(id)))
      const newRetakeGroups: RetakeGroupState[] = preview.kind === 'retakes'
        ? preview.proposals
          .filter((proposal) => appliedProposalIds.has(proposal.id) && proposal.retakeGroup)
          .flatMap((proposal) => {
            const group = proposal.retakeGroup!
            const recommendedKeepIndex = Math.max(0, group.candidates.findIndex((candidate) => candidate.id === group.recommendedCandidateId))
            const chosenCandidateId = preview.retakeCandidateChoices[proposal.id] ?? group.recommendedCandidateId
            const selectedKeepIndex = Math.max(0, group.candidates.findIndex((candidate) => candidate.id === chosenCandidateId))
            return [{
              id: randomHexId(),
              candidates: group.candidates.map((candidate) => [...candidate.wordIds]),
              recommendedKeepIndex,
              selectedKeepIndex,
            }]
          })
        : []
      applyEdit((state) => {
        const targetById = new Map(state.gapEdits.map((edit) => [edit.afterWordId, edit.targetGapMs]))
        preview.proposals
          .filter((proposal) => appliedProposalIds.has(proposal.id) && proposal.gapWordId)
          .forEach((proposal) => targetById.set(
            proposal.gapWordId!,
            clampGapTargetMs(proposal.targetGapMs ?? state.gapPacing.targetGapMs),
          ))
        const gapEdits = applied.shortenedGapIds.map((afterWordId) => ({
          afterWordId,
          targetGapMs: targetById.get(afterWordId) ?? DEFAULT_GAP_PACING.targetGapMs,
        }))
        return {
          words: applied.words,
          gapEdits,
          shortenedGapIds: shortenedIdsFor(gapEdits),
          collapsedRetakes: applied.collapsedRetakes,
          retakeGroups: newRetakeGroups.length
            ? [...state.retakeGroups, ...newRetakeGroups]
            : state.retakeGroups,
          cleanupKeepWordIds: state.cleanupKeepWordIds.filter((id) => !appliedWordIds.has(id)),
          cleanupKeepGapIds: state.cleanupKeepGapIds.filter((id) => !appliedGapIds.has(id)),
          cleanupPreview: null,
          cleanupWorkbenchOpen: false,
          focusedCleanupProposalId: null,
          lastCleanup: { kind: preview.kind, summary: applied.selectedSummary },
          selAnchor: null,
          selFocus: null,
        }
      })
      cleanupTimer = clearTimer(cleanupTimer)
      if (preview.kind !== 'retakes') cleanupTimer = setTimeout(() => set({ lastCleanup: null }), 6000)
    },

    cancelCleanup: () => set({ cleanupPreview: null, cleanupWorkbenchOpen: false, focusedCleanupProposalId: null }),

    correctWord: (id, text) => {
      const correction = text.trim().slice(0, 500)
      if (!correction) return
      const existing = get().words.find((word) => word.id === id)
      if (!existing || existing.text === correction) return
      const retakeIds = new Set(get().collapsedRetakes.flat())
      applyEdit((state) => ({
        words: state.words.map((word) => (word.id === id
          ? { ...word, text: correction, isFiller: false, isRetake: retakeIds.has(word.id) }
          : word)),
        retakeGroups: state.retakeGroups.filter((group) => !group.candidates.some((candidate) => candidate.includes(id))),
      }), false)
    },

    addRecording: async (file, text, afterWordId, requestedSourceTime) => {
      const transcript = text.trim()
      const state = get()
      const projectId = state.projectId
      const generation = lifecycleGeneration
      if (!projectId || state.status !== 'ready') throw new Error('Open a ready project before inserting audio.')
      if (!transcript) throw new Error('Enter the words spoken in this recording.')
      const anchorWord = afterWordId ? state.words.find((word) => word.id === afterWordId) : null
      if (afterWordId && !anchorWord) throw new Error('The transcript insertion point is no longer available.')
      const sourceTime = Number.isFinite(requestedSourceTime)
        ? Math.max(0, Math.min(state.sourceDuration, Number(requestedSourceTime)))
        : anchorWord?.endTime ?? 0
      set({ recordingBusy: true, operationError: '' })
      try {
        const uploaded = await api.uploadRecording(projectId, file, lifecycleController.signal)
        if (!sameContext(generation, projectId)) return
        const clip: InsertClip = {
          id: randomHexId(),
          clipId: uploaded.clipId,
          sourceTime,
          duration: uploaded.duration,
          text: transcript.slice(0, 500),
          afterWordId,
          isRemoved: false,
        }
        applyEdit((current) => ({ insertClips: [...current.insertClips, clip], recordingBusy: false }))
      } catch (error) {
        if (!isAbort(error) && sameContext(generation, projectId)) {
          set({ recordingBusy: false, operationError: `The recording could not be inserted. ${errorText(error, 'Try again.')}` })
        }
        throw error
      } finally {
        if (sameContext(generation, projectId)) set({ recordingBusy: false })
      }
    },

    replaceRecording: async (insertId, file, text) => {
      const state = get()
      const projectId = state.projectId
      const generation = lifecycleGeneration
      if (!projectId || state.status !== 'ready') throw new Error('Open a ready project before replacing audio.')
      if (!state.insertClips.some((clip) => clip.id === insertId)) throw new Error('That inserted recording no longer exists.')
      const transcript = text?.trim()
      if (text !== undefined && !transcript) throw new Error('Enter the words spoken in this recording.')
      set({ recordingBusy: true, operationError: '' })
      try {
        const uploaded = await api.uploadRecording(projectId, file, lifecycleController.signal)
        if (!sameContext(generation, projectId)) return
        applyEdit((current) => ({
          insertClips: current.insertClips.map((clip) => (clip.id === insertId
            ? {
                ...clip,
                clipId: uploaded.clipId,
                duration: uploaded.duration,
                text: transcript?.slice(0, 500) ?? clip.text,
                isRemoved: false,
              }
            : clip)),
          recordingBusy: false,
        }))
      } catch (error) {
        if (!isAbort(error) && sameContext(generation, projectId)) {
          set({ recordingBusy: false, operationError: `The take could not be replaced. ${errorText(error, 'Try again.')}` })
        }
        throw error
      } finally {
        if (sameContext(generation, projectId)) set({ recordingBusy: false })
      }
    },

    correctInsertText: (insertId, text) => {
      const correction = text.trim().slice(0, 500)
      if (!correction) return
      const existing = get().insertClips.find((clip) => clip.id === insertId)
      if (!existing || existing.text === correction) return
      applyEdit((state) => ({
        insertClips: state.insertClips.map((clip) => (clip.id === insertId ? { ...clip, text: correction } : clip)),
      }), false)
    },

    removeInsert: (insertId) => {
      if (!get().insertClips.some((clip) => clip.id === insertId && !clip.isRemoved)) return
      applyEdit((state) => ({
        insertClips: state.insertClips.map((clip) => (clip.id === insertId ? { ...clip, isRemoved: true } : clip)),
      }))
    },

    restoreInsert: (insertId) => {
      if (!get().insertClips.some((clip) => clip.id === insertId && clip.isRemoved)) return
      applyEdit((state) => ({
        insertClips: state.insertClips.map((clip) => (clip.id === insertId ? { ...clip, isRemoved: false } : clip)),
      }))
    },

    toggleStudio: () => applyEdit((state) => ({ studioSound: !state.studioSound })),

    toggleNormalize: () => applyEdit((state) => ({ normalizeLoudness: !state.normalizeLoudness })),

    // Speaker changes are text-only metadata, so they never trigger a re-render
    // of the audio (applyEdit's second argument is the renderAudio flag).
    addSpeaker: (name: string) => {
      const trimmed = name.trim().slice(0, 60)
      if (!trimmed) return null
      const existing = get().speakers.find((speaker) => speaker.name.toLowerCase() === trimmed.toLowerCase())
      if (existing) return existing.id
      if (get().speakers.length >= 64) {
        set({ operationError: 'A project can hold at most 64 speakers.' })
        return null
      }
      const id = randomHexId().slice(0, 8)
      applyEdit((state) => ({ speakers: [...state.speakers, { id, name: trimmed }] }), false)
      return id
    },

    renameSpeaker: (speakerId: string, name: string) => {
      const trimmed = name.trim().slice(0, 60)
      if (!trimmed) return
      const current = get().speakers.find((speaker) => speaker.id === speakerId)
      if (!current || current.name === trimmed) return
      if (get().speakers.some((speaker) => speaker.id !== speakerId && speaker.name.toLowerCase() === trimmed.toLowerCase())) {
        set({ operationError: 'Speaker names must be unique within a project.' })
        return
      }
      applyEdit((state) => ({
        speakers: state.speakers.map((speaker) => (
          speaker.id === speakerId ? { ...speaker, name: trimmed } : speaker
        )),
      }), false)
    },

    assignSpeaker: (wordId: string, speakerId: string | null) => {
      const current = get()
      if (!current.words.some((word) => word.id === wordId)) return
      if (speakerId !== null && !current.speakers.some((speaker) => speaker.id === speakerId)) return
      if ((current.speakerByWord[wordId] ?? null) === speakerId) return
      applyEdit((state) => {
        const next = { ...state.speakerByWord }
        if (speakerId && state.speakers.some((speaker) => speaker.id === speakerId)) next[wordId] = speakerId
        else delete next[wordId]
        return { speakerByWord: next }
      }, false)
    },

    addMarker: (kind, title, anchor, end) => {
      const state = get()
      if (!state.projectId || state.status !== 'ready') return null
      const cleanedTitle = title?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
      const existingOfKind = state.markers.filter((marker) => marker.kind === kind).length
      const marker: Marker = {
        id: randomHexId(),
        kind,
        title: cleanedTitle || (kind === 'chapter' ? `Chapter ${existingOfKind + 1}` : `Marker ${existingOfKind + 1}`),
        anchor: { ...(anchor || markerAnchorAtPlayhead(state)) },
        ...(end ? { end: { ...end } } : {}),
      }
      applyEdit((current) => ({ markers: [...current.markers, marker] }), false)
      return marker.id
    },

    updateMarker: (id, update) => {
      const current = get().markers.find((marker) => marker.id === id)
      if (!current) return
      const title = update.title === undefined
        ? current.title
        : update.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
      if (!title) return
      applyEdit((state) => ({
        markers: state.markers.map((marker) => marker.id === id
          ? {
              ...marker,
              ...update,
              title,
              ...(update.anchor ? { anchor: { ...update.anchor } } : {}),
              ...(update.end ? { end: { ...update.end } } : update.end === undefined ? {} : { end: undefined }),
            }
          : marker),
      }), false)
    },

    deleteMarker: (id) => {
      if (!get().markers.some((marker) => marker.id === id)) return
      applyEdit((state) => ({ markers: state.markers.filter((marker) => marker.id !== id) }), false)
    },

    seekMarker: (id) => {
      const state = get()
      const model = buildTimeline(
        state.words,
        new Set(state.shortenedGapIds),
        state.sourceDuration,
        state.insertClips,
        gapTargetsFromEdits(state.gapEdits),
      )
      const marker = resolveMarkers(state.markers, model).find((item) => item.marker.id === id)
      if (!marker) return
      const time = state.audioPreviewMode === 'original' ? marker.sourceTime : marker.editedTime
      player.get()?.setTime(time)
      set({ playTime: time })
    },

    exportChapter: async (id, format = 'wav') => {
      const state = get()
      if (!state.projectId || state.status !== 'ready') return
      const timeline = buildTimeline(
        state.words,
        new Set(state.shortenedGapIds),
        state.sourceDuration,
        state.insertClips,
        gapTargetsFromEdits(state.gapEdits),
      )
      const chapters = resolveChapterRanges(state.markers, timeline)
      const index = chapters.findIndex((chapter) => chapter.id === id)
      const chapter = index >= 0 ? chapters[index] : undefined
      if (!chapter || chapter.end - chapter.start < 0.01) {
        set({ operationError: 'This chapter has no editable audio range to export.' })
        return
      }
      const safeTitle = chapter.title
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
      await get().exportProject(
        format,
        { start: chapter.start, end: chapter.end },
        `_chapter-${String(index + 1).padStart(2, '0')}${safeTitle ? `-${safeTitle}` : ''}`,
      )
    },

    hasEdits: () => {
      const state = get()
      return state.words.some((word) => word.isRemoved)
        || state.gapEdits.length > 0
        || state.collapsedRetakes.length > 0
        || state.insertClips.some((clip) => !clip.isRemoved)
    },

    // Undoes every timeline edit in one step. Audio processing settings
    // (Studio sound, noise, normalize) are preferences rather than edits, so
    // they are deliberately left alone. Recorded inserts are marked removed
    // rather than deleted, so their audio survives an undo.
    revertToOriginal: () => {
      if (!get().hasEdits()) return
      applyEdit((state) => ({
        words: state.words.map((word) => (word.isRemoved ? { ...word, isRemoved: false } : word)),
        insertClips: state.insertClips.map((clip) => (clip.isRemoved ? clip : { ...clip, isRemoved: true })),
        shortenedGapIds: [],
        gapEdits: [],
        collapsedRetakes: [],
        retakeGroups: [],
        cleanupKeepWordIds: [],
        cleanupKeepGapIds: [],
        selAnchor: null,
        selFocus: null,
      }))
    },

    setNoiseReduction: (level: NoiseLevel) => {
      if (get().noiseReduction === level) return
      applyEdit(() => ({ noiseReduction: level }))
    },

    undo: () => {
      const stack = get().undoStack
      if (!stack.length || get().status !== 'ready') return
      const previous = stack[stack.length - 1]
      const redoStack = [...get().redoStack, snapshot()].slice(-60)
      set({
        words: previous.words,
        insertClips: previous.insertClips,
        shortenedGapIds: previous.shortenedGapIds,
        gapEdits: previous.gapEdits,
        gapPacing: previous.gapPacing,
        collapsedRetakes: previous.collapsedRetakes,
        retakeGroups: previous.retakeGroups,
        cleanupKeepWordIds: previous.cleanupKeepWordIds,
        cleanupKeepGapIds: previous.cleanupKeepGapIds,
        studioSound: previous.studioSound,
        noiseReduction: previous.noiseReduction,
        normalizeLoudness: previous.normalizeLoudness,
        speakers: previous.speakers,
        speakerByWord: previous.speakerByWord,
        markers: previous.markers,
        undoStack: stack.slice(0, -1),
        redoStack,
        cleanupPreview: null,
        lastCleanup: null,
      })
      queuePersistence(true)
    },

    redo: () => {
      const stack = get().redoStack
      if (!stack.length || get().status !== 'ready') return
      const next = stack[stack.length - 1]
      const undoStack = [...get().undoStack, snapshot()].slice(-60)
      set({
        words: next.words,
        insertClips: next.insertClips,
        shortenedGapIds: next.shortenedGapIds,
        gapEdits: next.gapEdits,
        gapPacing: next.gapPacing,
        collapsedRetakes: next.collapsedRetakes,
        retakeGroups: next.retakeGroups,
        cleanupKeepWordIds: next.cleanupKeepWordIds,
        cleanupKeepGapIds: next.cleanupKeepGapIds,
        studioSound: next.studioSound,
        noiseReduction: next.noiseReduction,
        normalizeLoudness: next.normalizeLoudness,
        speakers: next.speakers,
        speakerByWord: next.speakerByWord,
        markers: next.markers,
        undoStack,
        redoStack: stack.slice(0, -1),
        cleanupPreview: null,
        lastCleanup: null,
      })
      queuePersistence(true)
    },

    shortenGapAtPlayhead: () => {
      const state = get()
      const shortened = new Set(state.shortenedGapIds)
      const targets = gapTargetsFromEdits(state.gapEdits)
      const timeline = buildTimeline(state.words, shortened, state.sourceDuration, state.insertClips, targets)
      const playTime = state.audioPreviewMode === 'original'
        ? sourceTimeToEditedNearest(timeline, state.playTime)
        : state.playTime
      const eligible = new Set(eligibleGapWordIds(
        state.words,
        state.gapPacing,
        state.speakerByWord,
        state.cleanupKeepGapIds,
      ))
      const gaps = editedGaps(state.words, shortened, state.sourceDuration, state.insertClips, targets)
        .filter((gap) => !gap.shortened && eligible.has(gap.wordId) && gap.origGap * 1000 > state.gapPacing.targetGapMs)
      const atPlayhead = gaps.find((gap) => playTime >= gap.editedStart - 0.03 && playTime <= gap.editedEnd + 0.03)
      const currentWord = wordAtEditedTime(state.words, shortened, playTime, state.sourceDuration, state.insertClips, targets)
      const afterCurrent = currentWord ? gaps.find((gap) => gap.wordId === currentWord.id) : undefined
      const target = atPlayhead || afterCurrent
      if (target) get().shortenGaps([target.wordId])
    },
  }
})
