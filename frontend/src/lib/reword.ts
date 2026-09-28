import type { Word } from '../types'

export const REWORD_MAX_LENGTH = 500

export interface RewordResult {
  words: Word[]
  /** IDs that no longer exist after the reword; references to them must be dropped or remapped. */
  removedIds: string[]
  /** The last word of the span after rewording; gap edits on the old last word move here. */
  lastId: string
  /** The first word of the span after rewording; inserts anchored inside the span move here. */
  firstId: string
}

function tokenize(text: string): string[] {
  return text.trim().slice(0, REWORD_MAX_LENGTH).split(/\s+/).filter(Boolean)
}

/** Ten hex characters, the backend's word ID contract. */
function newWordId(taken: Set<string>): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(5))
    const id = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
    if (!taken.has(id)) {
      taken.add(id)
      return id
    }
  }
}

/**
 * Replace the text of a contiguous run of kept words with a new phrase.
 *
 * The audio is untouched: the new words share the span from the first word's
 * start to the last word's end, split in proportion to their length. When the
 * word count changes, the first and last IDs of the span survive so that gap
 * edits, insert anchors and speaker runs keep a home; interior IDs are
 * retired. Every produced word records the original phrase so the edit can be
 * shown and reverted; pass `originalText: null` to produce unmarked words.
 */
export function rewordSpan(
  words: Word[],
  ids: readonly string[],
  text: string,
  options: { originalText?: string | null } = {},
): RewordResult | null {
  const tokens = tokenize(text)
  if (!tokens.length || !ids.length) return null
  const first = words.findIndex((word) => word.id === ids[0])
  if (first < 0) return null
  const span = words.slice(first, first + ids.length)
  if (span.length !== ids.length || span.some((word, index) => word.id !== ids[index] || word.isRemoved)) return null

  const currentText = span.map((word) => word.text).join(' ')
  if (currentText === tokens.join(' ') && options.originalText === undefined) return null
  const originalText = options.originalText === undefined
    ? span.map((word) => word.originalText ?? word.text).join(' ')
    : options.originalText

  const start = span[0].startTime
  const end = Math.max(start, span[span.length - 1].endTime)
  const totalChars = tokens.reduce((sum, token) => sum + token.length, 0) || 1
  const taken = new Set(words.map((word) => word.id))
  const template = span[0]

  let cursor = start
  const produced: Word[] = tokens.map((token, index) => {
    const share = (end - start) * (token.length / totalChars)
    const wordStart = index === 0 ? start : cursor
    const wordEnd = index === tokens.length - 1 ? end : Math.min(end, wordStart + share)
    cursor = wordEnd
    const reuse = index === 0
      ? span[0]
      : index === tokens.length - 1 && span.length > 1
        ? span[span.length - 1]
        : span.length === tokens.length ? span[index] : null
    const word: Word = {
      ...template,
      ...(reuse ?? {}),
      id: reuse ? reuse.id : newWordId(taken),
      text: token,
      startTime: Number(wordStart.toFixed(3)),
      endTime: Number(wordEnd.toFixed(3)),
      gapAfter: index === tokens.length - 1 ? span[span.length - 1].gapAfter : 0,
      isRemoved: false,
      isFiller: false,
    }
    if (originalText === null) delete word.originalText
    else word.originalText = originalText
    return word
  })
  const keptIds = new Set(produced.map((word) => word.id))
  const removedIds = span.map((word) => word.id).filter((id) => !keptIds.has(id))
  return {
    words: [...words.slice(0, first), ...produced, ...words.slice(first + span.length)],
    removedIds,
    lastId: produced[produced.length - 1].id,
    firstId: produced[0].id,
  }
}

/** The contiguous run of reworded words around `id` that share one original phrase. */
export function rewordedRun(words: Word[], id: string): Word[] {
  const index = words.findIndex((word) => word.id === id)
  const word = words[index]
  if (!word?.originalText) return []
  let first = index
  while (first > 0 && words[first - 1].originalText === word.originalText && !words[first - 1].isRemoved) first -= 1
  let last = index
  while (last < words.length - 1 && words[last + 1].originalText === word.originalText && !words[last + 1].isRemoved) last += 1
  return words.slice(first, last + 1)
}

/** Put the original phrase back over the same span and clear the edit marker. */
export function revertReword(words: Word[], id: string): RewordResult | null {
  const run = rewordedRun(words, id)
  if (!run.length) return null
  return rewordSpan(words, run.map((word) => word.id), run[0].originalText!, { originalText: null })
}
