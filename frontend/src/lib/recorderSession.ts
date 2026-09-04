/**
 * Recorder state that is worth testing without a microphone attached.
 *
 * Two things live here. A clock that survives pausing, because elapsed time is
 * no longer "now minus when we started" once a take can be interrupted. And a
 * stack of takes, because re-recording used to overwrite the previous take with
 * no way back, which contradicts the rest of the app - nothing else here throws
 * audio away without offering it back.
 */

/** Takes past this are dropped oldest-first; each one pins a blob in memory. */
export const MAX_TAKES = 5

export interface RecorderClock {
  /** Completed run time from earlier segments. */
  accumulatedMs: number
  /** When the current segment began, or null while paused/stopped. */
  segmentStartedAt: number | null
}

export function startClock(now: number): RecorderClock {
  return { accumulatedMs: 0, segmentStartedAt: now }
}

export function pauseClock(clock: RecorderClock, now: number): RecorderClock {
  if (clock.segmentStartedAt === null) return clock
  return {
    accumulatedMs: clock.accumulatedMs + Math.max(0, now - clock.segmentStartedAt),
    segmentStartedAt: null,
  }
}

export function resumeClock(clock: RecorderClock, now: number): RecorderClock {
  if (clock.segmentStartedAt !== null) return clock
  return { ...clock, segmentStartedAt: now }
}

export function clockMs(clock: RecorderClock, now: number): number {
  const open = clock.segmentStartedAt === null ? 0 : Math.max(0, now - clock.segmentStartedAt)
  return clock.accumulatedMs + open
}

export interface Take {
  id: string
  file: File
  /** Object URL for preview playback. The owner revokes it on eviction. */
  url: string
  durationMs: number
  source: 'recorded' | 'imported'
}

export interface TakeStack {
  takes: Take[]
  activeId: string | null
}

export const emptyTakeStack: TakeStack = { takes: [], activeId: null }

export interface TakeStackChange {
  stack: TakeStack
  /** Takes the caller must revoke object URLs for. Never includes the active take. */
  evicted: Take[]
}

/** Add a take and make it active, evicting the oldest beyond the cap. */
export function addTake(stack: TakeStack, take: Take): TakeStackChange {
  const takes = [...stack.takes, take]
  const evicted: Take[] = []
  while (takes.length > MAX_TAKES) {
    const removed = takes.shift()
    if (removed) evicted.push(removed)
  }
  return { stack: { takes, activeId: take.id }, evicted }
}

export function selectTake(stack: TakeStack, id: string): TakeStack {
  return stack.takes.some((take) => take.id === id) ? { ...stack, activeId: id } : stack
}

/**
 * Drop one take. The neighbour before it becomes active so discarding the
 * newest take lands the user back on the one they kept, not on nothing.
 */
export function discardTake(stack: TakeStack, id: string): TakeStackChange {
  const index = stack.takes.findIndex((take) => take.id === id)
  if (index < 0) return { stack, evicted: [] }
  const removed = stack.takes[index]
  const takes = stack.takes.filter((take) => take.id !== id)
  let activeId = stack.activeId
  if (activeId === id) {
    const neighbour = takes[index - 1] ?? takes[index] ?? null
    activeId = neighbour ? neighbour.id : null
  }
  return { stack: { takes, activeId }, evicted: [removed] }
}

export function activeTake(stack: TakeStack): Take | null {
  return stack.takes.find((take) => take.id === stack.activeId) ?? null
}

/**
 * Human label for a take, numbered in capture order.
 *
 * Every take is numbered, including imports: two imported files with the same
 * word for a label are indistinguishable in the picker.
 */
export function takeLabel(stack: TakeStack, id: string): string {
  const index = stack.takes.findIndex((take) => take.id === id)
  if (index < 0) return 'Take'
  return `${stack.takes[index].source === 'imported' ? 'File' : 'Take'} ${index + 1}`
}

export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const stem = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return hours > 0 ? `${hours}:${stem}` : stem
}
