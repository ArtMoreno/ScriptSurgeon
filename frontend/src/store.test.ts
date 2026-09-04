import assert from 'node:assert/strict'
import test from 'node:test'

import { useStore } from './store.ts'
import type { InsertClip, Speaker, Word } from './types.ts'

const word: Word = {
  id: 'aaaaaaaaaa',
  text: 'hello',
  startTime: 0,
  endTime: 0.5,
  isFiller: false,
  isRetake: false,
  isRemoved: false,
  gapAfter: 0,
}

const insert: InsertClip = {
  id: 'bbbbbbbbbbbb',
  clipId: 'cccccccccccc',
  sourceTime: 0.5,
  duration: 0.5,
  text: 'insert',
  afterWordId: word.id,
  isRemoved: false,
}

const speaker: Speaker = { id: 'dddddddd', name: 'Host' }

function setReadyProject(overrides: Record<string, unknown> = {}) {
  useStore.setState({
    projectId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    projectName: 'Test project',
    status: 'ready',
    words: [{ ...word }],
    insertClips: [],
    shortenedGapIds: [],
    gapEdits: [],
    collapsedRetakes: [],
    retakeGroups: [],
    cleanupKeepWordIds: [],
    cleanupKeepGapIds: [],
    speakers: [],
    speakerByWord: {},
    markers: [],
    sourceDuration: 1,
    duration: 1,
    dirty: false,
    saving: false,
    rendering: false,
    operationError: '',
    undoStack: [],
    redoStack: [],
    ...overrides,
  })
}

test('a rejected project deletion leaves the open project and its edits intact', async () => {
  const originalFetch = globalThis.fetch
  setReadyProject({ words: [{ ...word, isRemoved: true }], dirty: true })
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'project audio is still in use' }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await assert.rejects(
      useStore.getState().deleteProject(useStore.getState().projectId!),
      /project audio is still in use/,
    )
    const state = useStore.getState()
    assert.equal(state.projectId, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    assert.equal(state.words[0].isRemoved, true)
    assert.equal(state.dirty, true)
    assert.match(state.operationError, /could not be deleted/i)
  } finally {
    globalThis.fetch = originalFetch
    useStore.setState({ projectId: null, status: 'idle', dirty: false, operationError: '' })
  }
})

test('a completed deletion never closes a different project opened during the request', async () => {
  const originalFetch = globalThis.fetch
  const deletedId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const nextId = '11111111111111111111111111111111'
  let finishDelete: ((response: Response) => void) | undefined
  setReadyProject()
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'DELETE') {
      return new Promise<Response>((resolve) => {
        finishDelete = resolve
      })
    }
    return new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const deletion = useStore.getState().deleteProject(deletedId)
    await Promise.resolve()
    assert.ok(finishDelete)
    useStore.setState({ projectId: nextId, projectName: 'Next project', status: 'ready' })
    finishDelete(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    await deletion
    assert.equal(useStore.getState().projectId, nextId)
    assert.equal(useStore.getState().projectName, 'Next project')
  } finally {
    globalThis.fetch = originalFetch
    useStore.setState({ projectId: null, status: 'idle' })
  }
})

test('stale word actions cannot add backend-invalid persisted references', () => {
  setReadyProject({ speakers: [speaker] })
  const before = useStore.getState().undoStack.length

  useStore.getState().restoreWords(['fffffffff0'])
  useStore.getState().restoreRetakeGroup(['fffffffff1'])
  useStore.getState().keepOriginalGaps(['fffffffff2'])
  useStore.getState().assignSpeaker('fffffffff3', speaker.id)

  const state = useStore.getState()
  assert.deepEqual(state.cleanupKeepWordIds, [])
  assert.deepEqual(state.cleanupKeepGapIds, [])
  assert.deepEqual(state.collapsedRetakes, [])
  assert.deepEqual(state.speakerByWord, {})
  assert.equal(state.undoStack.length, before)
})

test('transcript corrections stay within the backend 500-character contract', async () => {
  const originalFetch = globalThis.fetch
  setReadyProject({ insertClips: [{ ...insert }] })
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method, 'PUT')
    return new Response(JSON.stringify({ ok: true, revision: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const oversized = `  ${'x'.repeat(700)}  `
    useStore.getState().correctWord(word.id, oversized)
    useStore.getState().correctInsertText(insert.id, oversized)
    assert.equal(useStore.getState().words[0].text.length, 500)
    assert.equal(useStore.getState().insertClips[0].text.length, 500)
    await useStore.getState().flushSave()
    await useStore.getState().closeProject()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media control state ignores non-finite values and stays in safe bounds', () => {
  useStore.setState({ playbackRate: 1, waveformGain: 1, duration: 10, playTime: 3 })

  useStore.getState().setPlaybackRate(Number.NaN)
  useStore.getState().setWaveformGain(Number.POSITIVE_INFINITY)
  useStore.getState().setPlayTime(Number.NaN)
  assert.equal(useStore.getState().playbackRate, 1)
  assert.equal(useStore.getState().waveformGain, 1)
  assert.equal(useStore.getState().playTime, 3)

  useStore.getState().setPlaybackRate(99)
  useStore.getState().setWaveformGain(99)
  useStore.getState().setPlayTime(99)
  assert.equal(useStore.getState().playbackRate, 4)
  assert.equal(useStore.getState().waveformGain, 8)
  assert.equal(useStore.getState().playTime, 10)
})

test('speaker renames reject duplicate display names without dirtying history', () => {
  const guest: Speaker = { id: 'eeeeeeee', name: 'Guest' }
  setReadyProject({ speakers: [speaker, guest] })

  useStore.getState().renameSpeaker(guest.id, ' host ')

  assert.deepEqual(useStore.getState().speakers, [speaker, guest])
  assert.equal(useStore.getState().undoStack.length, 0)
  assert.match(useStore.getState().operationError, /unique/i)
})
