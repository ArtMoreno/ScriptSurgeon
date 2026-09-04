export interface Word {
  id: string
  text: string
  startTime: number
  endTime: number
  isFiller: boolean
  isRetake: boolean
  isRemoved: boolean
  gapAfter: number
  /** Optional word-level ASR probability when the local transcriber exposes it. */
  asrConfidence?: number
}

export interface InsertClip {
  /** Stable edit identity. Re-recording changes clipId, not this ID. */
  id: string
  /** Immutable, project-local audio asset returned by the backend. */
  clipId: string
  /** Placement on the untouched source timeline, in seconds. */
  sourceTime: number
  duration: number
  text: string
  /** Transcript presentation anchor; rendering always uses sourceTime. */
  afterWordId: string | null
  isRemoved: boolean
}

export type ProjectStatus = 'queued' | 'transcribing' | 'ready' | 'error' | 'cancelled'

export interface ProjectMeta {
  id: string
  name: string
  duration: number | null
  sampleRate: number | null
  /** Original media channel count when the importer could read it. */
  channels?: number | null
  status?: ProjectStatus
}

export interface Speaker {
  id: string
  name: string
}

export type NoiseLevel = 'off' | 'light' | 'medium' | 'strong'

export type ExportFormat = 'wav' | 'mp3'

export type TranscriptFormat = 'srt' | 'vtt' | 'txt'

/** A project-local pacing choice. Existing edits retain their own exact target. */
export type GapPreset = 'conversation' | 'podcast' | 'tight' | 'custom'

export interface GapPacing {
  preset: GapPreset
  /** Minimum source pause eligible for a new suggestion, in whole milliseconds. */
  detectionThresholdMs: number
  /** Room tone retained by a newly applied gap edit, in whole milliseconds. */
  targetGapMs: number
}

/** A reversible, exact pause edit anchored after a source word. */
export interface GapEdit {
  afterWordId: string
  targetGapMs: number
}

/**
 * A resolved, local retake decision. Candidates remain as source word IDs so a
 * user can reopen the project, restore the group, or switch the retained take
 * without re-running a heuristic.
 */
export interface RetakeGroupState {
  id: string
  candidates: string[][]
  recommendedKeepIndex: number
  selectedKeepIndex: number
}

/** A marker is anchored to source material so it survives ripple edits. */
export interface MarkerAnchor {
  sourceTime: number
  /** Present only for an anchor that belongs inside a recorded insert. */
  insertId?: string | null
  insertOffset?: number | null
}

export interface Marker {
  id: string
  title: string
  kind: 'marker' | 'chapter'
  anchor: MarkerAnchor
  /** Range markers are metadata only; chapter ranges end at the next chapter. */
  end?: MarkerAnchor
}

export interface ProjectState {
  words: Word[]
  insertClips?: InsertClip[]
  /** Canonical pause edits. shortenedGapIds remains for older project files. */
  gapEdits?: GapEdit[]
  gapPacing?: GapPacing
  shortenedGapIds: string[]
  studioSound: boolean
  noiseReduction: NoiseLevel
  normalizeLoudness: boolean
  speakers?: Speaker[]
  /** wordId -> speakerId, recorded only where the speaker changes. */
  speakerByWord?: Record<string, string>
  collapsedRetakes: string[][]
  /** Durable alternate-take choices; collapsedRetakes is the legacy projection. */
  retakeGroups?: RetakeGroupState[]
  cleanupKeepWordIds?: string[]
  cleanupKeepGapIds?: string[]
  /** Local metadata; never changes rendered audio. */
  markers?: Marker[]
  revision?: number
}

export interface StatusPayload {
  status?: ProjectStatus
  progress?: number
  error?: string
  stage?: string
  message?: string
}

export interface CleanupSummary {
  fillers: number
  gaps: number
  retakes: number
}

/**
 * A delivery target the backend can produce from the edited timeline. The set
 * is served rather than hard-coded, so adding a target needs no frontend
 * change, and targets that are registered but unbuilt never reach the picker.
 */
export interface IntegrationTarget {
  id: string
  label: string
  summary: string
  extension: string
  requiresVideo: boolean
}
