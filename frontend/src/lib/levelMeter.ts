/**
 * Input level maths for the recorder's meter.
 *
 * A timer tells you the recorder is running; it does not tell you the take is
 * usable. Level is the one piece of feedback that catches a muted input, a mic
 * pointed the wrong way, or gain set hot enough to clip - all of which are only
 * discoverable after the fact today.
 *
 * Pure functions over sample frames so the behaviour is testable without Web
 * Audio, which does not exist under node:test.
 */

/** Above this a sample is effectively at full scale and the take will distort. */
export const CLIP_THRESHOLD = 0.99

/** The meter's floor. Speech sits around -30 to -12 dBFS, so this is generous. */
export const FLOOR_DB = -60

export interface LevelFrame {
  /** Root mean square of the frame, 0..1. Perceived loudness. */
  rms: number
  /** Largest absolute sample in the frame, 0..1. Catches transients. */
  peak: number
  clipped: boolean
}

export function analyseFrame(samples: Float32Array): LevelFrame {
  if (!samples.length) return { rms: 0, peak: 0, clipped: false }
  let sum = 0
  let peak = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]
    sum += value * value
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
  }
  return {
    rms: Math.sqrt(sum / samples.length),
    peak,
    clipped: peak >= CLIP_THRESHOLD,
  }
}

export function toDecibels(amplitude: number): number {
  if (amplitude <= 0) return FLOOR_DB
  return Math.max(FLOOR_DB, 20 * Math.log10(amplitude))
}

/**
 * Map an amplitude onto the 0..1 the meter draws.
 *
 * Linear amplitude is unreadable: normal speech would sit in the leftmost tenth
 * of the bar. A dB scale spends the width where the decisions actually are.
 */
export function toMeterScale(amplitude: number): number {
  const decibels = toDecibels(amplitude)
  return Math.min(1, Math.max(0, (decibels - FLOOR_DB) / -FLOOR_DB))
}

/**
 * A peak reading that falls slowly, the way hardware meters behave.
 *
 * An instantaneous peak flickers too fast to read. Holding the maximum and
 * bleeding it off gives the eye something to land on.
 */
export function decayPeak(previous: number, next: number, decayPerFrame = 0.02): number {
  return next >= previous ? next : Math.max(next, previous - decayPerFrame)
}

export type LevelVerdict = 'silent' | 'quiet' | 'good' | 'hot' | 'clipping'

/**
 * Plain-language read on the signal, so the meter says something without
 * requiring the user to know what dBFS means.
 */
export function verdict(frame: LevelFrame): LevelVerdict {
  if (frame.clipped) return 'clipping'
  const decibels = toDecibels(frame.rms)
  if (decibels <= FLOOR_DB + 5) return 'silent'
  if (decibels < -30) return 'quiet'
  if (toDecibels(frame.peak) > -3) return 'hot'
  return 'good'
}

export const VERDICT_LABEL: Record<LevelVerdict, string> = {
  silent: 'No signal',
  quiet: 'Low - move closer or raise gain',
  good: 'Good level',
  hot: 'Hot - lower gain',
  clipping: 'Clipping - lower gain',
}
