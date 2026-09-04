import type { GapEdit, GapPacing, GapPreset, Word } from '../types'
import { detectGaps } from './cleanup.ts'

/**
 * Pure pacing policy helpers. These intentionally do not depend on project
 * state so the UI, cleanup detector, renderer contract, and tests can share
 * the same safe normalization rules.
 */

/** Validation bounds shared with the persisted-state/backend contract. */
export const GAP_TARGET_MIN_MS = 50
export const GAP_TARGET_MAX_MS = 2_000
export const GAP_DETECTION_MIN_MS = 200
export const GAP_DETECTION_MAX_MS = 5_000

export interface GapPacingPreset {
  /** Human-readable name suitable for a compact editor control. */
  label: string
  /** Only pauses at least this long are candidates for a bulk cleanup pass. */
  detectionThresholdMs: number
  /** The retained pause when a candidate is shortened. */
  targetGapMs: number
}

/**
 * Presets deliberately preserve today's behavior as the default: a gap must
 * be at least 800 ms before cleanup suggests reducing it to 300 ms.
 */
export const GAP_PRESETS: Record<GapPreset, GapPacingPreset> = {
  conversation: {
    label: 'Conversation',
    detectionThresholdMs: 1_150,
    targetGapMs: 500,
  },
  podcast: {
    label: 'Podcast',
    detectionThresholdMs: 800,
    targetGapMs: 300,
  },
  tight: {
    label: 'Tight',
    detectionThresholdMs: 550,
    targetGapMs: 180,
  },
  custom: {
    label: 'Custom',
    detectionThresholdMs: 800,
    targetGapMs: 300,
  },
}

/** Serialized project-state representation for per-gap overrides. */
export type GapTargetMap = Record<string, number>

/** Read-only inputs accepted by timeline helpers without forcing a storage shape. */
export type GapTargetLookup = Readonly<GapTargetMap> | ReadonlyMap<string, number> | null | undefined

export const DEFAULT_GAP_PACING: GapPacing = {
  preset: 'podcast',
  detectionThresholdMs: GAP_PRESETS.podcast.detectionThresholdMs,
  targetGapMs: GAP_PRESETS.podcast.targetGapMs,
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readTarget(targets: GapTargetLookup, wordId: string): number | undefined {
  if (!targets) return undefined
  if (typeof (targets as ReadonlyMap<string, number>).get === 'function') {
    return (targets as ReadonlyMap<string, number>).get(wordId)
  }
  return (targets as Readonly<GapTargetMap>)[wordId]
}

/** Clamp millisecond values once, at the user/state boundary. */
export function clampGapTargetMs(value: unknown, fallback = DEFAULT_GAP_PACING.targetGapMs): number {
  const safeFallback = finite(fallback) ? fallback : DEFAULT_GAP_PACING.targetGapMs
  const safe = finite(value) ? value : safeFallback
  return Math.round(Math.min(GAP_TARGET_MAX_MS, Math.max(GAP_TARGET_MIN_MS, safe)))
}

/** Clamp a detection threshold independently from the shorter target gap. */
export function clampGapDetectionThresholdMs(
  value: unknown,
  fallback = DEFAULT_GAP_PACING.detectionThresholdMs,
): number {
  const safeFallback = finite(fallback) ? fallback : DEFAULT_GAP_PACING.detectionThresholdMs
  const safe = finite(value) ? value : safeFallback
  return Math.round(Math.min(GAP_DETECTION_MAX_MS, Math.max(GAP_DETECTION_MIN_MS, safe)))
}

/**
 * Resolve a persisted pacing setting defensively. A custom target is allowed
 * with any named preset, so changing a preset never silently drops a manual
 * adjustment.
 */
export function normalizeGapPacing(value?: Partial<GapPacing> | null): GapPacing {
  const preset = value?.preset && value.preset in GAP_PRESETS
    ? value.preset
    : DEFAULT_GAP_PACING.preset
  const presetValues = GAP_PRESETS[preset]
  const targetGapMs = clampGapTargetMs(value?.targetGapMs, presetValues.targetGapMs)
  const rawThreshold = value?.detectionThresholdMs ?? presetValues.detectionThresholdMs
  return {
    preset,
    targetGapMs,
    // A detection threshold at or below the target has no useful shortening
    // effect. Keep it strictly above the target for backend validation parity.
    detectionThresholdMs: Math.max(targetGapMs + 1, clampGapDetectionThresholdMs(rawThreshold)),
  }
}

/** Return a named preset as a detached value safe for local form state. */
export function pacingForPreset(preset: GapPreset): GapPacing {
  const values = GAP_PRESETS[preset]
  return normalizeGapPacing({
    preset,
    detectionThresholdMs: values.detectionThresholdMs,
    targetGapMs: values.targetGapMs,
  })
}

/**
 * Read a selected gap's target in seconds for the timeline. Map entries only
 * override selected gaps; the caller still decides whether a gap is enabled.
 */
export function gapTargetSecondsFor(
  wordId: string,
  targets: GapTargetLookup,
  fallbackSeconds = DEFAULT_GAP_PACING.targetGapMs / 1_000,
): number {
  const fallbackMs = clampGapTargetMs(fallbackSeconds * 1_000)
  const requested = readTarget(targets, wordId)
  return clampGapTargetMs(requested, fallbackMs) / 1_000
}

/** Normalize a list of editor changes into a compact, serializable map. */
export function gapTargetsFromEdits(edits: readonly GapEdit[]): GapTargetMap {
  return normalizeGapEdits(edits).reduce<GapTargetMap>((targets, edit) => {
    targets[edit.afterWordId] = edit.targetGapMs
    return targets
  }, {})
}

/**
 * Canonicalize persisted edits while retaining their first appearance order.
 * Explicit edits win over legacy shortened IDs and later explicit values win
 * for a duplicated anchor without making its row jump in the editor.
 */
export function normalizeGapEdits(
  edits?: readonly GapEdit[] | null,
  legacyIds?: readonly string[] | null,
): GapEdit[] {
  const normalized: GapEdit[] = []
  const indexByWordId = new Map<string, number>()
  for (const candidate of edits ?? []) {
    const edit = (candidate ?? {}) as Partial<GapEdit>
    const afterWordId = typeof edit.afterWordId === 'string' ? edit.afterWordId.trim() : ''
    if (!afterWordId) continue
    const row: GapEdit = { afterWordId, targetGapMs: clampGapTargetMs(edit.targetGapMs) }
    const existing = indexByWordId.get(afterWordId)
    if (existing === undefined) {
      indexByWordId.set(afterWordId, normalized.length)
      normalized.push(row)
    } else {
      normalized[existing] = row
    }
  }
  for (const legacyId of legacyIds ?? []) {
    const afterWordId = typeof legacyId === 'string' ? legacyId.trim() : ''
    if (!afterWordId || indexByWordId.has(afterWordId)) continue
    indexByWordId.set(afterWordId, normalized.length)
    normalized.push({ afterWordId, targetGapMs: DEFAULT_GAP_PACING.targetGapMs })
  }
  return normalized
}

/** Read a target map as editor-friendly rows in stable caller-provided order. */
export function gapEditsForWordIds(wordIds: readonly string[], targets: GapTargetLookup): GapEdit[] {
  return wordIds.flatMap((wordId) => {
    const targetGapMs = readTarget(targets, wordId)
    return targetGapMs === undefined ? [] : [{ afterWordId: wordId, targetGapMs: clampGapTargetMs(targetGapMs) }]
  })
}

/**
 * Resolve the source anchors that are safe to shorten under the active pacing
 * policy.  Cleanup review and direct timeline actions deliberately share this
 * decision so a keyboard or waveform action cannot bypass speaker, sentence,
 * cadence, or user-kept-pause safeguards.
 */
export function eligibleGapWordIds(
  words: Word[],
  pacing?: Partial<GapPacing> | null,
  speakerByWord?: Record<string, string>,
  keepIds: Iterable<string> = [],
): string[] {
  const normalized = normalizeGapPacing(pacing)
  return detectGaps(words, new Set<string>(), new Set(keepIds), {
    speakerByWord,
    gapThresholdMs: normalized.detectionThresholdMs,
    gapTargetMs: normalized.targetGapMs,
  }).ids
}
