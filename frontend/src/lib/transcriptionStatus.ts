import type { ProjectMeta, ProjectStatus, StatusPayload } from '../types'

export type TerminalTranscriptionStatus = 'error' | 'cancelled'

export function isTerminalTranscriptionStatus(
  status: string | undefined,
): status is TerminalTranscriptionStatus {
  return status === 'error' || status === 'cancelled'
}

export function transcriptionErrorCopy(payload: StatusPayload): string {
  if (payload.status === 'cancelled') {
    return payload.message || 'Transcription was cancelled. You can retry it using the original local media.'
  }
  return payload.error || payload.message || 'Transcription failed. You can retry it using the original local media.'
}

export function sidebarProjectStatus(
  project: Pick<ProjectMeta, 'status' | 'duration'>,
  formattedDuration: string,
): { label: string; tone: 'normal' | 'working' | 'attention' } {
  const status: ProjectStatus = project.status ?? 'ready'
  switch (status) {
    case 'queued':
      return { label: 'Queued for transcription', tone: 'working' }
    case 'transcribing':
      return { label: 'Transcribing...', tone: 'working' }
    case 'error':
      return { label: 'Transcription failed', tone: 'attention' }
    case 'cancelled':
      return { label: 'Transcription cancelled', tone: 'attention' }
    case 'ready':
      return { label: project.duration === null ? 'Ready' : formattedDuration, tone: 'normal' }
  }
}
