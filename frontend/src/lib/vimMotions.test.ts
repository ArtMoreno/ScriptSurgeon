import assert from 'node:assert/strict'
import test from 'node:test'
import type { Word } from '../types.ts'
import { VIM_IDLE, motionTarget, paragraphStarts, sentenceStarts, vimKey, vimStatus, type VimContext, type VimState } from './vimMotions.ts'

// Two paragraphs, three sentences: "A b c. D e. | F g h."  (index: 0..7)
function words(): Word[] {
  const tokens = ['A', 'b', 'c.', 'D', 'e.', 'F', 'g', 'h.']
  return tokens.map((text, index) => ({
    id: `w${index}`,
    text,
    startTime: index,
    endTime: index + 0.5,
    gapAfter: index === 4 ? 1.5 : 0.1,
    isFiller: false,
    isRetake: false,
    isRemoved: false,
  }))
}

function context(focus: number, anchor: number | null = null): VimContext {
  const list = words()
  return { words: list, navigable: list.map((_, index) => index), focus, anchor }
}

function run(keys: string, start: VimContext, state: VimState = VIM_IDLE) {
  let current = state
  let ctx = start
  let commands: ReturnType<typeof vimKey>['commands'] = []
  for (const key of keys) {
    const result = vimKey(current, key, ctx)
    current = result.state
    commands = result.commands
    for (const command of commands) {
      if (command.type === 'move') ctx = { ...ctx, focus: command.to }
      if (command.type === 'visual') ctx = { ...ctx, anchor: command.on ? ctx.focus : null }
    }
  }
  return { state: current, commands, ctx }
}

test('sentence and paragraph starts follow punctuation and pauses', () => {
  assert.deepEqual(sentenceStarts(context(0)), [0, 3, 5])
  assert.deepEqual(paragraphStarts(context(0)), [0, 5])
})

test('word motions honour counts and clamp at the edges', () => {
  assert.equal(run('l', context(0)).ctx.focus, 1)
  assert.equal(run('3w', context(0)).ctx.focus, 3)
  assert.equal(run('h', context(0)).ctx.focus, 0)
  assert.equal(run('G', context(0)).ctx.focus, 7)
  assert.equal(run('gg', context(6)).ctx.focus, 0)
  assert.equal(run('$', context(0)).ctx.focus, 2)
  assert.equal(run('0', context(4)).ctx.focus, 3)
})

test('sentence and paragraph motions move by structure', () => {
  assert.equal(run('j', context(0)).ctx.focus, 3)
  assert.equal(run(')', context(3)).ctx.focus, 5)
  assert.equal(run('k', context(6)).ctx.focus, 5)
  assert.equal(run('2j', context(0)).ctx.focus, 5)
  assert.equal(run('}', context(0)).ctx.focus, 5)
  assert.equal(run('{', context(7)).ctx.focus, 5)
  assert.equal(run('{', context(5)).ctx.focus, 0)
  assert.equal(motionTarget(context(3), 'j', 1).inclusive, false)
})

test('operators build whole-word ranges', () => {
  assert.deepEqual(run('x', context(1)).commands, [{ type: 'cut', from: 1, to: 1 }])
  assert.deepEqual(run('2x', context(1)).commands, [{ type: 'cut', from: 1, to: 2 }])
  assert.deepEqual(run('X', context(2)).commands, [{ type: 'cut', from: 1, to: 1 }])
  assert.deepEqual(run('dd', context(4)).commands, [{ type: 'cut', from: 3, to: 4 }])
  assert.deepEqual(run('dw', context(1)).commands, [{ type: 'cut', from: 1, to: 2 }])
  assert.deepEqual(run('d$', context(0)).commands, [{ type: 'cut', from: 0, to: 2 }])
  assert.deepEqual(run('dj', context(0)).commands, [{ type: 'cut', from: 0, to: 2 }], 'a forward sentence motion stops before the next sentence')
  assert.deepEqual(run('cc', context(6)).commands, [{ type: 'reword', from: 5, to: 7 }])
  assert.deepEqual(run('s', context(6)).commands, [{ type: 'reword', from: 6, to: 6 }])
  assert.deepEqual(run('rr', context(0)).commands, [{ type: 'restore', from: 0, to: 2 }])
  assert.deepEqual(run('dG', context(5)).commands, [{ type: 'cut', from: 5, to: 7 }])
})

test('visual mode extends with motions and applies operators to the selection', () => {
  const result = run('vll', context(1))
  assert.equal(result.state.mode, 'visual')
  assert.equal(result.ctx.anchor, 1)
  assert.equal(result.ctx.focus, 3)
  const cut = vimKey(result.state, 'd', result.ctx)
  assert.deepEqual(cut.commands[0], { type: 'cut', from: 1, to: 3 })
  assert.equal(cut.state.mode, 'normal')
  const leave = vimKey(result.state, 'Escape', result.ctx)
  assert.deepEqual(leave.commands, [{ type: 'visual', on: false }])
})

test('pending keys are shown and an unknown key clears them', () => {
  const partial = run('2d', context(0))
  assert.equal(vimStatus(partial.state), 'NORMAL 2d')
  const cleared = vimKey(partial.state, 'q', partial.ctx)
  assert.equal(cleared.state.pending, '')
  assert.deepEqual(cleared.commands, [])
  assert.equal(vimKey(VIM_IDLE, 'q', context(0)).handled, false, 'unknown keys fall through to the editor')
  assert.equal(vimKey(VIM_IDLE, 'Enter', context(0)).handled, false, 'Enter stays with the editor')
  assert.equal(vimKey(VIM_IDLE, ' ', context(0)).handled, false, 'Space stays with playback')
  assert.equal(vimKey(VIM_IDLE, 'S', context(0)).handled, false, 'Shift+S stays with speaker naming')
})

test('single keys map to editor actions', () => {
  assert.deepEqual(run('u', context(0)).commands, [{ type: 'undo' }])
  assert.deepEqual(vimKey(VIM_IDLE, 'r', context(0), true).commands, [{ type: 'redo' }])
  assert.deepEqual(run('m', context(2)).commands, [{ type: 'marker', kind: 'marker', at: 2 }])
  assert.deepEqual(run('M', context(2)).commands, [{ type: 'marker', kind: 'chapter', at: 2 }])
  assert.deepEqual(run('/', context(0)).commands, [{ type: 'search' }])
  assert.deepEqual(run('gs', context(0)).commands, [{ type: 'shortenGap' }])
})

test('motions skip words the editor cannot focus', () => {
  const list = words()
  const ctx: VimContext = { words: list, navigable: [0, 1, 3, 4, 5, 6, 7], focus: 1, anchor: null }
  assert.equal(run('l', ctx).ctx.focus, 3, 'a hidden word is stepped over')
  assert.deepEqual(sentenceStarts(ctx), [0, 2, 4], 'positions, not indices; the cut "c." still ends its sentence')
})
