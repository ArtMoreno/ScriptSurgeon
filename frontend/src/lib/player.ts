import type WaveSurfer from 'wavesurfer.js'

let ws: WaveSurfer | null = null
let auditionRun = 0
let clearAuditionListeners: (() => void) | null = null

function cancelBoundedAudition() {
  auditionRun += 1
  clearAuditionListeners?.()
  clearAuditionListeners = null
}

function readyPlayer(): WaveSurfer | null {
  return ws?.getDecodedData() ? ws : null
}

/**
 * Play a bounded review range using the same plain `play()` path as the main
 * transport. WaveSurfer's `play(start, end)` has proved unreliable in the
 * media-element backend used by long installed projects: it can reject or
 * resolve without beginning playback after a seek. We own the stop point via
 * `timeupdate` instead, so candidate and cut audition behave like transport
 * playback while still stopping precisely at the review boundary.
 */
function playBoundedRange(
  instance: WaveSurfer,
  start: number,
  end: number,
  onComplete?: () => void,
): boolean {
  // Every new request (including a collapsed one) invalidates any prior
  // bounded audition so a stale callback cannot resume after a remap/reload.
  cancelBoundedAudition()
  // A mapped range may collapse after existing cuts. Cancelling its listener
  // must also stop the old audible review, rather than allowing it to continue
  // playing without an owned boundary callback.
  instance.pause()
  const run = auditionRun
  const duration = instance.getDuration()
  const rangeStart = Math.max(0, Math.min(start, duration))
  const rangeEnd = Math.max(rangeStart, Math.min(end, duration))
  if (rangeEnd - rangeStart < 0.01) return false

  let cleaned = false
  let offTime: () => void = () => undefined
  let offFinish: () => void = () => undefined
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    offTime()
    offFinish()
    if (clearAuditionListeners === cleanup) clearAuditionListeners = null
  }
  const complete = () => {
    if (run !== auditionRun) {
      cleanup()
      return
    }
    cleanup()
    onComplete?.()
  }
  const stopAtBoundary = () => {
    if (run !== auditionRun || cleaned) {
      cleanup()
      return
    }
    // WaveSurfer emits timeupdate synchronously from setTime. Remove this
    // listener before clamping the playhead, otherwise the same boundary can
    // recursively re-enter and accidentally chain a second review range.
    instance.pause()
    cleanup()
    instance.setTime(rangeEnd)
    complete()
  }
  offTime = instance.on('timeupdate', (time) => {
    if (run !== auditionRun) {
      cleanup()
      return
    }
    if (time >= rangeEnd - 0.005) {
      stopAtBoundary()
    }
  })
  offFinish = instance.on('finish', stopAtBoundary)
  clearAuditionListeners = cleanup

  instance.setTime(rangeStart)
  void instance.play().catch(() => cleanup())
  return true
}

export const player = {
  set(w: WaveSurfer | null) {
    if (ws !== w) {
      cancelBoundedAudition()
    }
    ws = w
  },
  /** Stop any pending bounded-review callback before the waveform reloads. */
  cancelAudition() { cancelBoundedAudition() },
  get() { return ws },
  playPause() {
    const instance = readyPlayer()
    if (instance) void instance.playPause().catch(() => undefined)
  },
  skip(d: number) {
    const instance = readyPlayer()
    if (!instance) return
    instance.setTime(Math.max(0, Math.min(instance.getCurrentTime() + d, instance.getDuration())))
  },
  /**
   * Play a short lead-in, skip the proposed cut, then play the short tail.
   * This previews an edit without replacing the loaded waveform or saving state.
   */
  auditionSkip(start: number, end: number, context = 0.65) {
    const instance = readyPlayer()
    if (!instance) return
    const duration = instance.getDuration()
    const beforeStart = Math.max(0, Math.min(start - context, duration))
    const beforeEnd = Math.max(beforeStart, Math.min(start, duration))
    const afterStart = Math.max(0, Math.min(end, duration))
    const afterEnd = Math.max(afterStart, Math.min(end + context, duration))
    const playAfter = () => {
      if (afterEnd - afterStart < 0.01) return
      playBoundedRange(instance, afterStart, afterEnd)
    }
    if (beforeEnd - beforeStart < 0.01) {
      playAfter()
      return
    }
    playBoundedRange(instance, beforeStart, beforeEnd, playAfter)
  },
  /** Play one reviewable candidate with a small amount of surrounding context. */
  auditionRange(start: number, end: number, context = 0.25) {
    const instance = readyPlayer()
    if (!instance) return
    const duration = instance.getDuration()
    const rangeStart = Math.max(0, Math.min(start - context, duration))
    const rangeEnd = Math.max(rangeStart, Math.min(end + context, duration))
    playBoundedRange(instance, rangeStart, rangeEnd)
  },
  zoom(px: number) { readyPlayer()?.zoom(px) },
  /** Pitch is preserved so sped-up review still sounds like the speaker. */
  setRate(rate: number) { ws?.setPlaybackRate(rate, true) },
}
