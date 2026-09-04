import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveExportRange } from './exportRange.ts'

test('export range accepts an edited clip and rejects reversed, out-of-bounds and non-finite input', () => {
  assert.deepEqual(resolveExportRange('1', '2', 6), { start: 1, end: 2 })
  assert.deepEqual(resolveExportRange('1', '', 6), { start: 1, end: 6 })
  assert.equal(resolveExportRange('1', '1.001', 6), null)
  assert.deepEqual(resolveExportRange('0', '0.01', 6), { start: 0, end: 0.01 })
  for (const [start, end] of [['2', '1'], ['2', '2'], ['-1', '2'], ['0', '7'], ['NaN', '2'], ['0', 'Infinity']]) {
    assert.equal(resolveExportRange(start, end, 6), null)
  }
})
