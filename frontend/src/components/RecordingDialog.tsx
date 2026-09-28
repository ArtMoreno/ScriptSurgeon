import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import {
  defaultRecordingProjectName,
  normalizeProjectName,
  projectNameFromFilename,
  PROJECT_NAME_MAX_LENGTH,
} from '../lib/projectRecording'
import {
  RECORDING_CLOSE_REQUEST_EVENT,
  type RecordingCloseRequestDetail,
} from '../lib/nativeRecordingClose'
import {
  activeTake,
  capturedAudio,
  MAX_TAKES,
  addTake,
  clockMs,
  discardTake as discardFromStack,
  emptyTakeStack,
  formatElapsed,
  pauseClock,
  resumeClock,
  selectTake,
  startClock,
  takeLabel,
  type RecorderClock,
  type Take,
  type TakeStack,
} from '../lib/recorderSession'
import {
  analyseFrame,
  decayPeak,
  toMeterScale,
  verdict,
  VERDICT_LABEL,
  type LevelVerdict,
} from '../lib/levelMeter'
import { BrandMark, CloseIcon, PauseIcon, PlayIcon, UploadIcon } from './Icons'
import { PRODUCT_FILE_STEM, PRODUCT_NAME } from '../lib/branding'
import { RECORDER_DEVICE_KEY, RECORDER_PROCESSING_KEY } from '../lib/workspacePreferences'

interface RecordingDialogBaseProps {
  busy: boolean
  onClose: () => void
}

interface InsertRecordingDialogProps extends RecordingDialogBaseProps {
  mode: 'create' | 'replace'
  anchorLabel?: string
  initialText?: string
  onSave: (file: File, text: string) => Promise<void>
}

interface ProjectRecordingDialogProps extends RecordingDialogBaseProps {
  mode: 'project'
  initialProjectName?: string
  onSaveProject: (file: File, projectName: string) => Promise<void>
}

export type RecordingDialogProps = InsertRecordingDialogProps | ProjectRecordingDialogProps

const SUPPORTED_IMPORT_MIME = new Set([
  'audio/aac',
  'audio/flac',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/webm',
  'video/webm',
  'audio/mp4',
  'video/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/x-flac',
  'audio/x-m4a',
  'audio/wave',
  'application/ogg',
])

function recordingExtension(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('ogg')) return 'ogg'
  return 'webm'
}

function isSupportedImport(file: File): boolean {
  if (/\.(?:mp3|wav|m4a|mp4|aac|ogg|flac|webm)$/i.test(file.name)) return true
  const mimeType = file.type.split(';', 1)[0].trim().toLowerCase()
  return SUPPORTED_IMPORT_MIME.has(mimeType)
}

function microphoneError(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `Microphone permission was denied. Allow microphone access for ${PRODUCT_NAME} in your system settings, then try again.`
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found. Connect or enable an input device, then try again.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is unavailable or already in use by another application.'
  }
  if (name === 'OverconstrainedError') return 'The microphone does not support the requested recording settings.'
  if (name === 'AbortError') return 'Microphone access was interrupted. Please try again.'
  return error instanceof Error && error.message.trim()
    ? `The microphone could not start. ${error.message}`
    : 'The microphone could not start. Check the device and try again.'
}

function preferredMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/ogg;codecs=opus',
  ].find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? ''
}

/**
 * One constraint set for both the pre-roll level check and the take itself, so
 * what you hear while setting gain is what actually gets recorded.
 *
 * The browser's echo cancellation, noise suppression, and auto gain control are
 * one switch rather than three: they are a single "clean up my voice" posture,
 * and for a set-your-own-gain microphone they are the thing you turn off.
 */
function audioConstraints(deviceId: string, processing: boolean): MediaTrackConstraints {
  return {
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  }
}

/** Unique enough to key a take within one dialog session. */
function newTakeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function recordingFileName(extension: string): string {
  return `${PRODUCT_FILE_STEM}-recording-${Date.now()}.${extension}`
}

function storedPreference(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback
  } catch {
    return fallback // A locked-down WebView still records; it just forgets.
  }
}

function rememberPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch { /* Persisting a preference must never break a take. */ }
}

export default function RecordingDialog(props: RecordingDialogProps) {
  const { mode, busy, onClose } = props
  const isProject = mode === 'project'
  const titleId = useId()
  const descriptionId = useId()
  const confirmTitleId = useId()
  const confirmDescriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const recordButtonRef = useRef<HTMLButtonElement>(null)
  const keepButtonRef = useRef<HTMLButtonElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const monitorStreamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const clockRef = useRef<RecorderClock>({ accumulatedMs: 0, segmentStartedAt: null })
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const meterFrameRef = useRef<number | null>(null)
  const peakRef = useRef(0)
  const waveformRef = useRef<HTMLCanvasElement>(null)
  const wavePaintedRef = useRef(false)
  const monitorRequestRef = useRef(0)
  const [checking, setChecking] = useState(false)
  /** True once the meter has painted at least one frame this session. */
  const [wavePainted, setWavePainted] = useState(false)
  const [clipped, setClipped] = useState(false)
  const takesRef = useRef<TakeStack>(emptyTakeStack)
  const mediaRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const recorderFailedRef = useRef(false)
  const pendingNativeCloseRef = useRef<RecordingCloseRequestDetail['respond'] | null>(null)
  const stopRecordingRef = useRef<() => void>(() => undefined)
  const nativeCloseStateRef = useRef({ recording: false, saving: false, hasUnsavedTake: false })
  const projectNameTouchedRef = useRef(mode === 'project' && Boolean(props.initialProjectName))
  const [text, setText] = useState(mode === 'project' ? '' : props.initialText ?? '')
  const [projectName, setProjectName] = useState(
    mode === 'project' ? props.initialProjectName || defaultRecordingProjectName() : '',
  )
  const [takes, setTakes] = useState<TakeStack>(emptyTakeStack)
  const [recording, setRecording] = useState(false)
  const [paused, setPaused] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState({ scale: 0, peak: 0, verdict: 'silent' as LevelVerdict })
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState(() => storedPreference(RECORDER_DEVICE_KEY, ''))
  // Off means the raw input is captured. Kept opt-in-shaped but defaulted to
  // the previous behavior so an existing project sounds the same as it did.
  const [voiceProcessing, setVoiceProcessing] = useState(
    () => storedPreference(RECORDER_PROCESSING_KEY, 'on') !== 'off',
  )
  const [monitoring, setMonitoring] = useState(false)
  /** Bumped after a granted permission so device labels can be re-read. */
  const [deviceEpoch, setDeviceEpoch] = useState(0)

  // A remembered input that has since been unplugged would make an exact
  // deviceId constraint throw. Fall back to the system default by deriving it,
  // rather than rewriting state: the stored choice survives, so the device is
  // picked up again if it comes back.
  const deviceMissing = Boolean(deviceId) && devices.length > 0
    && !devices.some((device) => device.deviceId === deviceId)
  const activeDeviceId = deviceMissing ? '' : deviceId
  const [starting, setStarting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [error, setError] = useState('')
  const saving = busy || submitting

  const clearTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
  }

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  /** Release every object URL this dialog created. */
  const revokeAllTakes = () => {
    takesRef.current.takes.forEach((entry) => URL.revokeObjectURL(entry.url))
    takesRef.current = emptyTakeStack
  }

  const applyStack = (change: { stack: TakeStack; evicted: Take[] }) => {
    change.evicted.forEach((entry) => URL.revokeObjectURL(entry.url))
    takesRef.current = change.stack
    setTakes(change.stack)
  }

  const keepTake = (file: File, source: Take['source'], durationMs: number) => {
    applyStack(addTake(takesRef.current, {
      id: newTakeId(),
      file,
      url: URL.createObjectURL(file),
      durationMs,
      source,
    }))
  }

  const stopMeter = () => {
    if (meterFrameRef.current !== null) window.cancelAnimationFrame(meterFrameRef.current)
    meterFrameRef.current = null
    analyserRef.current = null
    peakRef.current = 0
    const context = audioContextRef.current
    audioContextRef.current = null
    if (context && context.state !== 'closed') void context.close().catch(() => undefined)
    setLevel({ scale: 0, peak: 0, verdict: 'silent' })
  }

  /**
   * Drive the input meter off the live stream. This is display only - the
   * recorded bytes come from MediaRecorder and never pass through here.
   */
  const startMeter = (stream: MediaStream) => {
    stopMeter()
    const AudioContextCtor = window.AudioContext ?? (window as unknown as {
      webkitAudioContext?: typeof AudioContext
    }).webkitAudioContext
    if (!AudioContextCtor) return
    let context: AudioContext
    try {
      context = new AudioContextCtor()
    } catch {
      return // A meter is a nicety; never let it stop a take from starting.
    }
    audioContextRef.current = context
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser)
    analyserRef.current = analyser

    const samples = new Float32Array(analyser.fftSize)
    const history: number[] = []
    let lastPaint = 0
    const tick = () => {
      const current = analyserRef.current
      if (!current || !mountedRef.current) return
      current.getFloatTimeDomainData(samples)
      const frame = analyseFrame(samples)
      if (frame.peak >= 0.99) setClipped(true)
      const now = performance.now()
      if (now - lastPaint >= 80) {
        lastPaint = now
        history.push(toMeterScale(frame.rms))
        if (history.length > 180) history.shift()
        const canvas = waveformRef.current
        const paint = canvas?.getContext('2d')
        if (canvas && paint) {
          if (!wavePaintedRef.current) { wavePaintedRef.current = true; setWavePainted(true) }
          paint.clearRect(0, 0, canvas.width, canvas.height)
          paint.fillStyle = recorderRef.current ? '#ee643f' : '#3caaa2'
          const step = 4
          const offset = Math.max(0, canvas.width - history.length * step)
          history.forEach((value, i) => {
            const height = Math.max(2, value * (canvas.height - 8))
            paint.fillRect(offset + i * step, (canvas.height - height) / 2, 2, height)
          })
        }
      }
      peakRef.current = decayPeak(peakRef.current, frame.peak)
      setLevel({
        scale: toMeterScale(frame.rms),
        peak: toMeterScale(peakRef.current),
        verdict: verdict(frame),
      })
      meterFrameRef.current = window.requestAnimationFrame(tick)
    }
    meterFrameRef.current = window.requestAnimationFrame(tick)
  }

  const stopMonitor = () => {
    monitorRequestRef.current += 1
    stopMeter()
    monitorStreamRef.current?.getTracks().forEach((track) => track.stop())
    monitorStreamRef.current = null
    if (mountedRef.current) { setMonitoring(false); setChecking(false) }
  }

  /**
   * Open the input and run the meter without recording, so a gain that is too
   * hot is visible before the take rather than discovered after it.
   */
  const startMonitor = async () => {
    stopMonitor()
    const request = ++monitorRequestRef.current
    setError('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This WebView cannot open a microphone. You can import an audio file instead.')
      return
    }
    setChecking(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(activeDeviceId, voiceProcessing),
      })
      if (!mountedRef.current || request !== monitorRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      monitorStreamRef.current = stream
      startMeter(stream)
      setMonitoring(true)
      // Labels are blank until permission has been granted once; now they are not.
      setDeviceEpoch((epoch) => epoch + 1)
    } catch (caught) {
      if (mountedRef.current && request === monitorRequestRef.current) setError(microphoneError(caught))
    } finally {
      if (mountedRef.current && request === monitorRequestRef.current) setChecking(false)
    }
  }

  const abandonRecorder = () => {
    mediaRequestRef.current += 1
    stopMonitor()
    clearTimer()
    stopMeter()
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
      if (recorder.state !== 'inactive') {
        try { recorder.stop() } catch { /* The recorder may already be stopping. */ }
      }
    }
    chunksRef.current = []
    stopTracks()
  }

  const focusRecordButton = () => {
    window.requestAnimationFrame(() => {
      if (mountedRef.current) recordButtonRef.current?.focus({ preventScroll: true })
    })
  }

  useEffect(() => {
    mountedRef.current = true
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus({ preventScroll: true })
    })
    return () => {
      mountedRef.current = false
      window.cancelAnimationFrame(frame)
      abandonRecorder()
      revokeAllTakes()
    }
  // Mount and unmount only. The cleanup deliberately captures the first
  // abandonRecorder/revokeAllTakes; re-running it on every render would tear
  // down a take in progress.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * List input devices. Labels stay blank until the user has granted
   * permission once, so this reruns after a take starts rather than only on
   * mount - otherwise the picker reads "Microphone 1, Microphone 2" forever.
   */
  useEffect(() => {
    const media = navigator.mediaDevices
    if (!media?.enumerateDevices) return
    let cancelled = false
    const refresh = () => {
      media.enumerateDevices().then((found) => {
        if (cancelled || !mountedRef.current) return
        setDevices(found.filter((device) => device.kind === 'audioinput'))
      }).catch(() => undefined)
    }
    refresh()
    media.addEventListener?.('devicechange', refresh)
    return () => {
      cancelled = true
      media.removeEventListener?.('devicechange', refresh)
    }
  }, [recording, deviceEpoch])

  useEffect(() => {
    rememberPreference(RECORDER_DEVICE_KEY, deviceId)
    rememberPreference(RECORDER_PROCESSING_KEY, voiceProcessing ? 'on' : 'off')
    // A check already running is now showing the wrong input or the wrong
    // processing, so reopen it against the new choice.
    // Reopening the microphone is exactly the external-system synchronization
    // effects exist for; the state it sets is the result of that device work.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (monitoring && !recording) void startMonitor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, voiceProcessing])

  const current = activeTake(takes)
  const audioFile = current?.file ?? null
  const previewUrl = current?.url ?? null
  const hasUnsavedTake = recording || takes.takes.length > 0
  useEffect(() => {
    window.__scriptcutUnsavedRecording = hasUnsavedTake
    const warnOnReload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    if (hasUnsavedTake) window.addEventListener('beforeunload', warnOnReload)
    return () => window.removeEventListener('beforeunload', warnOnReload)
  }, [hasUnsavedTake])

  useEffect(() => () => {
    window.__scriptcutUnsavedRecording = false
  }, [])

  const beginRecording = async () => {
    if (takesRef.current.takes.length >= MAX_TAKES) { setError('Save or download and discard a take before recording another. Your existing takes are preserved.'); return }
    setError('')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Microphone recording is not supported in this window. You can import an audio file instead.')
      return
    }
    const request = ++mediaRequestRef.current
    setStarting(true)
    try {
      stopMonitor()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints(activeDeviceId, voiceProcessing),
      })
      if (!mountedRef.current || request !== mediaRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      abandonRecorder()
      // abandonRecorder increments the token; this request becomes current again
      // after previous recorder/device state has been released.
      mediaRequestRef.current = request
      streamRef.current = stream
      chunksRef.current = []
      recorderFailedRef.current = false
      const mimeType = preferredMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      let finished = false
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onerror = (event) => {
        recorderFailedRef.current = true
        const detail = (event as Event & { error?: DOMException }).error
        if (mountedRef.current) setError(microphoneError(detail ?? new Error('Recorder error')))
        try {
          if (recorder.state !== 'inactive') recorder.stop()
          else { /* onstop follows the final data event even on an error. */ }
        } catch {
          recorder.onstop?.(new Event('stop'))
        }
      }
      recorder.onstop = () => {
        if (finished) return
        finished = true
        clearTimer()
        clockRef.current = pauseClock(clockRef.current, performance.now())
        stopMeter()
        stopTracks()
        recorderRef.current = null
        if (!mountedRef.current) return
        setRecording(false)
        const type = recorder.mimeType || mimeType || 'audio/webm'
        const blob = capturedAudio(chunksRef.current, type)
        chunksRef.current = []
        setPaused(false)
        if (!blob) {
          setError(takesRef.current.takes.length
            ? 'No new audio was captured. Your previous take is still available.'
            : 'No audio was captured. Check the microphone level and record again.')
          return
        }
        const file = new File([blob], recordingFileName(recordingExtension(type)), { type })
        keepTake(file, 'recorded', clockMs(clockRef.current, performance.now()))
        if (recorderFailedRef.current) setError('Recording was interrupted. Captured audio is available below; preview or download it before continuing.')
      }
      stream.getAudioTracks().forEach(track => {
        track.onended = () => {
          if (finished || !mountedRef.current) return
          recorderFailedRef.current = true
          setError('Microphone disconnected. Recovering the captured audio…')
          stopRecordingRef.current()
        }
      })
      recorder.start(250)
      setClipped(false)
      startMeter(stream)
      // Reached only from an event handler, never during render.
      // eslint-disable-next-line react-hooks/purity
      clockRef.current = startClock(performance.now())
      setElapsed(0)
      setPaused(false)
      setRecording(true)
      timerRef.current = setInterval(() => {
        if (mountedRef.current) setElapsed(clockMs(clockRef.current, performance.now()))
      }, 250)
    } catch (caught) {
      recorderRef.current = null
      stopTracks()
      if (mountedRef.current && request === mediaRequestRef.current) {
        setRecording(false)
        setError(microphoneError(caught))
      }
    } finally {
      if (mountedRef.current && request === mediaRequestRef.current) setStarting(false)
    }
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    clearTimer()
    // Reached only from an event handler, never during render.
    // eslint-disable-next-line react-hooks/purity
    clockRef.current = pauseClock(clockRef.current, performance.now())
    stopMeter()
    try {
      recorder.stop()
    } catch (caught) {
      recorderFailedRef.current = true
      recorder.onstop?.(new Event('stop'))
      setError(microphoneError(caught))
    }
  }

  /**
   * Pause without ending the take. MediaRecorder keeps the chunk list, so
   * resuming continues the same file rather than starting a second one.
   */
  const togglePause = () => {
    const recorder = recorderRef.current
    if (!recorder) return
    try {
      if (recorder.state === 'recording') {
        recorder.pause()
        // Reached only from an event handler, never during render.
        // eslint-disable-next-line react-hooks/purity
        clockRef.current = pauseClock(clockRef.current, performance.now())
        // Reached only from an event handler, never during render.
        // eslint-disable-next-line react-hooks/purity
        setElapsed(clockMs(clockRef.current, performance.now()))
        setPaused(true)
      } else if (recorder.state === 'paused') {
        recorder.resume()
        // Reached only from an event handler, never during render.
        // eslint-disable-next-line react-hooks/purity
        clockRef.current = resumeClock(clockRef.current, performance.now())
        setPaused(false)
      }
    } catch (caught) {
      setError(microphoneError(caught))
    }
  }

  // Both are read by the native close handler, which fires long after this
  // render, so writing them in an effect keeps render itself side-effect free
  // while leaving the values just as fresh.
  useEffect(() => {
    stopRecordingRef.current = stopRecording
    nativeCloseStateRef.current = { recording, saving, hasUnsavedTake }
  })

  const resolveNativeClose = (discardAndClose: boolean) => {
    const respond = pendingNativeCloseRef.current
    pendingNativeCloseRef.current = null
    respond?.(discardAndClose)
  }

  /** Drop one take. Earlier takes stay available; nothing else is disturbed. */
  const discardOneTake = (id: string) => {
    applyStack(discardFromStack(takesRef.current, id))
    setError('')
    focusRecordButton()
  }

  const chooseTake = (id: string) => {
    const stack = selectTake(takesRef.current, id)
    takesRef.current = stack
    setTakes(stack)
  }

  const importAudio = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (takesRef.current.takes.length >= MAX_TAKES) { setError('Save or download and discard a take before importing another.'); return }
    if (!isSupportedImport(file)) {
      setError(isProject
        ? 'Choose an MP3, WAV, M4A, MP4, AAC, OGG, FLAC, or WebM file for this project.'
        : 'Choose an MP3, WAV, M4A, MP4, AAC, OGG, FLAC, or WebM file for this insert.')
      return
    }
    if (!file.size) {
      setError(audioFile
        ? 'That audio file is empty. Your previous take is still available.'
        : 'That audio file is empty. Choose another file.')
      return
    }
    abandonRecorder()
    setRecording(false)
    setPaused(false)
    setStarting(false)
    setElapsed(0)
    setError('')
    keepTake(file, 'imported', 0)
    if (isProject && !projectNameTouchedRef.current) {
      const importedName = projectNameFromFilename(file.name)
      if (importedName) setProjectName(importedName)
    }
  }

  const finishClose = () => {
    resolveNativeClose(true)
    abandonRecorder()
    revokeAllTakes()
    onClose()
  }

  const requestClose = () => {
    if (saving || confirmingClose) return
    if (recording || audioFile) {
      // Pause rather than stop: asking whether to close should not itself end
      // the take, or answering "keep recording" would be a lie.
      if (recording && !paused) togglePause()
      setConfirmingClose(true)
      setError('')
      window.requestAnimationFrame(() => keepButtonRef.current?.focus({ preventScroll: true }))
      return
    }
    finishClose()
  }

  const keepRecording = () => {
    resolveNativeClose(false)
    setConfirmingClose(false)
    if (recorderRef.current?.state === 'paused') togglePause()
    focusRecordButton()
  }

  useEffect(() => {
    const handleNativeCloseRequest = (rawEvent: Event) => {
      const request = (rawEvent as CustomEvent<RecordingCloseRequestDetail>).detail
      if (!request || typeof request.respond !== 'function') return
      request.handled = true

      const current = nativeCloseStateRef.current
      if (!current.hasUnsavedTake) {
        request.respond(true)
        return
      }
      if (current.saving) {
        request.respond(false)
        return
      }

      resolveNativeClose(false)
      pendingNativeCloseRef.current = request.respond
      if (current.recording) stopRecordingRef.current()
      setConfirmingClose(true)
      setError('')
      window.requestAnimationFrame(() => keepButtonRef.current?.focus({ preventScroll: true }))
    }

    window.addEventListener(RECORDING_CLOSE_REQUEST_EVENT, handleNativeCloseRequest)
    return () => {
      window.removeEventListener(RECORDING_CLOSE_REQUEST_EVENT, handleNativeCloseRequest)
      resolveNativeClose(false)
    }
  }, [])

  const save = async () => {
    if (!audioFile) {
      setError(isProject
        ? 'Record or import audio before creating this project.'
        : 'Record or import audio before saving this insert.')
      return
    }

    let value: string
    if (isProject) {
      value = normalizeProjectName(projectName)
      if (!value) {
        setError('Enter a project name before saving this recording.')
        return
      }
    } else {
      value = text.trim()
      if (!value) {
        setError('Enter the words spoken in this insert so the transcript stays editable.')
        return
      }
    }

    setError('')
    setSubmitting(true)
    try {
      if (props.mode === 'project') await props.onSaveProject(audioFile, value)
      else await props.onSave(audioFile, value)
      if (mountedRef.current) onClose()
    } catch (caught) {
      if (mountedRef.current) {
        const fallback = isProject
          ? 'The recording could not be saved as a project. Try again.'
          : 'The inserted recording could not be saved. Try again.'
        setError(caught instanceof Error && caught.message.trim() ? caught.message : fallback)
      }
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (confirmingClose) keepRecording()
      else requestClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), a[href], textarea:not(:disabled), input:not(:disabled), audio[controls]',
    )).filter((element) => element.offsetParent !== null)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const title = mode === 'project'
    ? 'Record a new project'
    : mode === 'replace'
      ? 'Re-record inserted audio'
      : 'Record an insert'
  const description = mode === 'project'
    ? 'Record from your microphone, review the take, then save it for local transcription.'
    : mode === 'replace'
      ? 'Capture a fresh take for this inserted passage. Its transcript and placement stay editable.'
      : `Capture a new passage${props.anchorLabel ? ` ${props.anchorLabel}` : ''}, then type exactly what you said.`
  const captureStatus = starting
    ? 'Opening microphone.'
    : paused
      ? `Recording paused at ${formatElapsed(elapsed)}.`
      : recording
        ? 'Recording in progress.'
        : previewUrl
          ? 'Recording stopped. Preview ready.'
          : ''

  const meterSegments = 28
  const litSegments = Math.round(level.scale * meterSegments)
  const peakSegment = Math.round(level.peak * meterSegments)
  const meterLive = recording || starting || monitoring
  const meterHot = level.verdict === 'clipping' || level.verdict === 'hot'
  const stageState = starting ? 'starting' : recording ? (paused ? 'paused' : 'recording') : previewUrl ? 'reviewing' : 'idle'
  const recordLabel = starting
    ? 'Opening microphone…'
    : takes.takes.length
      ? 'Record another take'
      : isProject ? 'Start recording' : 'Record'
  const canSave = !saving && !recording && !starting && Boolean(audioFile) && (isProject ? Boolean(projectName.trim()) : Boolean(text.trim()))

  return (
    <div
      className="fixed inset-0 z-[100] flex min-h-0 items-center justify-center overflow-hidden bg-black/45 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        // A stray click beside the dialog must never interrupt a take or throw
        // one away. Only an empty recorder is dismissible this way; otherwise
        // closing is deliberate - the Close button, Cancel, or Escape.
        if (hasUnsavedTake || starting) return
        requestClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={confirmingClose ? confirmTitleId : titleId}
        aria-describedby={confirmingClose ? confirmDescriptionId : descriptionId}
        onKeyDown={handleDialogKeyDown}
        className="recorder-dialog"
      >
        <div className="recorder-head">
          <span className="recorder-head-icon"><BrandMark size={40} /></span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={saving || confirmingClose}
            className="toolbar-icon-button shrink-0"
            aria-label="Close recording dialog"
          >
            <CloseIcon />
          </button>
        </div>

        {confirmingClose ? (
          <div className="recorder-body">
            <div className="recorder-confirm">
              <h3 id={confirmTitleId}>Discard this unsaved recording?</h3>
              <p id={confirmDescriptionId}>
                The current take has not been saved. Continue reviewing it, or discard it and close.
              </p>
              <div className="review-actions" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
                <button ref={keepButtonRef} type="button" onClick={keepRecording} className="review-btn">Continue reviewing</button>
                <button type="button" onClick={finishClose} className="review-btn is-danger">Discard and close</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="recorder-body">
              <section aria-label="Audio capture" className={`recorder-stage is-${stageState}`}>
                <div className="recorder-stage-top">
                  <div className="recorder-transport">
                    {recording ? (
                      <>
                        <button
                          ref={recordButtonRef}
                          type="button"
                          data-initial-focus
                          onClick={stopRecording}
                          className="recorder-main is-stop"
                          aria-label="Stop recording"
                          title="Stop recording"
                        >
                          <span className="recorder-stop-square" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={togglePause}
                          className="recorder-secondary"
                          aria-pressed={paused}
                          title={paused ? 'Resume recording' : 'Pause recording'}
                        >
                          {paused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
                          {paused ? 'Resume' : 'Pause'}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          ref={recordButtonRef}
                          type="button"
                          data-initial-focus
                          onClick={() => void beginRecording()}
                          disabled={starting || saving}
                          className="recorder-main"
                          aria-label={recordLabel}
                          title={recordLabel}
                        >
                          <span className="recorder-record-dot" aria-hidden="true" />
                        </button>
                        <div className="recorder-main-copy">
                          <strong>{recordLabel}</strong>
                          <span>{starting ? 'Waiting for the microphone' : takes.takes.length ? 'Earlier takes stay available' : 'Space or Enter also starts'}</span>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="recorder-clock-block">
                    <span className={`recorder-state is-${stageState}`}>
                      <span className="recorder-state-dot" aria-hidden="true" />
                      {stageState === 'recording' ? 'Recording' : stageState === 'paused' ? 'Paused' : stageState === 'starting' ? 'Opening mic' : stageState === 'reviewing' ? 'Take ready' : 'Ready'}
                    </span>
                    <span className="recorder-clock" aria-label={`Recording duration ${formatElapsed(elapsed)}`}>
                      {formatElapsed(elapsed)}
                    </span>
                  </div>
                </div>

                <div className="recorder-wave">
                  <canvas ref={waveformRef} width={720} height={96} role="img" aria-label="Live microphone level history" />
                  {!wavePainted && (
                    <span className="recorder-wave-empty">
                      {isProject ? 'Your waveform appears here while you record.' : 'The waveform of this take appears here.'}
                    </span>
                  )}
                </div>

                <div className="recorder-meter-row">
                  {!recording && (
                    <button
                      type="button"
                      onClick={() => (monitoring || checking ? stopMonitor() : void startMonitor())}
                      disabled={starting || saving}
                      aria-pressed={monitoring}
                      className={`recorder-check${monitoring ? ' is-on' : ''}`}
                      title="Open the microphone and watch the level without recording"
                    >
                      <span aria-hidden="true" className="recorder-state-dot" />
                      {checking ? 'Cancel' : monitoring ? 'Stop check' : 'Check level'}
                    </button>
                  )}
                  <div
                    className="recorder-meter"
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(level.scale * 100)}
                    aria-label="Microphone input level"
                  >
                    {Array.from({ length: meterSegments }, (_, index) => {
                      const zone = index >= meterSegments * 0.88 ? 'hot' : index >= meterSegments * 0.7 ? 'warm' : 'ok'
                      const lit = index < litSegments
                      const peak = level.peak > 0 && index === Math.min(meterSegments - 1, peakSegment)
                      return <span key={index} className={`recorder-seg is-${zone}${lit ? ' is-lit' : ''}${peak ? ' is-peak' : ''}`} />
                    })}
                  </div>
                  <span className={`recorder-verdict${meterHot ? ' is-hot' : meterLive && level.verdict === 'good' ? ' is-good' : ''}`} aria-live="polite">
                    {meterLive ? VERDICT_LABEL[level.verdict] : clipped ? 'Clipped last take' : 'No signal yet'}
                  </span>
                </div>
                {clipped && recording && <p role="status" className="recorder-warn">Clipping. Lower your microphone gain for the next take.</p>}
                <span className="sr-only" role="status" aria-live="polite">{captureStatus}</span>
              </section>

              <div className="recorder-setup">
                <label htmlFor={`${titleId}-device`}>
                  <span className="recorder-setup-label">Microphone</span>
                  <select
                    id={`${titleId}-device`}
                    className="app-select"
                    value={activeDeviceId}
                    onChange={(event) => setDeviceId(event.target.value)}
                    disabled={saving || starting || recording || checking}
                  >
                    <option value="">System default</option>
                    {devices.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Microphone ${index + 1}`}
                      </option>
                    ))}
                  </select>
                  <small>
                    {devices.length === 0
                      ? 'Run a level check to list your inputs.'
                      : devices.every((device) => !device.label)
                        ? 'Names appear after you allow the microphone once.'
                        : 'Remembered on this device.'}
                  </small>
                </label>
                <label htmlFor={`${titleId}-processing`}>
                  <span className="recorder-setup-label">Input processing</span>
                  <select
                    id={`${titleId}-processing`}
                    className="app-select"
                    value={voiceProcessing ? 'on' : 'off'}
                    onChange={(event) => setVoiceProcessing(event.target.value === 'on')}
                    disabled={saving || starting || recording || checking}
                  >
                    <option value="on">Clean up: noise suppression and auto gain</option>
                    <option value="off">Raw input: your gain, nothing added</option>
                  </select>
                  <small>{voiceProcessing ? 'Good for laptop and headset mics.' : 'Best for an interface with its own gain.'}</small>
                </label>
                <div className="recorder-import">
                  <span className="recorder-setup-label">Or use a file</span>
                  <input
                    ref={importRef}
                    type="file"
                    accept=".mp3,.wav,.m4a,.mp4,.aac,.ogg,.flac,.webm,audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/x-m4a,audio/mp4,audio/aac,audio/ogg,application/ogg,audio/flac,audio/x-flac,audio/webm,video/webm,video/mp4"
                    className="sr-only"
                    onChange={importAudio}
                    aria-label={isProject ? 'Import audio for new project' : 'Import insert audio'}
                  />
                  <button
                    type="button"
                    onClick={() => importRef.current?.click()}
                    disabled={recording || starting || saving}
                    className="recorder-secondary is-wide"
                  >
                    <UploadIcon className="h-4 w-4" />
                    Import audio
                  </button>
                  <small>MP3, WAV, M4A, FLAC, AAC, OGG, MP4, WebM</small>
                </div>
              </div>

              {takes.takes.length > 0 && !recording && (
                <section className="recorder-takes" aria-label="Recorded takes">
                  <div className="recorder-takes-head">
                    <h3>{takes.takes.length > 1 ? 'Your takes' : 'Your take'}</h3>
                    <span>{takes.takes.length}/{MAX_TAKES} kept · the selected take is the one that gets saved</span>
                  </div>
                  <div className="recorder-take-list" role="group" aria-label="Choose a take">
                    {takes.takes.map((entry) => {
                      const selected = entry.id === takes.activeId
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => chooseTake(entry.id)}
                          aria-pressed={selected}
                          className={`recorder-take${selected ? ' is-on' : ''}`}
                        >
                          <span className="recorder-take-radio" aria-hidden="true" />
                          <span className="recorder-take-name">{takeLabel(takes, entry.id)}</span>
                          <span className="recorder-take-meta">
                            {entry.durationMs > 0 ? formatElapsed(entry.durationMs) : entry.source === 'imported' ? 'file' : ''}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {previewUrl && (
                    <audio
                      key={previewUrl}
                      controls
                      preload="metadata"
                      src={previewUrl}
                      aria-label={isProject ? 'Preview new project recording' : 'Preview inserted audio'}
                    />
                  )}
                  <div className="recorder-takes-foot">
                    <span className="truncate">{audioFile?.name}</span>
                    {previewUrl && audioFile && <a href={previewUrl} download={audioFile.name}>Download</a>}
                    {current && (
                      <button type="button" onClick={() => discardOneTake(current.id)} disabled={saving} className="review-btn is-ghost is-danger-text">
                        Discard {takes.takes.length > 1 ? takeLabel(takes, current.id) : 'take'}
                      </button>
                    )}
                  </div>
                </section>
              )}

              {isProject ? (
                <label className="recorder-field" htmlFor={`${titleId}-project-name`}>
                  <span className="recorder-field-label">
                    Project name
                    <span>{projectName.length}/{PROJECT_NAME_MAX_LENGTH}</span>
                  </span>
                  <input
                    id={`${titleId}-project-name`}
                    type="text"
                    required
                    maxLength={PROJECT_NAME_MAX_LENGTH}
                    value={projectName}
                    onChange={(event) => {
                      projectNameTouchedRef.current = true
                      setProjectName(event.target.value)
                    }}
                    disabled={saving}
                    aria-label="Project name"
                    autoComplete="off"
                  />
                </label>
              ) : (
                <label className="recorder-field" htmlFor={`${titleId}-transcript`}>
                  <span className="recorder-field-label">
                    Spoken transcript <span>{text.length}/500</span>
                  </span>
                  <textarea
                    id={`${titleId}-transcript`}
                    required
                    maxLength={500}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    disabled={saving}
                    rows={3}
                    placeholder="Type the words spoken in this insert…"
                  />
                </label>
              )}

              {error && (
                <div role="alert" className="recorder-error">{error}</div>
              )}
            </div>

            <div className="recorder-foot">
              <span className="recorder-foot-hint">
                {!audioFile
                  ? isProject ? 'Record or import a take to continue.' : 'Record or import the passage to continue.'
                  : isProject ? 'Transcription runs on this computer after saving.' : ''}
              </span>
              <button type="button" onClick={requestClose} disabled={saving} className="review-btn is-ghost">Cancel</button>
              <button type="button" onClick={() => void save()} disabled={!canSave} className="review-btn is-primary is-large">
                {saving
                  ? isProject ? 'Saving…' : 'Saving…'
                  : mode === 'project'
                    ? 'Save and transcribe'
                    : mode === 'replace'
                      ? 'Replace recording'
                      : 'Save insert'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
