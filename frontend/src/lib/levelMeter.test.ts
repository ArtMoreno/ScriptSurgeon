import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyseFrame,
  CLIP_THRESHOLD,
  decayPeak,
  FLOOR_DB,
  toDecibels,
  toMeterScale,
  verdict,
} from './levelMeter.ts'

function sine(amplitude: number, length = 1024): Float32Array {
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * index) / 64)
  }
  return samples
}

test('an empty frame reads as silence rather than throwing', () => {
  assert.deepEqual(analyseFrame(new Float32Array(0)), { rms: 0, peak: 0, clipped: false })
})

test('a sine reads its amplitude as peak and amplitude over root two as rms', () => {
  const frame = analyseFrame(sine(0.5))

  assert.ok(Math.abs(frame.peak - 0.5) < 0.01)
  assert.ok(Math.abs(frame.rms - 0.5 / Math.SQRT2) < 0.01)
  assert.equal(frame.clipped, false)
})

test('full scale samples are reported as clipping', () => {
  assert.equal(analyseFrame(sine(1)).clipped, true)
  assert.equal(analyseFrame(sine(CLIP_THRESHOLD - 0.01)).clipped, false)
})

test('silence sits on the floor instead of negative infinity', () => {
  assert.equal(toDecibels(0), FLOOR_DB)
  assert.equal(toMeterScale(0), 0)
})

test('full scale fills the meter', () => {
  assert.equal(toMeterScale(1), 1)
})

test('the meter scale is monotonic and spends its width on speech levels', () => {
  const quiet = toMeterScale(0.01)
  const speech = toMeterScale(0.1)
  const loud = toMeterScale(0.7)

  assert.ok(quiet < speech && speech < loud)
  // A linear meter would put 0.1 at a tenth of the bar; dB puts it past a third.
  assert.ok(speech > 0.33)
})

test('peak falls off gradually but jumps up immediately', () => {
  assert.equal(decayPeak(0.8, 0.9), 0.9)
  assert.ok(Math.abs(decayPeak(0.8, 0.1, 0.02) - 0.78) < 1e-9)
  // It never decays below the current reading.
  assert.equal(decayPeak(0.1, 0.09, 0.5), 0.09)
})

test('the verdict names what the user should do about the level', () => {
  assert.equal(verdict(analyseFrame(new Float32Array(64))), 'silent')
  assert.equal(verdict(analyseFrame(sine(0.005))), 'quiet')
  assert.equal(verdict(analyseFrame(sine(0.1))), 'good')
  assert.equal(verdict(analyseFrame(sine(0.9))), 'hot')
  assert.equal(verdict(analyseFrame(sine(1))), 'clipping')
})
