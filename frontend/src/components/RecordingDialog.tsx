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
import { AudioIcon, CloseIcon, PauseIcon, PlayIcon, UploadIcon } from './Icons'
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
    return `Microphone permission was denied. Allow microphone access in Windows and ${PRODUCT_NAME}, then try again.`
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
  const monitorRequestRef = useRef(0)
  const [checking, setChecking] = useState(false)
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
          paint.clearRect(0, 0, canvas.width, canvas.height)
          paint.fillStyle = '#3caaa2'
          history.forEach((value, i) => {
            const height = Math.max(1, value * canvas.height)
            paint.fillRect(i * 4, (canvas.height - height) / 2, 2, height)
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
      setError('Microphone recording is not supported by this Windows WebView. You can import an audio file instead.')
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
        className="recorder-dialog flex max-h-[calc(100vh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-canvas-raised text-ink shadow-2xl shadow-ink/25 sm:max-h-[calc(100vh-3rem)]"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ember-soft text-ember-dark">
            <AudioIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-ink">{title}</h2>
            <p id={descriptionId} className="mt-1 text-[12px] leading-5 text-ink-muted">{description}</p>
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
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-7">
            <div className="rounded-2xl border border-ochre/30 bg-ochre-soft px-5 py-5">
              <h3 id={confirmTitleId} className="text-sm font-semibold text-ink">Discard this unsaved recording?</h3>
              <p id={confirmDescriptionId} className="mt-2 text-[12px] leading-5 text-ink-muted">
                The current take has not been saved. Continue reviewing it, or discard it and close.
              </p>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  ref={keepButtonRef}
                  type="button"
                  onClick={keepRecording}
                  className="h-10 rounded-lg border border-line-strong bg-canvas-raised px-4 text-[12px] font-medium text-ink hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                >
                  Continue reviewing
                </button>
                <button
                  type="button"
                  onClick={finishClose}
                  className="h-10 rounded-lg bg-danger px-4 text-[12px] font-semibold text-white hover:bg-danger-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                >
                  Discard and close
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <section aria-label="Audio capture" className="rounded-2xl border border-line bg-canvas-soft p-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  {recording ? (
                    <>
                      <button
                        ref={recordButtonRef}
                        type="button"
                        data-initial-focus
                        onClick={togglePause}
                        className="inline-flex h-11 items-center gap-2.5 rounded-xl bg-ember px-4 text-sm font-semibold text-on-accent hover:bg-ember-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                      >
                        {paused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
                        {paused ? 'Resume' : 'Pause'}
                      </button>
                      <button
                        type="button"
                        onClick={stopRecording}
                        className="inline-flex h-11 items-center gap-2.5 rounded-xl border border-line-strong bg-canvas-raised px-4 text-sm font-semibold text-ink hover:bg-canvas-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                      >
                        <span className="h-3 w-3 rounded-[2px] bg-danger" aria-hidden="true" />
                        Stop recording
                      </button>
                    </>
                  ) : (
                    <button
                      ref={recordButtonRef}
                      type="button"
                      data-initial-focus
                      onClick={() => void beginRecording()}
                      disabled={starting || saving}
                      className="inline-flex h-11 items-center gap-2.5 rounded-xl bg-ember px-4 text-sm font-semibold text-on-accent hover:bg-ember-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                    >
                      <AudioIcon className="h-4 w-4" />
                      {starting
                        ? 'Opening microphone...'
                        : takes.takes.length
                          ? 'Record another take'
                          : isProject ? 'Start recording' : 'Record'}
                    </button>
                  )}
                  <span
                    className={`recorder-clock font-mono text-sm tabular-nums ${
                      paused ? 'text-ochre-dark' : recording ? 'text-ember-dark' : 'text-ink-muted'
                    }`}
                    aria-label={`Recording duration ${formatElapsed(elapsed)}`}
                  >
                    {formatElapsed(elapsed)}
                  </span>
                  {paused && (
                    <span className="rounded-full bg-ochre-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ochre-dark">
                      Paused
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-2">
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
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-canvas-raised px-3 text-[12px] font-medium text-ink hover:bg-canvas-soft disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                    >
                      <UploadIcon className="h-4 w-4" />
                      Import
                    </button>
                  </div>
                </div>

                <canvas ref={waveformRef} width={720} height={72} className="recorder-waveform" role="img" aria-label="Live microphone level history" />
                {clipped && <p role="status" className="mt-2 text-[12px] text-danger-dark">Clipping detected during this take. Lower your microphone gain before the next take.</p>}
                {!recording && (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => (monitoring || checking ? stopMonitor() : void startMonitor())}
                      disabled={starting || saving}
                      aria-pressed={monitoring}
                      className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[12px] font-medium transition-colors disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember ${
                        monitoring
                          ? 'border border-forest/40 bg-forest-soft text-forest-dark'
                          : 'border border-line-strong bg-canvas-raised text-ink hover:bg-canvas-soft'
                      }`}
                      title="Open the microphone and watch the level without recording"
                    >
                      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${monitoring ? 'bg-forest' : 'bg-line-strong'}`} />
                      {checking ? 'Cancel microphone request' : monitoring ? 'Stop level check' : 'Check level'}
                    </button>
                    <span className="text-[11px] text-ink-muted">
                      {monitoring ? 'Speak normally and set your gain before recording.' : 'Set your gain before the take.'}
                    </span>
                  </div>
                )}

                <div className="mt-3.5">
                  <div
                    className="flex h-2.5 w-full overflow-hidden rounded-full bg-line"
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(level.scale * 100)}
                    aria-label="Microphone input level"
                  >
                    <div
                      className={`h-full rounded-full transition-[width] duration-75 ${
                        level.verdict === 'clipping' || level.verdict === 'hot' ? 'bg-danger' : 'bg-ember'
                      }`}
                      style={{ width: `${Math.round(level.scale * 100)}%` }}
                    />
                    {level.peak > 0 && (
                      <div
                        className="h-full w-0.5 bg-ink/50"
                        style={{ marginLeft: `${Math.max(0, Math.round((level.peak - level.scale) * 100))}%` }}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <p className={`mt-1.5 text-[11px] ${
                    level.verdict === 'clipping' || level.verdict === 'hot' ? 'text-danger-dark' : 'text-ink-muted'
                  }`}>
                    {recording || starting || monitoring
                      ? VERDICT_LABEL[level.verdict]
                      : 'Input level appears while recording, or press Check level first.'}
                  </p>
                </div>

{/* Always offered, even with a single input: the picker is also where you
                    confirm which microphone is about to be used. */}
                {(
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="block text-[11px] font-medium text-ink-muted" htmlFor={`${titleId}-device`}>
                      Microphone
                      <select
                        id={`${titleId}-device`}
                        value={activeDeviceId}
                        onChange={(event) => setDeviceId(event.target.value)}
                        disabled={saving || starting || recording || checking}
                        className="mt-1 h-9 w-full rounded-lg border border-line-strong bg-canvas-raised px-2 text-[12px] text-ink outline-none focus:border-ember focus:ring-2 focus:ring-ember/20 disabled:opacity-60"
                      >
                        <option value="">System default</option>
                        {devices.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Microphone ${index + 1}`}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[10px] text-ink-muted">
                        {devices.length === 0
                          ? 'No input listed yet. Run a level check to grant access.'
                          : devices.every((device) => !device.label)
                            ? 'Names appear once you have allowed microphone access once.'
                            : 'Remembered for next time on this device.'}
                      </span>
                    </label>

                    <label className="block text-[11px] font-medium text-ink-muted" htmlFor={`${titleId}-processing`}>
                      Input processing
                      <select
                        id={`${titleId}-processing`}
                        value={voiceProcessing ? 'on' : 'off'}
                        onChange={(event) => setVoiceProcessing(event.target.value === 'on')}
                        disabled={saving || starting || recording || checking}
                        className="mt-1 h-9 w-full rounded-lg border border-line-strong bg-canvas-raised px-2 text-[12px] text-ink outline-none focus:border-ember focus:ring-2 focus:ring-ember/20 disabled:opacity-60"
                      >
                        <option value="on">Clean up (noise suppression, auto gain)</option>
                        <option value="off">Raw input (recommended for a set-gain mic)</option>
                      </select>
                      <span className="mt-1 block text-[10px] text-ink-muted">
                        {voiceProcessing
                          ? 'The browser evens out level and cuts noise. Good for laptop mics.'
                          : 'Nothing is applied before recording. Your gain is what you get.'}
                      </span>
                    </label>
                  </div>
                )}

                <span className="sr-only" role="status" aria-live="polite">{captureStatus}</span>

                {takes.takes.length > 0 && !recording && (
                  <div className="mt-4 rounded-xl border border-plum/20 bg-plum-soft p-3">
                    <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
                      <h3 className="font-semibold text-plum-dark">
                        {takes.takes.length > 1 ? 'Your takes' : isProject ? 'Review your take' : 'Fresh preview'}
                      </h3>
                      <span className="truncate text-ink-muted">{audioFile?.name}</span>
                    </div>

                    {takes.takes.length > 1 && (
                      <div className="mb-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Recorded takes">
                        {takes.takes.map((entry) => {
                          const selected = entry.id === takes.activeId
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              onClick={() => chooseTake(entry.id)}
                              aria-pressed={selected}
                              className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember ${
                                selected
                                  ? 'bg-plum text-white'
                                  : 'border border-line-strong bg-canvas-raised text-ink hover:bg-canvas-soft'
                              }`}
                            >
                              {takeLabel(takes, entry.id)}
                              {entry.durationMs > 0 && (
                                <span className="font-mono tabular-nums opacity-70">{formatElapsed(entry.durationMs)}</span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {previewUrl && (
                      <audio
                        key={previewUrl}
                        controls
                        preload="metadata"
                        src={previewUrl}
                        className="h-10 w-full"
                        aria-label={isProject ? 'Preview new project recording' : 'Preview inserted audio'}
                      />
                    )}

                    <div className="mt-3 flex items-center justify-between gap-3">
                      {previewUrl && audioFile && <a href={previewUrl} download={audioFile.name} className="text-[12px] font-semibold text-ember-dark">Download take</a>}
                      <span className="text-[11px] text-ink-muted">
                        {takes.takes.length > 1
                          ? 'The selected take is the one that gets saved.'
                          : 'Recording again keeps this take so you can compare.'}
                      </span>
                      {current && (
                        <button
                          type="button"
                          onClick={() => discardOneTake(current.id)}
                          disabled={saving}
                          className="h-9 shrink-0 rounded-lg px-3 text-[12px] font-medium text-danger-dark hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                        >
                          Discard {takes.takes.length > 1 ? takeLabel(takes, current.id) : 'take'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </section>
              <p className="mt-3 text-[11px] text-ink-muted">{takes.takes.length}/{MAX_TAKES} takes kept in this session. Save or download important takes before closing. Earlier takes are never replaced by a new recording.</p>

              {isProject ? (
                <label className="mt-5 block" htmlFor={`${titleId}-project-name`}>
                  <span className="flex items-center justify-between gap-3 text-[12px] font-semibold text-ink">
                    Project name
                    <span className="font-normal tabular-nums text-ink-muted">{projectName.length}/{PROJECT_NAME_MAX_LENGTH}</span>
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
                    className="mt-2 h-11 w-full rounded-xl border border-line-strong bg-canvas-raised px-3.5 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-ember focus:ring-2 focus:ring-ember/20 disabled:opacity-60"
                  />
                </label>
              ) : (
                <label className="mt-5 block" htmlFor={`${titleId}-transcript`}>
                  <span className="flex items-center justify-between gap-3 text-[12px] font-semibold text-ink">
                    Spoken transcript <span className="font-normal tabular-nums text-ink-muted">{text.length}/500</span>
                  </span>
                  <textarea
                    id={`${titleId}-transcript`}
                    required
                    maxLength={500}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    disabled={saving}
                    rows={4}
                    placeholder="Type the words spoken in this insert..."
                    className="mt-2 w-full resize-y rounded-xl border border-line-strong bg-canvas-raised px-3.5 py-3 text-sm leading-6 text-ink outline-none placeholder:text-ink-muted focus:border-ember focus:ring-2 focus:ring-ember/20 disabled:opacity-60"
                  />
                </label>
              )}

              {error && (
                <div role="alert" className="mt-4 rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-3 text-[12px] leading-5 text-danger-dark">
                  {error}
                </div>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas-raised px-5 py-4">
              <button
                type="button"
                onClick={requestClose}
                disabled={saving}
                className="h-10 rounded-lg px-4 text-[12px] font-medium text-ink-muted hover:bg-canvas-soft disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || recording || starting || !audioFile || (isProject ? !projectName.trim() : !text.trim())}
                    className="inline-flex h-10 min-w-28 items-center justify-center gap-2 rounded-lg bg-ember px-4 text-[12px] font-semibold text-on-accent hover:bg-ember-hover disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
              >
                {saving
                  ? isProject ? 'Saving recording...' : 'Saving...'
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
