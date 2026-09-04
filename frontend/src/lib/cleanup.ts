import type { CleanupSummary, Word } from '../types'

/**
 * Cleanup deliberately produces recommendations, not irreversible actions.
 * The UI can select, audition, ignore, and then apply individual proposals.
 */
export const GAP_THRESHOLD = 0.8
export const GAP_TARGET = 0.3
export const RETAKE_PAUSE = 1.5

const UNAMBIGUOUS_FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'erm'])
const AMBIGUOUS_FILLERS = new Set(['like', 'so', 'basically', 'literally', 'actually'])
const FILLER_PHRASES = ['you know', 'i mean']
const RETAKE_MARKERS = ['take two', 'take 2', 'let me redo that', 'start over', 'one more time', 'scratch that', 'sorry']

export type CleanupKind = 'fillers' | 'gaps' | 'retakes'
export type CleanupConfidence = 'high' | 'medium' | 'low'

/**
 * One contiguous spoken attempt within a retake recommendation.  Candidate
 * IDs are stable for the lifetime of a review result so a UI can safely keep
 * a user's choice while filters or the proposal list change.
 */
export interface RetakeCandidate {
  id: string
  label: string
  wordIds: string[]
  startTime: number
  endTime: number
  transcript: string
}

/**
 * A review-only choice between alternate takes.  `recommendedCandidateId`
 * is display guidance only; applying a retake always requires an explicit
 * candidate choice from the editor.
 */
export interface RetakeGroup {
  id: string
  candidates: RetakeCandidate[]
  recommendedCandidateId: string
  /** Plain-language evidence for the reviewer's suggested take. */
  recommendationReason: string
}

export interface CleanupProposal {
  id: string
  kind: CleanupKind
  /** Words removed by a filler or retake recommendation. Empty for a gap. */
  wordIds: string[]
  /** The word immediately before a proposed shortened gap. */
  gapWordId?: string
  startTime: number
  endTime: number
  /** The portion skipped by the local audition; gaps retain room tone at both edges. */
  previewStart: number
  previewEnd: number
  confidence: CleanupConfidence
  reason: string
  context: string
  originalGapMs?: number
  targetGapMs?: number
  /** The following words the retake heuristic recommends keeping. */
  recommendedKeepIds?: string[]
  /** Present for retake proposals with two reviewable alternate takes. */
  retakeGroup?: RetakeGroup
  /** Word values that must still match when a reviewed proposal is applied. */
  sourceWords: Array<Pick<Word, 'id' | 'text' | 'startTime' | 'endTime'>>
}

export interface CleanupOptions {
  gapThresholdMs?: number
  gapTargetMs?: number
  speakerByWord?: Record<string, string>
  /**
   * Optional ASR word-confidence metadata in the inclusive 0..1 range.
   * Missing values retain the conservative lexical fallback; low values only
   * suppress or downgrade a suggestion and are never treated as audio proof.
   */
  wordConfidenceById?: Record<string, number>
  /**
   * Legacy optional, externally supplied speech-likelihood hint. It is used
   * only as a conservative suppression signal; cleanup does not run VAD or
   * make an acoustic speech/no-speech claim.
   */
  speechProbabilityById?: Record<string, number>
}

export interface CleanupFeedback {
  kind: CleanupKind
  summary: CleanupSummary
}

/**
 * Count-only local evidence for an empty review result. It intentionally
 * carries no transcript text, filenames, or media paths.
 */
export interface RetakeDiagnostics {
  analyzedWordCount: number
  sourceStart: number
  sourceEnd: number
  candidateWindows: number
  rejected: Record<string, number>
  groups: number
}

/**
 * Why a gap review came back empty. A pause the user can see in the transcript
 * but that was not proposed needs an explanation, or the feature reads as broken.
 */
export interface GapDiagnostics {
  /** Pauses longer than the detection threshold, before any safeguard ran. */
  overThreshold: number
  /** Of those, the ones a safeguard or an earlier choice held back. */
  skipped: {
    sentenceBoundary: number
    speakerChange: number
    slowDelivery: number
    alreadyShortened: number
    kept: number
  }
}

export interface CleanupResult {
  kind: CleanupKind
  /** Immutable in-memory baseline used only to redraw this review dialog. */
  previewBaseWords: Word[]
  previewBaseShortenedGapIds: string[]
  previewBaseCollapsedRetakes: string[][]
  words: Word[]
  shortenedGapIds: string[]
  collapsedRetakes: string[][]
  /** All suggestions found in the current transcript. */
  summary: CleanupSummary
  /** Suggestions selected for the reversible preview/apply action. */
  selectedSummary: CleanupSummary
  proposals: CleanupProposal[]
  selectedProposalIds: string[]
  /** proposalId -> candidateId for user-selected retake alternatives. */
  retakeCandidateChoices: Record<string, string>
  /** Present for a retake review so an empty result is explainable. */
  retakeDiagnostics?: RetakeDiagnostics
  /** Present for a gap review, for the same reason. */
  gapDiagnostics?: GapDiagnostics
}

export interface CleanupApplication {
  words: Word[]
  shortenedGapIds: string[]
  collapsedRetakes: string[][]
  selectedSummary: CleanupSummary
  appliedProposalIds: string[]
}

function emptySummary(): CleanupSummary {
  return { fillers: 0, gaps: 0, retakes: 0 }
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9'\s]/g, '').trim()
}

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clampTime(value: number): number {
  return Math.max(0, finite(value))
}

function levenshtein(left: string, right: string): number {
  const m = left.length
  const n = right.length
  if (!m) return n
  if (!n) return m
  const row: number[] = Array.from({ length: n + 1 }, (_, index) => index)
  for (let index = 1; index <= m; index += 1) {
    let previous = row[0]
    row[0] = index
    for (let column = 1; column <= n; column += 1) {
      const current = row[column]
      row[column] = Math.min(
        row[column] + 1,
        row[column - 1] + 1,
        previous + (left[index - 1] === right[column - 1] ? 0 : 1),
      )
      previous = current
    }
  }
  return row[n]
}

function similarity(left: string, right: string): number {
  const maximum = Math.max(left.length, right.length)
  return maximum ? 1 - levenshtein(left, right) / maximum : 1
}

function contextFor(words: Word[], firstId: string, lastId = firstId): string {
  const first = words.findIndex((word) => word.id === firstId)
  const last = words.findIndex((word) => word.id === lastId)
  if (first < 0 || last < 0) return ''
  const from = Math.max(0, first - 3)
  const to = Math.min(words.length, Math.max(first, last) + 4)
  return words.slice(from, to).map((word) => word.text).join(' ')
}

/**
 * Speaker assignments are run-start markers, not a value repeated on every
 * word. Carry the most recent marker forward so cleanup never treats an
 * ordinary word immediately before a new speaker as an unlabeled boundary.
 */
function effectiveSpeakers(words: Word[], speakerByWord?: Record<string, string>): Map<string, string> {
  const byWord = new Map<string, string>()
  if (!speakerByWord) return byWord
  let current: string | undefined
  for (const word of words) {
    const marker = speakerByWord[word.id]
    if (marker !== undefined) current = marker
    if (current) byWord.set(word.id, current)
  }
  return byWord
}

function crossesSpeakerBoundary(words: Word[], byWord: Map<string, string>): boolean {
  let previous: string | undefined
  for (const word of words) {
    const current = byWord.get(word.id)
    if (previous && current && previous !== current) return true
    if (current) previous = current
  }
  return false
}

function proposalId(kind: CleanupKind, ids: string[], suffix = ''): string {
  return `${kind}:${ids.join(',')}${suffix}`
}

function proposalForWords(
  kind: 'fillers' | 'retakes',
  words: Word[],
  wordIds: string[],
  confidence: CleanupConfidence,
  reason: string,
  recommendedKeepIds?: string[],
  options: CleanupOptions = {},
): CleanupProposal | null {
  const selected = wordIds
    .map((id) => words.find((word) => word.id === id))
    .filter((word): word is Word => Boolean(word))
  if (!selected.length) return null
  const startTime = clampTime(selected[0].startTime)
  const endTime = Math.max(startTime, clampTime(selected[selected.length - 1].endTime))
  const id = proposalId(kind, wordIds)
  const retakeGroup = kind === 'retakes'
    ? retakeGroupForProposal(id, words, wordIds, recommendedKeepIds ?? [], options)
    : undefined
  return {
    id,
    kind,
    wordIds,
    startTime,
    endTime,
    previewStart: startTime,
    previewEnd: endTime,
    confidence,
    reason,
    context: contextFor(words, wordIds[0], wordIds[wordIds.length - 1]),
    recommendedKeepIds: retakeGroup
      ? retakeGroup.candidates.find((candidate) => candidate.id === retakeGroup.recommendedCandidateId)?.wordIds
      : recommendedKeepIds,
    retakeGroup,
    // A retake choice can remove either candidate. Keep a snapshot of both
    // alternatives so choosing the other take cannot overwrite a manual edit.
    sourceWords: retakeGroup
      ? sourceWordsFor(words, [...wordIds, ...retakeGroup.candidates.flatMap((candidate) => candidate.wordIds)])
      : selected.map(({ id, text, startTime, endTime }) => ({ id, text, startTime, endTime })),
  }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))]
}

function sourceWordsFor(words: Word[], ids: string[]): CleanupProposal['sourceWords'] {
  return uniqueIds(ids)
    .map((id) => words.find((word) => word.id === id))
    .filter((word): word is Word => Boolean(word))
    .map(({ id, text, startTime, endTime }) => ({ id, text, startTime, endTime }))
}

function retakeCandidateFor(
  words: Word[],
  id: string,
  label: string,
  wordIds: string[],
): RetakeCandidate | null {
  const selected = uniqueIds(wordIds)
    .map((wordId) => words.find((word) => word.id === wordId))
    .filter((word): word is Word => Boolean(word))
  if (!selected.length) return null
  const startTime = clampTime(selected[0].startTime)
  const endTime = Math.max(startTime, clampTime(selected[selected.length - 1].endTime))
  return {
    id,
    label,
    wordIds: selected.map((word) => word.id),
    startTime,
    endTime,
    transcript: selected.map((word) => word.text).join(' ').trim(),
  }
}

/**
 * A durable Retake group is a choice between mutually exclusive spoken
 * attempts. A word may belong to one attempt only; otherwise selecting or
 * restoring a take has no unambiguous meaning.
 */
export function retakeWordGroupsAreDisjoint(groups: readonly (readonly string[])[]): boolean {
  const seen = new Set<string>()
  for (const group of groups) {
    for (const id of group) {
      if (seen.has(id)) return false
      seen.add(id)
    }
  }
  return true
}

/**
 * Pairwise alignment can discover one physical attempt through multiple
 * overlapping windows (for example, a short prefix and a fuller completion).
 * Each original pair also gives us a reliable *between-take* boundary. Use
 * those boundaries to partition the candidate coverage instead of simply
 * unioning overlapping windows: a rapid B → C restart can otherwise be
 * collapsed into one incorrect B+C attempt.
 */
export function canonicalizeRetakeCandidateAttempts(
  words: Word[],
  rawPairs: readonly (readonly RetakeCandidate[])[],
): RetakeCandidate[] {
  const indexById = new Map(words.map((word, index) => [word.id, index]))
  const coverage = new Set<string>()
  const cuts = new Set<number>()

  for (const pair of rawPairs) {
    // `mergeRetakeChains` supplies the original two-sided alignments. Do not
    // attempt to infer a boundary from malformed data: that could turn a
    // corrupt preview into an ambiguous destructive edit.
    if (pair.length !== 2) return []
    const ranges = pair
      .map((candidate) => {
        const candidateIds = uniqueIds(candidate.wordIds)
        if (!candidateIds.length || candidateIds.length !== candidate.wordIds.length) return null
        const indices = candidateIds.map((id) => indexById.get(id))
        if (indices.some((index): index is undefined => index === undefined)) return null
        const orderedIndices = indices as number[]
        // Retake attempts are contiguous source spans. Reject a malformed
        // candidate rather than silently bridging unrelated transcript words.
        if (orderedIndices.some((index, position) => position > 0 && index !== orderedIndices[position - 1] + 1)) return null
        for (const id of candidateIds) coverage.add(id)
        return { start: orderedIndices[0], end: orderedIndices[orderedIndices.length - 1] }
      })
      .filter((range): range is { start: number; end: number } => Boolean(range))
      .sort((left, right) => left.start - right.start || left.end - right.end)

    if (ranges.length !== 2) return []

    // A raw pair itself is already ambiguous if its two choices overlap. Do
    // not turn that into a destructive review card.
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index - 1].end >= ranges[index].start) return []
      cuts.add(ranges[index].start)
    }
  }

  const candidates: RetakeCandidate[] = []
  let currentIds: string[] = []
  const finishAttempt = () => {
    if (!currentIds.length) return
    const candidate = retakeCandidateFor(words, 'attempt', 'Attempt', currentIds)
    if (candidate) candidates.push(candidate)
    currentIds = []
  }
  for (let index = 0; index < words.length; index += 1) {
    if (cuts.has(index)) finishAttempt()
    if (coverage.has(words[index].id)) currentIds.push(words[index].id)
    else finishAttempt()
  }
  finishAttempt()

  return candidates
    .filter((candidate): candidate is RetakeCandidate => Boolean(candidate))
    .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime || left.id.localeCompare(right.id))
    .map((candidate, index) => ({
      ...candidate,
      id: `retakes:${candidate.wordIds.join(',')}:take:${index + 1}`,
      label: `Take ${index + 1}`,
    }))
}

function retakeGroupForProposal(
  proposalIdValue: string,
  words: Word[],
  earlierIds: string[],
  laterIds: string[],
  options: CleanupOptions = {},
): RetakeGroup | undefined {
  const earlier = retakeCandidateFor(words, `${proposalIdValue}:earlier`, 'Earlier take', earlierIds)
  const later = retakeCandidateFor(words, `${proposalIdValue}:later`, 'Later take', laterIds)
  if (!earlier || !later) return undefined
  const earlierIdsSet = new Set(earlier.wordIds)
  if (later.wordIds.some((id) => earlierIdsSet.has(id))) return undefined
  const recommendation = recommendRetakeCandidate([earlier, later], options)
  return {
    id: `${proposalIdValue}:group`,
    candidates: [earlier, later],
    recommendedCandidateId: recommendation.candidate.id,
    recommendationReason: recommendation.reason,
  }
}

function sentenceComplete(candidate: RetakeCandidate): boolean {
  return /[.!?][”"')\]]*$/.test(candidate.transcript.trim())
}

function candidateConfidence(candidate: RetakeCandidate, options: CleanupOptions): number | undefined {
  const values = candidate.wordIds
    .map((id) => probability(options.wordConfidenceById?.[id]))
    .filter((value): value is number => value !== undefined)
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined
}

function candidateHasRestartMarker(candidate: RetakeCandidate): boolean {
  const normalized = candidate.transcript.split(/\s+/).map(norm).join(' ')
  return RETAKE_MARKERS.some((marker) => normalized.includes(marker))
}

function recommendRetakeCandidate(
  candidates: RetakeCandidate[],
  options: CleanupOptions = {},
): { candidate: RetakeCandidate; reason: string } {
  const longest = Math.max(1, ...candidates.map((candidate) => candidate.wordIds.length))
  const scored = candidates.map((candidate, index) => {
    const complete = sentenceComplete(candidate)
    const confidence = candidateConfidence(candidate, options)
    // Completion matters most. Length and optional ASR confidence break ties;
    // recency is deliberately a tiny final tie-breaker, never the rule.
    const score = (complete ? 2 : 0)
      + (candidate.wordIds.length / longest)
      + (confidence === undefined ? 0 : confidence * 0.25)
      - (candidateHasRestartMarker(candidate) ? 0.5 : 0)
      + index * 0.01
    return { candidate, complete, confidence, score, index }
  })
  const winner = [...scored].sort((left, right) => right.score - left.score || right.index - left.index)[0]
  const runnerUp = [...scored]
    .filter((candidate) => candidate.candidate.id !== winner.candidate.id)
    .sort((left, right) => right.score - left.score || right.index - left.index)[0]

  if (runnerUp && winner.complete !== runnerUp.complete) {
    return {
      candidate: winner.candidate,
      reason: `${winner.candidate.label} has a complete sentence ending; ${runnerUp.candidate.label} does not.`,
    }
  }
  if (runnerUp && winner.candidate.wordIds.length > runnerUp.candidate.wordIds.length) {
    return {
      candidate: winner.candidate,
      reason: `${winner.candidate.label} carries the more complete ${winner.candidate.wordIds.length}-word wording.`,
    }
  }
  if (runnerUp && winner.confidence !== undefined && runnerUp.confidence !== undefined && winner.confidence > runnerUp.confidence + 0.05) {
    return {
      candidate: winner.candidate,
      reason: `${winner.candidate.label} has stronger available transcript confidence.`,
    }
  }
  return {
    candidate: winner.candidate,
    reason: 'The attempts are equally complete; the later take is only a tie-breaker.',
  }
}

function probability(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

type FillerEvidence =
  | { status: 'suppressed' }
  | { status: 'uncertain'; reason: string }
  | { status: 'confirmed'; reason: string }
  | { status: 'unscored' }

/**
 * ASR confidence is a transcription-quality signal, not a detector for
 * speech or filler intent.  We use it only to make lexical cleanup safer:
 * clearly low-confidence tokens disappear from the proposal list, while
 * middle-confidence tokens stay review-only.
 */
function fillerEvidence(wordIds: string[], options: CleanupOptions): FillerEvidence {
  const confidences = wordIds
    .map((id) => probability(options.wordConfidenceById?.[id]))
    .filter((value): value is number => value !== undefined)
  const speechHints = wordIds
    .map((id) => probability(options.speechProbabilityById?.[id]))
    .filter((value): value is number => value !== undefined)

  const lowestConfidence = confidences.length ? Math.min(...confidences) : undefined
  const lowestSpeechHint = speechHints.length ? Math.min(...speechHints) : undefined
  if ((lowestConfidence !== undefined && lowestConfidence < 0.6)
    || (lowestSpeechHint !== undefined && lowestSpeechHint < 0.55)) {
    return { status: 'suppressed' }
  }
  if (lowestConfidence !== undefined && lowestConfidence < 0.8) {
    return {
      status: 'uncertain',
      reason: `ASR word confidence is ${percent(lowestConfidence)}, so this remains review-only`,
    }
  }
  if (lowestSpeechHint !== undefined && lowestSpeechHint < 0.75) {
    return {
      status: 'uncertain',
      reason: 'external speech-likelihood evidence is uncertain, so this remains review-only',
    }
  }
  if (lowestConfidence !== undefined) {
    return {
      status: 'confirmed',
      reason: `high ASR word confidence (${percent(lowestConfidence)}) supports this lexical suggestion`,
    }
  }
  return { status: 'unscored' }
}

function reasonWithEvidence(base: string, evidence: FillerEvidence): string {
  return evidence.status === 'unscored' || evidence.status === 'suppressed'
    ? base
    : `${base}; ${evidence.reason}`
}

function likelyFillerPhrase(words: Word[], index: number, phrase: string): boolean {
  const previous = words[index - 1]
  const following = words[index + phrase.split(' ').length]
  const nextToken = following ? norm(following.text) : ''
  if (phrase === 'you know') {
    // "You know the answer" is semantic. A mid-sentence aside is reviewable.
    return index > 0 && !['the', 'that', 'what', 'where', 'who', 'why', 'how'].includes(nextToken)
  }
  // "I mean it" often carries meaning; only surface a mid-sentence aside.
  return index > 0 && nextToken !== 'it' && Boolean(previous)
}

function likelyAmbiguousFiller(words: Word[], index: number): boolean {
  const token = norm(words[index]?.text ?? '')
  const previous = norm(words[index - 1]?.text ?? '')
  const next = norm(words[index + 1]?.text ?? '')
  if (token === 'like') {
    return ['was', 'were', 'is', 'are', 'am', 'felt', 'feel', 'sounds', 'sound'].includes(previous)
      && Boolean(next)
  }
  return token === 'so' && next === 'so'
}

function phraseAt(words: Word[], index: number, phrase: string, ignored: Set<string>): Word[] | null {
  const parts = phrase.split(' ')
  const candidate = words.slice(index, index + parts.length)
  if (candidate.length !== parts.length) return null
  return candidate.every((word, offset) => !word.isRemoved && !ignored.has(word.id) && norm(word.text) === parts[offset])
    ? candidate
    : null
}

/**
 * Mark only unequivocal vocalized fillers as high confidence. Context-sensitive
 * vocabulary stays out of the automatic default unless it is visibly repeated.
 */
export function detectFillers(
  words: Word[],
  keepIds = new Set<string>(),
  options: CleanupOptions = {},
): { words: Word[]; fillerIds: string[]; count: number; proposals: CleanupProposal[] } {
  const output = words.map((word) => ({ ...word }))
  const proposals: CleanupProposal[] = []
  const seen = new Set<string>()

  for (let index = 0; index < output.length; index += 1) {
    const word = output[index]
    if (word.isRemoved || keepIds.has(word.id) || seen.has(word.id)) continue
    const token = norm(word.text)

    if (UNAMBIGUOUS_FILLERS.has(token)) {
      const evidence = fillerEvidence([word.id], options)
      if (evidence.status !== 'suppressed') {
        const proposal = proposalForWords(
          'fillers',
          output,
          [word.id],
          evidence.status === 'uncertain' ? 'medium' : 'high',
          reasonWithEvidence('Vocalized filler sound', evidence),
        )
        if (proposal) proposals.push(proposal)
        seen.add(word.id)
        continue
      }
    }

    const phrase = FILLER_PHRASES.find((candidate) => phraseAt(output, index, candidate, keepIds))
    if (phrase && likelyFillerPhrase(output, index, phrase)) {
      const matched = phraseAt(output, index, phrase, keepIds)!
      const ids = matched.map((candidate) => candidate.id)
      const evidence = fillerEvidence(ids, options)
      if (evidence.status !== 'suppressed') {
        const proposal = proposalForWords(
          'fillers',
          output,
          ids,
          'medium',
          reasonWithEvidence('Common conversational filler phrase', evidence),
        )
        if (proposal) proposals.push(proposal)
        ids.forEach((id) => seen.add(id))
        index += matched.length - 1
        continue
      }
    }

    // "Like", "so", and similar words often carry meaning. Repeated use is
    // reviewable but never selected by default; isolated use is left untouched.
    const next = output[index + 1]
    if (AMBIGUOUS_FILLERS.has(token) && likelyAmbiguousFiller(output, index) && next && !next.isRemoved && !keepIds.has(next.id)) {
      const evidence = fillerEvidence([word.id], options)
      if (evidence.status !== 'suppressed') {
        const proposal = proposalForWords(
          'fillers',
          output,
          [word.id],
          'low',
          reasonWithEvidence('Context-sensitive filler word; review before removing', evidence),
        )
        if (proposal) proposals.push(proposal)
        seen.add(word.id)
      }
    }
  }

  const fillerIds = new Set(proposals.flatMap((proposal) => proposal.wordIds))
  fillerIds.forEach((id) => {
    const word = output.find((candidate) => candidate.id === id)
    if (word) word.isFiller = true
  })
  return { words: output, fillerIds: [...fillerIds], count: fillerIds.size, proposals }
}

function gapBoundaryReason(word: Word, next: Word, speakerChanged: boolean): { confidence: CleanupConfidence; reason: string } | null {
  const ending = word.text.trim()
  const sentenceBoundary = /[.!?]["')\]]*$/.test(ending)
  if (speakerChanged || sentenceBoundary) return null
  return { confidence: 'medium', reason: 'Long pause inside a continuous spoken passage' }
}

function localWordDuration(words: Word[], index: number): number {
  const nearby = words.slice(Math.max(0, index - 1), Math.min(words.length, index + 3))
    .filter((word) => !word.isRemoved)
    .map((word) => Math.max(0, clampTime(word.endTime) - clampTime(word.startTime)))
  return nearby.length ? nearby.reduce((sum, duration) => sum + duration, 0) / nearby.length : 0
}

export function detectGaps(
  words: Word[],
  already: Set<string>,
  keepIds = new Set<string>(),
  options: CleanupOptions = {},
): { ids: string[]; count: number; proposals: CleanupProposal[]; diagnostics: GapDiagnostics } {
  const threshold = Math.max(0.05, finite(options.gapThresholdMs ?? GAP_THRESHOLD * 1000, GAP_THRESHOLD * 1000) / 1000)
  const target = Math.max(0.05, finite(options.gapTargetMs ?? GAP_TARGET * 1000, GAP_TARGET * 1000) / 1000)
  const proposals: CleanupProposal[] = []
  const speakers = effectiveSpeakers(words, options.speakerByWord)
  const diagnostics: GapDiagnostics = {
    overThreshold: 0,
    skipped: { sentenceBoundary: 0, speakerChange: 0, slowDelivery: 0, alreadyShortened: 0, kept: 0 },
  }

  for (let index = 0; index < words.length - 1; index += 1) {
    const word = words[index]
    const next = words[index + 1]
    if (word.isRemoved || next.isRemoved) continue
    const gap = clampTime(next.startTime) - clampTime(word.endTime)
    if (gap <= threshold) continue
    // Counted before the safeguards so the empty-state copy can say how many
    // long pauses exist and which rule held each of them back.
    diagnostics.overThreshold += 1
    if (already.has(word.id)) { diagnostics.skipped.alreadyShortened += 1; continue }
    if (keepIds.has(word.id)) { diagnostics.skipped.kept += 1; continue }
    const speakerChanged = crossesSpeakerBoundary([word, next], speakers)
    const boundary = gapBoundaryReason(word, next, speakerChanged)
    if (!boundary) {
      if (speakerChanged) diagnostics.skipped.speakerChange += 1
      else diagnostics.skipped.sentenceBoundary += 1
      continue
    }
    // Slow, careful speech can legitimately contain longer word gaps. With no
    // acoustic model available, suppress these rather than making a weak guess.
    const cadenceFloor = Math.max(threshold, localWordDuration(words, index) * 4)
    if (gap <= cadenceFloor) { diagnostics.skipped.slowDelivery += 1; continue }
    const confidence = boundary.confidence === 'medium' && gap >= Math.max(threshold + 0.25, cadenceFloor + 0.15)
      ? 'high'
      : boundary.confidence
    const retained = Math.min(gap, target)
    const previewStart = clampTime(word.endTime) + retained / 2
    const previewEnd = Math.max(previewStart, clampTime(next.startTime) - retained / 2)
    proposals.push({
      id: proposalId('gaps', [word.id]),
      kind: 'gaps',
      wordIds: [],
      gapWordId: word.id,
      startTime: clampTime(word.endTime),
      endTime: clampTime(next.startTime),
      previewStart,
      previewEnd,
      confidence,
      reason: boundary.reason,
      context: contextFor(words, word.id, next.id),
      originalGapMs: Math.round(gap * 1000),
      targetGapMs: Math.round(retained * 1000),
      sourceWords: sourceWordsFor(words, [word.id, next.id]),
    })
  }

  return {
    ids: proposals.map((proposal) => proposal.gapWordId!).filter(Boolean),
    count: proposals.length,
    proposals,
    diagnostics,
  }
}

/**
 * One sentence explaining an empty gap review, in the app's own voice.
 *
 * Kept next to the detector so the wording and the safeguards it describes
 * cannot drift apart, and so it is testable without mounting the toolbar.
 */
export function describeEmptyGapReview(diagnostics: GapDiagnostics, thresholdMs: number): string {
  if (diagnostics.overThreshold === 0) {
    return `No pause in this transcript is longer than ${Math.round(thresholdMs)}ms, the current detection setting. Lower it in Pacing to catch shorter ones.`
  }

  const { sentenceBoundary, speakerChange, slowDelivery, alreadyShortened, kept } = diagnostics.skipped
  const reasons: string[] = []
  if (sentenceBoundary) reasons.push(`${sentenceBoundary} at a sentence end`)
  if (speakerChange) reasons.push(`${speakerChange} at a speaker change`)
  if (slowDelivery) reasons.push(`${slowDelivery} inside slow delivery`)
  if (alreadyShortened) reasons.push(`${alreadyShortened} already shortened`)
  if (kept) reasons.push(`${kept} you chose to keep`)

  const count = `${diagnostics.overThreshold} long pause${diagnostics.overThreshold === 1 ? ' was' : 's were'}`
  const because = reasons.length ? `: ${reasons.join(', ')}` : ''
  return `${count} left alone on purpose${because}. Shorten any of them yourself from its pause chip in the transcript, or press G at the playhead.`
}

function hasQuoteBoundary(words: Word[]): boolean {
  // Apostrophes inside normal lexical tokens (don't, team's) are not quote
  // delimiters. Treat only double quotes, curly double quotes, or single
  // quotes at a token boundary as quoted-language evidence.
  const phrase = words.map((word) => word.text.trim()).join(' ')
  return /[“”"]/.test(phrase) || /(?:^|\s)[‘']\S|\S[’'](?:\s|$)/u.test(phrase)
}

function hasSentenceBoundary(words: Word[]): boolean {
  return words.some((word) => /[.!?]["')\]]*$/.test(word.text.trim()))
}

function variedPhrase(words: Word[]): boolean {
  const unique = new Set(words.map((word) => norm(word.text)).filter(Boolean))
  return unique.size >= 2
}

interface RetakeAlignment {
  /** Number of normalized tokens shared in order (not necessarily adjacent). */
  shared: number
  /** Matching tokens from the start of both attempts. */
  prefix: number
  /** Matching tokens from the end of both attempts. */
  suffix: number
  /** Longest contiguous matching run anywhere in the two attempts. */
  longestRun: number
  /** Smallest attempt size, used to avoid accepting a lone shared word. */
  shortestLength: number
}

/**
 * Compare two small neighboring attempts by token sequence rather than by a
 * rendered string.  Word timings are noisy around a restart and punctuation
 * is transcription formatting, not reliable evidence of speaker intent.
 */
function retakeAlignment(left: Word[], right: Word[]): RetakeAlignment {
  const leftTokens = left.map((word) => norm(word.text)).filter(Boolean)
  const rightTokens = right.map((word) => norm(word.text)).filter(Boolean)
  const shortestLength = Math.min(leftTokens.length, rightTokens.length)
  if (!shortestLength) return { shared: 0, prefix: 0, suffix: 0, longestRun: 0, shortestLength: 0 }

  let prefix = 0
  while (prefix < shortestLength && leftTokens[prefix] === rightTokens[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < shortestLength
    && leftTokens[leftTokens.length - 1 - suffix] === rightTokens[rightTokens.length - 1 - suffix]
  ) suffix += 1

  const lcs = Array.from({ length: leftTokens.length + 1 }, () => Array<number>(rightTokens.length + 1).fill(0))
  const runs = Array.from({ length: leftTokens.length + 1 }, () => Array<number>(rightTokens.length + 1).fill(0))
  let longestRun = 0
  for (let leftIndex = 1; leftIndex <= leftTokens.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= rightTokens.length; rightIndex += 1) {
      if (leftTokens[leftIndex - 1] === rightTokens[rightIndex - 1]) {
        lcs[leftIndex][rightIndex] = lcs[leftIndex - 1][rightIndex - 1] + 1
        runs[leftIndex][rightIndex] = runs[leftIndex - 1][rightIndex - 1] + 1
        longestRun = Math.max(longestRun, runs[leftIndex][rightIndex])
      } else {
        lcs[leftIndex][rightIndex] = Math.max(lcs[leftIndex - 1][rightIndex], lcs[leftIndex][rightIndex - 1])
      }
    }
  }
  return {
    shared: lcs[leftTokens.length][rightTokens.length],
    prefix,
    suffix,
    longestRun,
    shortestLength,
  }
}

function isExactAlignment(alignment: RetakeAlignment): boolean {
  return alignment.shortestLength > 0 && alignment.shared === alignment.shortestLength
}

/**
 * A rapid restart is evidence in its own right.  Exact restarts may include
 * sentence punctuation, while a partial restart still needs two adjacent or
 * positionally consistent words so one coincidental word cannot surface a
 * removal recommendation.
 */
function isRapidRestart(before: Word[], after: Word[], pause: number): boolean {
  if (!variedPhrase(before) || !variedPhrase(after)) return false
  const alignment = retakeAlignment(before, after)
  if (isExactAlignment(alignment) && before.length === after.length) return true
  // A short partial overlap inside a normally flowing sentence is common
  // ("need clarity, we need clarity"). Require a perceptible reset before
  // interpreting that weaker evidence as an abandoned attempt. Exact fast
  // repeats remain valid even with near-zero silence.
  if (pause < 0.16) return false
  return alignment.shared >= 2
    && alignment.shared / alignment.shortestLength >= 0.66
    && (alignment.prefix >= 2 || alignment.suffix >= 2 || alignment.longestRun >= 2)
}

/**
 * A slower retake needs stronger lexical evidence.  A repeated short,
 * completed sentence is left alone because it is commonly rhetorical; a
 * fuller completed sentence or a clearly revised phrase stays reviewable.
 */
function isPausedRetake(before: Word[], after: Word[]): boolean {
  if (!variedPhrase(before) || !variedPhrase(after)) return false
  const alignment = retakeAlignment(before, after)
  const exact = isExactAlignment(alignment) && before.length === after.length
  const revision = alignment.shared >= 3
    && alignment.shared / alignment.shortestLength >= 0.6
    && (alignment.prefix >= 2 || alignment.suffix >= 2 || alignment.longestRun >= 3)
  if (!exact && !revision) return false
  if (!hasSentenceBoundary(before)) return true
  if (exact) return before.length >= 4
  return alignment.shared >= 3 && (alignment.prefix >= 3 || alignment.suffix >= 3 || alignment.longestRun >= 3)
}

function isMarkerBackedRevision(before: Word[], after: Word[]): boolean {
  if (!variedPhrase(before) || !variedPhrase(after)) return false
  const alignment = retakeAlignment(before, after)
  return alignment.shared >= 3
    && alignment.shared / alignment.shortestLength >= 0.6
    && (alignment.prefix >= 2 || alignment.suffix >= 2 || alignment.longestRun >= 3)
}

/**
 * Retake detection is intentionally conservative. It only suggests a prior
 * phrase when a close, multi-word repeat follows after a pause, leaving names,
 * refrains, list items, quoted text, and sentence-separated repetition alone.
 */
export function detectRetakes(
  words: Word[],
  keepIds = new Set<string>(),
  options: CleanupOptions = {},
): {
  retakeIds: string[]
  /** Historic removal groups, retained for persisted edit compatibility. */
  groups: string[][]
  /** Reviewable alternate-take groups attached to the detected proposals. */
  retakeGroups: RetakeGroup[]
  count: number
  proposals: CleanupProposal[]
  diagnostics: RetakeDiagnostics
} {
  const kept = words.filter((word) => !word.isRemoved || (word.isFiller && !word.isRetake))
  const normalized = kept.map((word) => norm(word.text))
  const proposals: CleanupProposal[] = []
  const covered = new Set<string>()
  const speakers = effectiveSpeakers(words, options.speakerByWord)
  const rejected: Record<string, number> = {}
  const reject = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1 }
  let candidateWindows = 0

  // A speaker can abandon a phrase and restart it immediately. This stays
  // review-only because text timings alone cannot prove the intent.  Keep
  // this local: an exact fast restart is meaningful, but a matching phrase
  // elsewhere in a transcript is not enough evidence to remove anything.
  for (let boundary = 2; boundary < kept.length - 3; boundary += 1) {
    const beforeEnd = kept[boundary]
    const afterStart = kept[boundary + 1]
    const pause = clampTime(afterStart.startTime) - clampTime(beforeEnd.endTime)
    const speakerChanged = crossesSpeakerBoundary([beforeEnd, afterStart], speakers)
    if (pause < 0.08 || pause > 0.65) { reject('outside-immediate-window'); continue }
    if (speakerChanged) { reject('speaker-boundary'); continue }
    for (let length = 5; length >= 3; length -= 1) {
      const beforeStart = boundary - length + 1
      const afterEnd = boundary + length
      if (beforeStart < 0 || afterEnd >= kept.length) continue
      candidateWindows += 1
      const before = kept.slice(beforeStart, boundary + 1)
      const after = kept.slice(boundary + 1, afterEnd + 1)
      if (
        hasQuoteBoundary(before)
        || hasQuoteBoundary(after)
        || crossesSpeakerBoundary([...before, ...after], speakers)
      ) { reject('quoted-content-or-speaker-boundary'); continue }
      if (
        UNAMBIGUOUS_FILLERS.has(norm(before[0].text))
        || !isRapidRestart(before, after, pause)
      ) { reject('insufficient-local-alignment'); continue }
      const ids = before.map((word) => word.id)
      if (ids.some((id) => keepIds.has(id) || covered.has(id))) { reject('kept-or-overlapping'); continue }
      const proposal = proposalForWords(
        'retakes',
        words,
        ids,
        'medium',
        `Immediate ${ids.length}-word restart aligns with the following take after ${Math.round(pause * 1000)}ms`,
        after.map((word) => word.id),
        options,
      )
      if (proposal) {
        proposals.push(proposal)
        ids.forEach((id) => covered.add(id))
      }
      break
    }
  }

  for (let boundary = 2; boundary < kept.length - 2; boundary += 1) {
    const beforeEnd = kept[boundary]
    const afterStart = kept[boundary + 1]
    const pause = clampTime(afterStart.startTime) - clampTime(beforeEnd.endTime)
    const speakerChanged = crossesSpeakerBoundary([beforeEnd, afterStart], speakers)
    // Longer pauses retain only nearby restart evidence.  Without acoustic
    // proof, allowing arbitrary-distance repeats is a false-positive trap.
    if (pause < RETAKE_PAUSE || pause > 5) { reject('outside-paused-window'); continue }
    if (speakerChanged) { reject('speaker-boundary'); continue }

    // Do not let an attempt absorb a neighboring attempt in a three-take
    // sequence. A substantial pause is an attempt boundary, while ordinary
    // word gaps still allow a later take to include its complete ending.
    let beforeFloor = Math.max(0, boundary - 7)
    for (let index = boundary - 1; index >= beforeFloor; index -= 1) {
      const priorPause = clampTime(kept[index + 1].startTime) - clampTime(kept[index].endTime)
      if (priorPause >= RETAKE_PAUSE) {
        beforeFloor = index + 1
        break
      }
    }
    let afterCeiling = Math.min(kept.length - 1, boundary + 8)
    for (let index = boundary + 1; index < afterCeiling; index += 1) {
      const followingPause = clampTime(kept[index + 1].startTime) - clampTime(kept[index].endTime)
      if (followingPause >= RETAKE_PAUSE) {
        afterCeiling = index
        break
      }
    }

    let best: { before: Word[]; after: Word[]; score: number; shared: number } | null = null
    // Attempts do not necessarily have equal token counts: a failed phrase is
    // often shorter while the accepted take carries on to a complete ending.
    // Score coverage of the *earlier/removable* attempt instead of choosing the
    // first/longest equal window, which previously pulled unrelated lead-in
    // words into a valid retake group.
    for (let beforeLength = 3; beforeLength <= 8; beforeLength += 1) {
      const beforeStart = boundary - beforeLength + 1
      if (beforeStart < beforeFloor) continue
      for (let afterLength = 3; afterLength <= 8; afterLength += 1) {
        const afterEnd = boundary + afterLength
        if (afterEnd > afterCeiling) continue
        candidateWindows += 1
        const before = kept.slice(beforeStart, boundary + 1)
        const after = kept.slice(boundary + 1, afterEnd + 1)
        if (
          hasQuoteBoundary(before)
          || hasQuoteBoundary(after)
          || crossesSpeakerBoundary([...before, ...after], speakers)
        ) { reject('quoted-content-or-speaker-boundary'); continue }
        if (!isPausedRetake(before, after)) continue
        const alignment = retakeAlignment(before, after)
        const score = before.length ? alignment.shared / before.length : 0
        const better = !best
          || score > best.score
          || (score === best.score && alignment.shared > best.shared)
          || (score === best.score && alignment.shared === best.shared && after.length > best.after.length)
          || (score === best.score && alignment.shared === best.shared && after.length === best.after.length && before.length > best.before.length)
        if (better) best = { before, after, score, shared: alignment.shared }
      }
    }
    if (!best) { reject('insufficient-paused-alignment'); continue }
    const ids = best.before.map((word) => word.id)
    if (ids.some((id) => keepIds.has(id) || covered.has(id))) { reject('kept-or-overlapping'); continue }
    const confidence: CleanupConfidence = best.score >= 0.94 && pause >= 1.8 ? 'high' : 'medium'
    const proposal = proposalForWords(
      'retakes',
      words,
      ids,
      confidence,
        `Earlier ${ids.length}-word attempt aligns with a following retake after a ${pause.toFixed(1)}s pause`,
        best.after.map((word) => word.id),
        options,
    )
    if (proposal) {
      proposals.push(proposal)
      ids.forEach((id) => covered.add(id))
    }
  }

  // Spoken correction markers are useful evidence, but they remain medium
  // confidence and must be reviewed rather than silently selected.
  for (let index = 0; index < kept.length; index += 1) {
    const marker = RETAKE_MARKERS.find((candidate) => normalized.slice(index, index + candidate.split(' ').length).join(' ') === candidate)
    if (!marker) continue
    const markerLength = marker.split(' ').length
    let first = Math.max(0, index - 1)
    while (first > 0 && clampTime(kept[first - 1].gapAfter) < RETAKE_PAUSE && index - first < 12) first -= 1
    const candidate = kept.slice(first, Math.min(kept.length, index + markerLength))
    const ids = candidate.map((word) => word.id).filter((id) => !keepIds.has(id) && !covered.has(id))
    if (ids.length < 2) { reject('marker-attempt-too-short'); continue }
    const beforeMarker = kept.slice(first, index)
    const following = kept.slice(index + markerLength, index + markerLength + Math.min(beforeMarker.length, 8))
    if (crossesSpeakerBoundary([...candidate, ...following], speakers)) { reject('speaker-boundary'); continue }
    const repeatsPreviousPhrase = beforeMarker.length >= 2
      && following.length >= 2
      && isMarkerBackedRevision(beforeMarker.slice(-following.length), following)
    if (!repeatsPreviousPhrase) { reject('marker-without-alignment'); continue }
    candidateWindows += 1
    const proposal = proposalForWords(
      'retakes',
      words,
      ids,
      'medium',
      `Spoken correction marker: “${marker}”`,
      following.map((word) => word.id),
      options,
    )
    if (proposal) {
      proposals.push(proposal)
      ids.forEach((id) => covered.add(id))
    }
  }

  const mergedProposals = mergeRetakeChains(words, proposals, options)
  const groups = mergedProposals.map((proposal) => proposal.wordIds)
  const retakeIds = groups.flat()
  const retakeGroups = mergedProposals
    .map((proposal) => proposal.retakeGroup)
    .filter((group): group is RetakeGroup => Boolean(group))
  const retained = words.filter((word) => !word.isRemoved)
  return {
    retakeIds,
    groups,
    retakeGroups,
    count: retakeIds.length,
    proposals: mergedProposals,
    diagnostics: {
      analyzedWordCount: retained.length,
      sourceStart: retained.length ? clampTime(retained[0].startTime) : 0,
      sourceEnd: retained.length ? clampTime(retained[retained.length - 1].endTime) : 0,
      candidateWindows,
      rejected,
      groups: retakeGroups.length,
    },
  }
}

/**
 * A three-take restart often appears as two adjacent pairwise matches
 * (A to B and B to C). Merge only groups that literally share a candidate
 * word, so the reviewer chooses among one chronological group rather than
 * being asked to remove the middle attempt twice.
 */
function mergeRetakeChains(words: Word[], proposals: CleanupProposal[], options: CleanupOptions = {}): CleanupProposal[] {
  const components: CleanupProposal[][] = []
  for (const proposal of proposals) {
    const ids = new Set(proposal.retakeGroup?.candidates.flatMap((candidate) => candidate.wordIds) ?? [])
    if (!ids.size) {
      components.push([proposal])
      continue
    }
    const matching = components.filter((component) => component.some((existing) => (
      existing.retakeGroup?.candidates.some((candidate) => candidate.wordIds.some((id) => ids.has(id)))
    )))
    if (!matching.length) {
      components.push([proposal])
      continue
    }
    const merged = [...matching.flat(), proposal]
    components.splice(0, components.length, ...components.filter((component) => !matching.includes(component)), merged)
  }

  return components.flatMap((component) => {
    if (component.length === 1) {
      const proposal = component[0]
      return proposal.retakeGroup && !retakeWordGroupsAreDisjoint(proposal.retakeGroup.candidates.map((candidate) => candidate.wordIds))
        ? []
        : component
    }
    const candidates = canonicalizeRetakeCandidateAttempts(
      words,
      component.map((proposal) => proposal.retakeGroup?.candidates ?? []),
    )
    // A connected set of pairwise matches needs at least two distinct physical
    // attempts. Suppress it rather than presenting an ambiguous destructive
    // edit if the transcript evidence collapses to less than that.
    if (candidates.length < 2 || !retakeWordGroupsAreDisjoint(candidates.map((candidate) => candidate.wordIds))) return []
    const recommendation = recommendRetakeCandidate(candidates, options)
    const recommended = recommendation.candidate
    const removable = candidates.filter((candidate) => candidate.id !== recommended.id).flatMap((candidate) => candidate.wordIds)
    const allIds = candidates.flatMap((candidate) => candidate.wordIds)
    const first = candidates[0]
    const last = candidates[candidates.length - 1]
    return [{
      id: `retakes:${allIds.join(',')}:group`,
      kind: 'retakes' as const,
      wordIds: removable,
      startTime: first.startTime,
      endTime: last.endTime,
      previewStart: first.startTime,
      previewEnd: last.endTime,
      confidence: 'medium' as const,
      reason: `${candidates.length} closely aligned restart attempts; choose the take to keep`,
      context: contextFor(words, first.wordIds[0], last.wordIds[last.wordIds.length - 1]),
      recommendedKeepIds: recommended.wordIds,
      retakeGroup: {
        id: `retakes:${allIds.join(',')}:choices`,
        candidates,
        recommendedCandidateId: recommended.id,
        recommendationReason: recommendation.reason,
      },
      sourceWords: sourceWordsFor(words, allIds),
    }]
  }).sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id))
}

function mergeGroups(existing: string[][], additions: string[][]): string[][] {
  const known = new Set<string>()
  return [...existing, ...additions].filter((group) => {
    const key = group.join('\u0000')
    if (!group.length || known.has(key)) return false
    known.add(key)
    return true
  })
}

function summaryFor(kind: CleanupKind, proposals: CleanupProposal[]): CleanupSummary {
  const summary = emptySummary()
  if (kind === 'fillers') summary.fillers = proposals.reduce((count, proposal) => count + proposal.wordIds.length, 0)
  if (kind === 'gaps') summary.gaps = proposals.length
  if (kind === 'retakes') summary.retakes = proposals.reduce((count, proposal) => count + proposal.wordIds.length, 0)
  return summary
}

function proposalStillApplies(
  proposal: CleanupProposal,
  liveWords: Map<string, Word>,
  shortenedGapIds: Set<string>,
): boolean {
  if (proposal.gapWordId && shortenedGapIds.has(proposal.gapWordId)) return false
  // This is a second, apply-time boundary. A stale or malformed preview must
  // never become a state payload the durable model would reject.
  if (proposal.kind === 'retakes' && proposal.retakeGroup
    && !retakeWordGroupsAreDisjoint(proposal.retakeGroup.candidates.map((candidate) => candidate.wordIds))) return false
  return proposal.sourceWords.length > 0 && proposal.sourceWords.every((source) => {
    const live = liveWords.get(source.id)
    if (!live) return false
    return !live.isRemoved
      && live.text === source.text
      && live.startTime === source.startTime
      && live.endTime === source.endTime
  })
}

function retakeCandidateToKeep(
  proposal: CleanupProposal,
  retakeCandidateChoices: Record<string, string>,
): RetakeCandidate | undefined {
  const group = proposal.retakeGroup
  if (!group) return undefined
  const explicit = retakeCandidateChoices[proposal.id]
  return group.candidates.find((candidate) => candidate.id === explicit)
}

/**
 * A selected retake has no effect until the editor explicitly chooses the
 * candidate to retain. Once chosen, every other candidate in that one group
 * is removed in the reversible preview/apply operation.
 */
function wordIdsRemovedByProposal(
  proposal: CleanupProposal,
  retakeCandidateChoices: Record<string, string>,
): string[] {
  const keep = proposal.kind === 'retakes'
    ? retakeCandidateToKeep(proposal, retakeCandidateChoices)
    : undefined
  if (proposal.kind === 'retakes' && !keep) return []
  if (!proposal.retakeGroup || !keep) return proposal.wordIds
  return uniqueIds(
    proposal.retakeGroup.candidates
      .filter((candidate) => candidate.id !== keep.id)
      .flatMap((candidate) => candidate.wordIds),
  )
}

function selectedSummaryFor(
  kind: CleanupKind,
  proposals: CleanupProposal[],
  retakeCandidateChoices: Record<string, string>,
): CleanupSummary {
  if (kind !== 'retakes') return summaryFor(kind, proposals)
  return {
    ...emptySummary(),
    retakes: new Set(proposals.flatMap((proposal) => wordIdsRemovedByProposal(proposal, retakeCandidateChoices))).size,
  }
}

function applyProposalSet(
  kind: CleanupKind,
  words: Word[],
  shortenedGapIds: string[],
  collapsedRetakes: string[][],
  proposals: CleanupProposal[],
  retakeCandidateChoices: Record<string, string> = {},
): CleanupApplication {
  const liveWords = new Map(words.map((word) => [word.id, word]))
  const selected = proposals.filter((proposal) => proposal.kind === kind
    && proposalStillApplies(proposal, liveWords, new Set(shortenedGapIds))
    && (kind !== 'retakes' || Boolean(retakeCandidateToKeep(proposal, retakeCandidateChoices))))
  const selectedWordGroups = selected.map((proposal) => wordIdsRemovedByProposal(proposal, retakeCandidateChoices))
  const wordIds = new Set(selectedWordGroups.flat())
  const gapIds = selected.map((proposal) => proposal.gapWordId).filter((id): id is string => Boolean(id))
  const nextWords = words.map((word) => {
    if (!wordIds.has(word.id)) return { ...word }
    return kind === 'fillers'
      ? { ...word, isRemoved: true, isFiller: true }
      : { ...word, isRemoved: true, isRetake: true }
  })
  return {
    words: nextWords,
    shortenedGapIds: kind === 'gaps' ? [...new Set([...shortenedGapIds, ...gapIds])] : [...shortenedGapIds],
    collapsedRetakes: kind === 'retakes'
      ? mergeGroups(collapsedRetakes, selectedWordGroups)
      : collapsedRetakes.map((group) => [...group]),
    selectedSummary: selectedSummaryFor(kind, selected, retakeCandidateChoices),
    appliedProposalIds: selected.map((proposal) => proposal.id),
  }
}

/** Apply selected recommendations to the current state, never to a stale preview copy. */
export function applyCleanupProposals(
  kind: CleanupKind,
  words: Word[],
  shortenedGapIds: string[],
  collapsedRetakes: string[][],
  proposals: CleanupProposal[],
  selectedProposalIds: string[],
  retakeCandidateChoices: Record<string, string> = {},
): CleanupApplication {
  const selected = new Set(selectedProposalIds)
  return applyProposalSet(
    kind,
    words,
    shortenedGapIds,
    collapsedRetakes,
    proposals.filter((proposal) => selected.has(proposal.id)),
    retakeCandidateChoices,
  )
}

/** Rebuild the visual preview after a user changes which suggestions are selected. */
export function withCleanupSelection(
  result: CleanupResult,
  selectedProposalIds: string[],
  retakeCandidateChoices: Record<string, string> = result.retakeCandidateChoices,
): CleanupResult {
  const selected = new Set(selectedProposalIds)
  const validChoices = Object.fromEntries(
    Object.entries(retakeCandidateChoices).filter(([proposalIdValue, candidateId]) => {
      if (!selected.has(proposalIdValue)) return false
      const group = result.proposals.find((proposal) => proposal.id === proposalIdValue)?.retakeGroup
      return Boolean(group?.candidates.some((candidate) => candidate.id === candidateId))
    }),
  )
  const { appliedProposalIds: _appliedProposalIds, ...applied } = applyCleanupProposals(
    result.kind,
    result.previewBaseWords,
    result.previewBaseShortenedGapIds,
    result.previewBaseCollapsedRetakes,
    result.proposals,
    [...selected],
    validChoices,
  )
  return {
    ...result,
    ...applied,
    selectedProposalIds: [...selected],
    retakeCandidateChoices: validChoices,
  }
}

/**
 * Choose the take to keep and stage its alternate(s) for reversible preview.
 * Choosing a candidate deliberately selects the proposal, but it never saves
 * or exports an edit until the caller invokes `applyCleanupProposals`.
 */
export function selectRetakeCandidate(
  result: CleanupResult,
  proposalIdValue: string,
  candidateId: string,
): CleanupResult {
  if (result.kind !== 'retakes') return result
  const proposal = result.proposals.find((candidate) => candidate.id === proposalIdValue)
  if (!proposal?.retakeGroup?.candidates.some((candidate) => candidate.id === candidateId)) return result
  return withCleanupSelection(
    result,
    [...new Set([...result.selectedProposalIds, proposalIdValue])],
    { ...result.retakeCandidateChoices, [proposalIdValue]: candidateId },
  )
}

export function runCleanup(
  kind: CleanupKind,
  words: Word[],
  shortenedGapIds: string[],
  collapsedRetakes: string[][],
  cleanupKeepWordIds: string[] = [],
  cleanupKeepGapIds: string[] = [],
  options: CleanupOptions = {},
): CleanupResult {
  const keptWords = new Set(cleanupKeepWordIds)
  const keptGaps = new Set(cleanupKeepGapIds)
  let proposals: CleanupProposal[] = []

  if (kind === 'fillers') proposals = detectFillers(words, keptWords, options).proposals
  const gapResult = kind === 'gaps' ? detectGaps(words, new Set(shortenedGapIds), keptGaps, options) : null
  if (gapResult) proposals = gapResult.proposals
  const retakeResult = kind === 'retakes' ? detectRetakes(words, keptWords, options) : null
  if (retakeResult) proposals = retakeResult.proposals

  // Retakes always require an explicit candidate choice. Even a strong text
  // match cannot establish which take the editor intended to keep.
  const selectedProposalIds = kind === 'retakes'
    ? []
    : proposals
      .filter((proposal) => proposal.confidence === 'high')
      .map((proposal) => proposal.id)
  const applied = applyCleanupProposals(kind, words, shortenedGapIds, collapsedRetakes, proposals, selectedProposalIds)
  return {
    kind,
    previewBaseWords: words.map((word) => ({ ...word })),
    previewBaseShortenedGapIds: [...shortenedGapIds],
    previewBaseCollapsedRetakes: collapsedRetakes.map((group) => [...group]),
    words: applied.words,
    shortenedGapIds: applied.shortenedGapIds,
    collapsedRetakes: applied.collapsedRetakes,
    summary: summaryFor(kind, proposals),
    selectedSummary: applied.selectedSummary,
    proposals,
    selectedProposalIds,
    retakeCandidateChoices: {},
    retakeDiagnostics: retakeResult?.diagnostics,
    gapDiagnostics: gapResult?.diagnostics,
  }
}
