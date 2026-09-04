import { authHeaders } from './api.ts'

type ClientErrorSource = 'react' | 'window' | 'unhandled-rejection'

export interface ClientErrorContext {
  source: ClientErrorSource
  componentStack?: string | null
  detail?: string | null
}

export interface RetakeAnalysisDiagnostic {
  correlationId: string
  projectId: string
  /** The project-local immutable original-media asset; intentionally no path/name. */
  mediaAssetId: string
  /** One preview run, equal to correlationId so support can correlate safely. */
  jobId: string
  jobStatus: 'completed' | 'failed'
  stage: 'retake-preview'
  transcriptRevision: number
  wordCount: number
  sourceStart: number
  sourceEnd: number
  sourceDuration: number
  processedDuration: number
  sourceSampleRate: number | null
  sourceChannels: number | null
  /** Null while preview has no produced audio artifact to inspect. */
  processedSampleRate: number | null
  processedChannels: number | null
  candidateWindows: number
  rejected: Record<string, number>
  groups: number
  suggestions: number
  noiseReduction: 'off' | 'light' | 'medium' | 'strong'
  /** Bounded names only, never a failure message, stack, path, or transcript. */
  exceptionType: 'Error' | 'TypeError' | 'RangeError' | 'SyntaxError' | 'UnknownError' | null
  exceptionLocation: 'retake-preview' | null
}

const MAX_MESSAGE_LENGTH = 2_000
const MAX_STACK_LENGTH = 8_000
const MAX_CONTEXT_LENGTH = 4_000
const MAX_PAGE_LENGTH = 1_000
const MAX_USER_AGENT_LENGTH = 1_000

function capped(value: unknown, maxLength: number, fallback = ''): string {
  try {
    const raw = typeof value === 'string' ? value : String(value ?? fallback)
    const text = raw.replace(/([?&]token=)[^&#\s]+/gi, '$1[redacted]')
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
  } catch {
    return fallback
  }
}

function errorFields(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return {
      name: capped(error.name, 120, 'Error'),
      message: capped(error.message, MAX_MESSAGE_LENGTH, 'Unknown client error'),
      stack: capped(error.stack, MAX_STACK_LENGTH),
    }
  }
  return {
    name: 'NonErrorException',
    message: capped(error, MAX_MESSAGE_LENGTH, 'Unknown client error'),
    stack: '',
  }
}

/**
 * Best-effort diagnostics for the local desktop server. Reporting must never
 * become a second application failure, so every synchronous and asynchronous
 * failure is intentionally swallowed. The query string is excluded because it
 * contains the desktop session token.
 */
export function reportClientError(error: unknown, context: ClientErrorContext): void {
  try {
    const fields = errorFields(error)
    const payload = {
      source: context.source,
      name: fields.name,
      message: fields.message,
      stack: fields.stack,
      componentStack: capped(context.componentStack, MAX_CONTEXT_LENGTH),
      detail: capped(context.detail, MAX_CONTEXT_LENGTH),
      page: capped(`${window.location.origin}${window.location.pathname}`, MAX_PAGE_LENGTH),
      userAgent: capped(window.navigator.userAgent, MAX_USER_AGENT_LENGTH),
      occurredAt: new Date().toISOString(),
    }
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // Diagnostics are deliberately non-blocking and non-fatal.
  }
}

/**
 * Log count-only retake analysis evidence through the local server. No words,
 * transcript strings, filenames, or media paths are included in this payload.
 */
export function reportRetakeAnalysis(payload: RetakeAnalysisDiagnostic): void {
  try {
    void fetch('/api/diagnostics/retake-analysis', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // Diagnostics remain non-blocking and never alter editing behavior.
  }
}

/** Return only an allow-listed exception category for count-only diagnostics. */
export function retakeDiagnosticExceptionType(error: unknown): RetakeAnalysisDiagnostic['exceptionType'] {
  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'Error':
    case 'TypeError':
    case 'RangeError':
    case 'SyntaxError':
      return name
    default:
      return 'UnknownError'
  }
}

export function installGlobalErrorReporting(): () => void {
  const handleError = (event: ErrorEvent) => {
    reportClientError(event.error ?? event.message, {
      source: 'window',
      detail: `${event.filename || 'unknown source'}:${event.lineno || 0}:${event.colno || 0}`,
    })
  }
  const handleRejection = (event: PromiseRejectionEvent) => {
    reportClientError(event.reason, { source: 'unhandled-rejection' })
  }

  window.addEventListener('error', handleError)
  window.addEventListener('unhandledrejection', handleRejection)
  return () => {
    window.removeEventListener('error', handleError)
    window.removeEventListener('unhandledrejection', handleRejection)
  }
}
