import type { Word } from '../types.ts'

export interface SearchMatch {
  /** Index into the words array where the match begins. */
  startIdx: number
  endIdx: number
  wordIds: string[]
}

/**
 * Matches against the transcript as flowing text rather than word by word, so a
 * multi-word query like "Penn State" spans the two tokens the way Ctrl+F does
 * in a document. Removed words stay searchable — they are still on screen.
 */
export function findMatches(words: Word[], query: string): SearchMatch[] {
  const needle = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!needle) return []

  let haystack = ''
  // Character offset of each word's first character within `haystack`.
  const starts: number[] = []
  const ends: number[] = []
  for (let index = 0; index < words.length; index += 1) {
    if (index > 0) haystack += ' '
    starts[index] = haystack.length
    haystack += words[index].text.toLowerCase()
    ends[index] = haystack.length
  }

  const matches: SearchMatch[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    const stop = at + needle.length
    let startIdx = -1
    let endIdx = -1
    for (let index = 0; index < words.length; index += 1) {
      if (ends[index] > at && starts[index] < stop) {
        if (startIdx === -1) startIdx = index
        endIdx = index
      }
    }
    if (startIdx !== -1) {
      matches.push({
        startIdx,
        endIdx,
        wordIds: words.slice(startIdx, endIdx + 1).map((word) => word.id),
      })
    }
    // Advance by one character so overlapping occurrences are all reported.
    from = at + 1
  }
  return matches
}

/** Wraps around in both directions so the search never dead-ends. */
export function stepMatch(current: number, total: number, delta: number): number {
  if (total <= 0) return 0
  return ((current + delta) % total + total) % total
}
