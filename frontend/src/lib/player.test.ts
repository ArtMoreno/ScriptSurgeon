import assert from 'node:assert/strict'
import test from 'node:test'
import type WaveSurfer from 'wavesurfer.js'
import { player } from './player.ts'

type EventName = 'timeupdate' | 'finish'

class FakeWaveSurfer {
  duration = 12
  currentTime = 0
  pauseCount = 0
  playCalls: Array<[number?, number?]> = []
  setTimes: number[] = []
  private listeners: Record<EventName, Set<(value?: number) => void>> = {
    timeupdate: new Set(),
    finish: new Set(),
  }

  getDecodedData() { return {} }
  getDuration() { return this.duration }
  getCurrentTime() { return this.currentTime }
  pause() { this.pauseCount += 1 }
  setTime(time: number) {
    this.currentTime = time
    this.setTimes.push(time)
    this.emit('timeupdate', time)
  }
  advance(time: number) {
    this.currentTime = time
    this.emit('timeupdate', time)
  }
  play(start?: number, end?: number) {
    this.playCalls.push([start, end])
    return Promise.resolve()
  }
  on(event: EventName, listener: (value?: number) => void) {
    this.listeners[event].add(listener)
    return () => this.listeners[event].delete(listener)
  }
  emit(event: EventName, value?: number) {
    for (const listener of [...this.listeners[event]]) listener(value)
  }
}

function useFake() {
  const fake = new FakeWaveSurfer()
  player.set(fake as unknown as WaveSurfer)
  return fake
}

test('candidate audition uses regular playback after seeking and stops at its boundary', async () => {
  const fake = useFake()
  player.auditionRange(2, 4, 0)
  await Promise.resolve()

  assert.deepEqual(fake.playCalls, [[undefined, undefined]], 'audition must use the same no-argument play path as transport')
  assert.deepEqual(fake.setTimes, [2])
  fake.advance(4)
  assert.equal(fake.pauseCount, 2, 'audition pauses before playback and at the bounded end')
  assert.equal(fake.getCurrentTime(), 4)
})

test('cut audition plays the before and after ranges without waiting for natural audio finish', async () => {
  const fake = useFake()
  player.auditionSkip(3, 5, 0.5)
  await Promise.resolve()
  assert.deepEqual(fake.setTimes, [2.5])
  assert.equal(fake.playCalls.length, 1)

  fake.advance(3)
  await Promise.resolve()
  assert.deepEqual(fake.setTimes, [2.5, 3, 5])
  assert.equal(fake.playCalls.length, 2, 'after-cut context should begin at the proposed end')

  fake.advance(5.5)
  assert.equal(fake.getCurrentTime(), 5.5, 'the after-cut range clamps to its bounded endpoint')
  assert.equal(fake.pauseCount, 4, 'each before/after segment pauses at its own endpoint')
})

test('a later audition cancels stale range listeners', async () => {
  const fake = useFake()
  player.auditionRange(1, 2, 0)
  player.auditionRange(6, 7, 0)
  await Promise.resolve()

  fake.advance(2)
  assert.equal(fake.pauseCount, 2, 'the earlier range cannot stop the newer audition')
  fake.advance(7)
  assert.equal(fake.getCurrentTime(), 7, 'the second audition owns the current bounded range')
})

test('a collapsed audition cancels an already-running review range', async () => {
  const fake = useFake()
  player.auditionRange(1, 2, 0)
  player.auditionRange(4, 4, 0)
  await Promise.resolve()

  assert.equal(fake.pauseCount, 2, 'a collapsed replacement request stops the prior audible review')
  fake.advance(2)
  assert.equal(fake.getCurrentTime(), 2, 'the stale range listener was removed')
})

test('waveform reload cancellation removes a pending review boundary', async () => {
  const fake = useFake()
  player.auditionRange(1, 2, 0)
  player.cancelAudition()
  await Promise.resolve()

  fake.advance(2)
  assert.equal(fake.pauseCount, 1, 'reload cancellation must not pause future audio at an old audition boundary')
})
