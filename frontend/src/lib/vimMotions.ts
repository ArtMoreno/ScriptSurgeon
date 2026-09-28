import type { Word } from '../types'

/**
 * Vim-style motions for the transcript, as a pure key machine.
 *
 * The editor feeds every key pressed on a focused word through `vimKey` and
 * acts on the commands it returns. Nothing here touches the DOM or the store,
 * so the whole grammar is testable with a word list.
 *
 * Vocabulary (a "word" is a transcript word, a "line" is a sentence):
 *   h l w b e     move by word            j k ( )   move by sentence
 *   { }           move by paragraph       0 ^ $     sentence start / end
 *   gg G          first / last word       v         visual selection
 *   d{motion} dd  cut                     x X       cut this / previous word
 *   c{motion} cc  reword                  s         reword this word
 *   r{motion} rr  restore                 u  ^R     undo / redo
 *   m M           marker / chapter here   /         find
 *   gs            shorten the pause at the playhead
 *   Esc           leave visual, clear the selection
 */
export type VimMode = 'normal' | 'visual'

export interface VimState {
  mode: VimMode
  /** Keys typed so far that do not yet form a command, e.g. "3", "d", "2d", "g". */
  pending: string
}

export const VIM_IDLE: VimState = { mode: 'normal', pending: '' }

export type VimCommand =
  | { type: 'move'; to: number }
  | { type: 'cut'; from: number; to: number }
  | { type: 'restore'; from: number; to: number }
  | { type: 'reword'; from: number; to: number }
  | { type: 'visual'; on: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'marker'; kind: 'marker' | 'chapter'; at: number }
  | { type: 'search' }
  | { type: 'shortenGap' }

export interface VimContext {
  words: readonly Word[]
  /** Word indices the editor can focus, in order (kept words, plus revealed cut words). */
  navigable: readonly number[]
  /** Index into `words` of the focused word. */
  focus: number
  /** Visual-mode anchor, an index into `words`, when a selection is active. */
  anchor: number | null
}

export interface VimResult {
  state: VimState
  commands: VimCommand[]
  /** True when the key belonged to vim and the editor must not handle it otherwise. */
  handled: boolean
}

const SENTENCE_END = /[.!?][”"')\]]*$/

function endsSentence(word: Word | undefined): boolean {
  return Boolean(word && SENTENCE_END.test(word.text.trim()))
}

/** Position of `index` inside the navigable list, or the nearest one at or after it. */
function positionOf(context: VimContext, index: number): number {
  const exact = context.navigable.indexOf(index)
  if (exact >= 0) return exact
  const after = context.navigable.findIndex((candidate) => candidate > index)
  return after >= 0 ? after : Math.max(0, context.navigable.length - 1)
}

/** Navigable positions that begin a sentence: the first, and any after a sentence-ending word. */
export function sentenceStarts(context: VimContext): number[] {
  const starts: number[] = []
  context.navigable.forEach((index, position) => {
    // A cut sentence-ending word still ends the sentence for navigation.
    const previousHeard = context.words[context.navigable[position - 1]]
    const previousAny = context.words[index - 1]
    if (position === 0 || endsSentence(previousHeard) || endsSentence(previousAny)) starts.push(position)
  })
  return starts
}

/** Sentence starts that also follow a pause of 1.2 s or more, the transcript's paragraph rule. */
export function paragraphStarts(context: VimContext): number[] {
  return sentenceStarts(context).filter((position) => {
    if (position === 0) return true
    const index = context.navigable[position]
    const previous = context.words[index - 1]
    return Boolean(previous) && previous.gapAfter >= 1.2
  })
}

function nextStart(starts: number[], position: number, count: number, last: number): number {
  let target = position
  for (let step = 0; step < count; step += 1) {
    const next = starts.find((start) => start > target)
    target = next ?? last
    if (next === undefined) break
  }
  return target
}

function previousStart(starts: number[], position: number, count: number): number {
  let target = position
  for (let step = 0; step < count; step += 1) {
    const previous = [...starts].reverse().find((start) => start < target)
    target = previous ?? 0
    if (previous === undefined) break
  }
  return target
}

function currentSentenceBounds(context: VimContext, position: number): [number, number] {
  const starts = sentenceStarts(context)
  const start = [...starts].reverse().find((candidate) => candidate <= position) ?? 0
  const nextStartAt = starts.find((candidate) => candidate > position)
  const end = nextStartAt === undefined ? context.navigable.length - 1 : nextStartAt - 1
  return [start, end]
}

type Motion = 'h' | 'l' | 'w' | 'b' | 'e' | 'j' | 'k' | '(' | ')' | '{' | '}' | '0' | '^' | '$' | 'gg' | 'G'

/**
 * Where a motion lands, as a navigable position, plus whether an operator
 * over it is inclusive of the landing word (vim's inclusive/exclusive rule,
 * reduced to what matters for whole-word ranges).
 */
export function motionTarget(context: VimContext, motion: Motion, count: number): { position: number; inclusive: boolean } {
  const last = Math.max(0, context.navigable.length - 1)
  const position = positionOf(context, context.focus)
  const clamp = (value: number) => Math.max(0, Math.min(last, value))
  switch (motion) {
    case 'h': return { position: clamp(position - count), inclusive: true }
    case 'l': case 'w': case 'e': return { position: clamp(position + count), inclusive: true }
    case 'b': return { position: clamp(position - count), inclusive: true }
    case 'j': case ')': return { position: nextStart(sentenceStarts(context), position, count, last), inclusive: false }
    case 'k': case '(': return { position: previousStart(sentenceStarts(context), position, count), inclusive: true }
    case '}': return { position: nextStart(paragraphStarts(context), position, count, last), inclusive: false }
    case '{': return { position: previousStart(paragraphStarts(context), position, count), inclusive: true }
    case '0': case '^': return { position: currentSentenceBounds(context, position)[0], inclusive: true }
    case '$': return { position: currentSentenceBounds(context, position)[1], inclusive: true }
    case 'gg': return { position: 0, inclusive: true }
    case 'G': return { position: last, inclusive: true }
  }
}

const MOTION_KEYS = new Set(['h', 'l', 'w', 'b', 'e', 'j', 'k', '(', ')', '{', '}', '0', '^', '$', 'G'])
const OPERATORS = new Set(['d', 'c', 'r'])

function rangeCommand(operator: string, from: number, to: number): VimCommand {
  const [low, high] = from <= to ? [from, to] : [to, from]
  if (operator === 'd') return { type: 'cut', from: low, to: high }
  if (operator === 'c') return { type: 'reword', from: low, to: high }
  return { type: 'restore', from: low, to: high }
}

/**
 * Feed one key. `key` is the KeyboardEvent key with `ctrl` for the control
 * modifier; shifted symbols arrive already resolved ("$", "G", "{").
 */
export function vimKey(state: VimState, key: string, context: VimContext, ctrl = false): VimResult {
  const idle = { ...state, pending: '' }
  const done = (commands: VimCommand[], next: VimState = idle): VimResult => ({ state: next, commands, handled: true })
  const pending = (next: string): VimResult => ({ state: { ...state, pending: next }, commands: [], handled: true })
  const unhandled = (): VimResult => ({ state: idle, commands: [], handled: false })

  if (!context.navigable.length) return unhandled()
  const position = positionOf(context, context.focus)
  const at = (positionValue: number) => context.navigable[Math.max(0, Math.min(context.navigable.length - 1, positionValue))]

  if (key === 'Escape') {
    return state.mode === 'visual' || state.pending
      ? done([{ type: 'visual', on: false }], { mode: 'normal', pending: '' })
      : unhandled()
  }
  if (ctrl) {
    if (key.toLowerCase() === 'r') return done([{ type: 'redo' }])
    return unhandled()
  }
  if (key.length !== 1) return unhandled()

  // Count prefix. A leading 0 is the motion, not a count.
  if (/[0-9]/.test(key) && !(key === '0' && !/[1-9]/.test(state.pending))) {
    return pending(state.pending + key)
  }
  const countMatch = state.pending.match(/^(\d+)(.*)$/)
  const count = countMatch ? Math.max(1, parseInt(countMatch[1], 10)) : 1
  const rest = countMatch ? countMatch[2] : state.pending

  // Two-key prefixes.
  if (rest === 'g') {
    if (key === 'g') return applyMotion('gg')
    if (key === 's') return done([{ type: 'shortenGap' }])
    return done([])
  }
  if (key === 'g' && !OPERATORS.has(rest)) return pending(state.pending + 'g')

  function applyMotion(motion: Motion): VimResult {
    const target = motionTarget(context, motion, count)
    if (OPERATORS.has(rest)) {
      const from = position
      const to = target.position
      // Exclusive motions (forward sentence/paragraph) stop before the landing word.
      const end = !target.inclusive && to > from ? to - 1 : to
      return done([rangeCommand(rest, at(from), at(end))])
    }
    if (state.mode === 'visual') return done([{ type: 'move', to: at(target.position) }], { mode: 'visual', pending: '' })
    return done([{ type: 'move', to: at(target.position) }])
  }

  if (rest === 'g' + key) return done([])

  if (OPERATORS.has(rest)) {
    // Doubled operator acts on the current sentence: dd, cc, rr.
    if (key === rest) {
      const [start, end] = currentSentenceBounds(context, position)
      return done([rangeCommand(rest, at(start), at(end))])
    }
    if (key === 'g') return pending(state.pending + 'g')
    if (MOTION_KEYS.has(key)) return applyMotion(key as Motion)
    return done([])
  }

  if (state.mode === 'visual' && context.anchor !== null) {
    if (key === 'd' || key === 'x') return done([{ type: 'cut', from: Math.min(context.anchor, context.focus), to: Math.max(context.anchor, context.focus) }, { type: 'visual', on: false }], { mode: 'normal', pending: '' })
    if (key === 'c' || key === 's') return done([{ type: 'reword', from: Math.min(context.anchor, context.focus), to: Math.max(context.anchor, context.focus) }, { type: 'visual', on: false }], { mode: 'normal', pending: '' })
    if (key === 'r') return done([{ type: 'restore', from: Math.min(context.anchor, context.focus), to: Math.max(context.anchor, context.focus) }, { type: 'visual', on: false }], { mode: 'normal', pending: '' })
    if (key === 'v') return done([{ type: 'visual', on: false }], { mode: 'normal', pending: '' })
  }

  switch (key) {
    case 'v': return done([{ type: 'visual', on: true }], { mode: 'visual', pending: '' })
    case 'x': return done([{ type: 'cut', from: context.focus, to: at(position + count - 1) }])
    case 'X': return done([{ type: 'cut', from: at(position - count), to: at(position - 1) }])
    case 's': return done([{ type: 'reword', from: context.focus, to: at(position + count - 1) }])
    case 'u': return done([{ type: 'undo' }])
    case 'm': return done([{ type: 'marker', kind: 'marker', at: context.focus }])
    case 'M': return done([{ type: 'marker', kind: 'chapter', at: context.focus }])
    case '/': return done([{ type: 'search' }])
    case 'd': case 'c': case 'r': return pending(state.pending + key)
    default:
      if (MOTION_KEYS.has(key)) return applyMotion(key as Motion)
      return unhandled()
  }
}

/** The label shown in the transcript bar. */
export function vimStatus(state: VimState): string {
  const mode = state.mode === 'visual' ? 'VISUAL' : 'NORMAL'
  return state.pending ? `${mode} ${state.pending}` : mode
}
