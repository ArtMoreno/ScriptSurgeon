import type {
  ExportFormat,
  IntegrationTarget,
  NoiseLevel,
  ProjectMeta,
  ProjectState,
  StatusPayload,
} from '../types'

const TOKEN_HEADER = 'X-ScriptCut-Token'
// Launcher/backend contract: the desktop launcher opens `/?token=<random>`;
// every API and WaveSurfer request echoes it in this header. The backend should
// validate the header for all /api routes and avoid persisting the query token.
const scriptSurgeonToken = typeof window === 'undefined'
  ? ''
  : new URLSearchParams(window.location.search).get('token')?.trim() || ''

export function authHeaders(): Record<string, string> {
  return scriptSurgeonToken ? { [TOKEN_HEADER]: scriptSurgeonToken } : {}
}

function authenticated(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers)
  if (scriptSurgeonToken) headers.set(TOKEN_HEADER, scriptSurgeonToken)
  return { ...init, headers }
}

async function responseError(response: Response): Promise<Error> {
  const detail = (await response.text()).trim()
  if (detail) {
    try {
      const payload = JSON.parse(detail) as unknown
      return new Error(apiErrorMessage(payload) || detail)
    } catch {
      return new Error(detail)
    }
  }
  return new Error(`Request failed (${response.status})`)
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  // Never turn a structured backend response into the browser's default object
  // coercion. It is not actionable to the person editing the project.
  return trimmed && trimmed !== '[object Object]' ? trimmed : null
}

function locationValue(value: unknown): string | null {
  if (typeof value === 'string') return stringValue(value)
  if (!Array.isArray(value)) return null
  const parts = value
    .filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
    .map((part) => String(part).trim())
    .filter(Boolean)
  return parts.length ? parts.join('.') : null
}

/**
 * Converts FastAPI/Pydantic's usual `{ detail: [{ loc, msg }] }` failure
 * shape into short, human-readable copy. Other APIs may still return a simple
 * `detail`, `error`, or `message` string, all of which remain supported.
 */
export function apiErrorMessage(payload: unknown): string | null {
  const messages = structuredErrorMessages(payload)
  const uniqueMessages = [...new Set(messages)]
  return uniqueMessages.length ? uniqueMessages.join('; ') : null
}

function structuredErrorMessages(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return []
  const direct = stringValue(value)
  if (direct) return [direct]

  if (Array.isArray(value)) {
    return value.flatMap((entry) => structuredErrorMessages(entry, depth + 1))
  }
  if (typeof value !== 'object') return []

  const record = value as Record<string, unknown>
  // Prefer backend details over a generic top-level message. This is what
  // allows a state-save failure to name the invalid field rather than merely
  // saying that validation failed.
  const detailMessages = structuredErrorMessages(record.detail, depth + 1)
  if (detailMessages.length) return detailMessages
  const errorMessages = structuredErrorMessages(record.error, depth + 1)
  if (errorMessages.length) return errorMessages

  const message = stringValue(record.msg) || stringValue(record.message)
  if (!message) return []
  const location = locationValue(record.loc)
  return [location ? `${location}: ${message}` : message]
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, authenticated(init))
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<T>
}

async function reqBlob(url: string, init?: RequestInit): Promise<Blob> {
  const response = await fetch(url, authenticated(init))
  if (!response.ok) throw await responseError(response)
  return response.blob()
}

export const api = {
  listProjects: (signal?: AbortSignal) => req<ProjectMeta[]>('/api/projects', { signal }),
  getProject: (id: string, signal?: AbortSignal) =>
    req<{ meta: ProjectMeta; state: ProjectState | null; status: StatusPayload }>(`/api/projects/${id}`, { signal }),
  status: (id: string, signal?: AbortSignal) => req<StatusPayload>(`/api/projects/${id}/status`, { signal }),
  retryTranscription: (id: string, signal?: AbortSignal) =>
    req<{ ok: boolean; status: 'queued' }>(`/api/projects/${id}/transcription/retry`, {
      method: 'POST',
      signal,
    }),
  upload: async (file: File, signal?: AbortSignal, projectName?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (projectName) form.append('name', projectName)
    return req<{ id: string; name: string }>('/api/projects', { method: 'POST', body: form, signal })
  },
  uploadRecording: async (id: string, file: File, signal?: AbortSignal) => {
    const form = new FormData()
    form.append('file', file)
    return req<{ clipId: string; duration: number; sampleRate: number; channels: number }>(
      `/api/projects/${id}/recordings`,
      { method: 'POST', body: form, signal },
    )
  },
  saveState: (id: string, state: ProjectState, signal?: AbortSignal) =>
    req<{ ok: boolean; revision: number }>(`/api/projects/${id}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
      signal,
    }),
  render: (
    id: string,
    studio: boolean,
    noise: NoiseLevel,
    normalize: boolean,
    revision: number | null,
    signal?: AbortSignal,
  ) =>
    req<{ ok: boolean; duration: number; url: string }>(
      `/api/projects/${id}/render?studio=${studio}&noise=${noise}&normalize=${normalize}${revision === null ? '' : `&revision=${revision}`}`,
      { method: 'POST', signal },
    ),
  originalAudioUrl: (id: string) => `/api/projects/${encodeURIComponent(id)}/audio?edited=false`,
  // Export stays POST so it cannot be triggered by a passive link/prefetch. The
  // caller flushes state first and converts the returned audio blob to a download.
  exportAudio: (
    id: string,
    studio: boolean,
    noise: NoiseLevel,
    normalize: boolean,
    format: ExportFormat,
    revision: number | null,
    signal?: AbortSignal,
    range?: { start: number; end: number } | null,
  ) =>
    reqBlob(
      `/api/projects/${id}/export?studio=${studio}&noise=${noise}&normalize=${normalize}&format=${format}`
      + (range ? `&start=${range.start.toFixed(3)}&end=${range.end.toFixed(3)}` : '')
      + (revision === null ? '' : `&revision=${revision}`),
      { method: 'POST', signal },
    ),
  deleteProject: (id: string, signal?: AbortSignal) =>
    req<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE', signal }),
  // Delivery integrations. The target list is served rather than compiled in,
  // so the picker only ever offers what this build can actually produce.
  getIntegrations: (signal?: AbortSignal) =>
    req<{ targets: IntegrationTarget[] }>('/api/integrations', { signal }),
  exportIntegration: (id: string, targetId: string, signal?: AbortSignal) =>
    reqBlob(`/api/projects/${id}/integrations/${targetId}`, { method: 'POST', signal }),
}
