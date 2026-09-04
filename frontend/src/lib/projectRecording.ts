export const PROJECT_NAME_MAX_LENGTH = 160

export function normalizeProjectName(value: string): string {
  return value.trim().slice(0, PROJECT_NAME_MAX_LENGTH)
}

export function projectNameFromFilename(filename: string): string {
  const basename = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  return normalizeProjectName(basename)
}

export function defaultRecordingProjectName(
  now = new Date(),
  locale?: string,
  timeZone?: string,
): string {
  const formatted = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(now)
  return `New recording - ${formatted}`
}
