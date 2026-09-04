import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectState } from '../types.ts'
import { api, apiErrorMessage } from './api.ts'

const validationDetail = {
  detail: [
    { loc: ['body', 'retakeGroups', 0, 'selectedKeepIndex'], msg: 'Field required' },
    { loc: ['body', 'markers', 1, 'anchor', 'sourceTime'], msg: 'Input should be a valid number' },
  ],
}

test('FastAPI/Pydantic validation arrays become readable field errors', () => {
  const message = apiErrorMessage(validationDetail)

  assert.equal(
    message,
    'body.retakeGroups.0.selectedKeepIndex: Field required; body.markers.1.anchor.sourceTime: Input should be a valid number',
  )
  assert.doesNotMatch(message!, /\[object Object\]/)
})

test('save and preview requests never surface a structured API error as [object Object]', async () => {
  const originalFetch = globalThis.fetch
  const methods: string[] = []
  globalThis.fetch = async (_input, init) => {
    methods.push(init?.method || 'GET')
    return {
      ok: false,
      status: 422,
      text: async () => JSON.stringify(validationDetail),
    } as unknown as Response
  }

  const expected = 'body.retakeGroups.0.selectedKeepIndex: Field required; body.markers.1.anchor.sourceTime: Input should be a valid number'
  try {
    await assert.rejects(
      api.saveState('project-1', {} as ProjectState),
      (error: unknown) => error instanceof Error && error.message === expected && !error.message.includes('[object Object]'),
    )
    await assert.rejects(
      api.render('project-1', true, 'off', false, 7),
      (error: unknown) => error instanceof Error && error.message === expected && !error.message.includes('[object Object]'),
    )
    assert.deepEqual(methods, ['PUT', 'POST'])
  } finally {
    globalThis.fetch = originalFetch
  }
})
