export interface SeekRequest {
  time: number
  autoplay: boolean
}

export function requestSeek(time: number, autoplay = false, target: EventTarget = window) {
  if (!Number.isFinite(time)) return
  target.dispatchEvent(new CustomEvent<SeekRequest>('scriptcut:seek', {
    detail: { time: Math.max(0, time), autoplay: Boolean(autoplay) },
  }))
}

export function onSeek(callback: (request: SeekRequest) => void, target: EventTarget = window) {
  const handler = (event: Event) => callback((event as CustomEvent<SeekRequest>).detail)
  target.addEventListener('scriptcut:seek', handler)
  return () => target.removeEventListener('scriptcut:seek', handler)
}
