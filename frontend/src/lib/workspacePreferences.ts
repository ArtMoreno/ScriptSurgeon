export type WorkspaceTheme = 'dark' | 'light'
export type TimelineSize = 'normal' | 'compact' | 'minimized'

export const WORKSPACE_THEME_KEY = 'scriptsurgeon.workspaceTheme'
export const TIMELINE_SIZE_KEY = 'scriptsurgeon.timelineSize'
export const LAST_OPEN_TIMELINE_SIZE_KEY = 'scriptsurgeon.lastOpenTimelineSize'
export const LEGACY_TIMELINE_COLLAPSED_KEY = 'scriptcut.timelineCollapsed'
/** The input the recorder should reselect next time this machine records. */
export const RECORDER_DEVICE_KEY = 'scriptsurgeon.recorderDevice'
/** Whether the browser's AGC/noise-suppression chain is applied while capturing. */
export const RECORDER_PROCESSING_KEY = 'scriptsurgeon.recorderProcessing'

/** The default deliberately matches the focused desktop editing surface. */
export function resolveWorkspaceTheme(value: string | null | undefined): WorkspaceTheme {
  return value === 'light' || value === 'dark' ? value : 'dark'
}

/**
 * Migrate the old binary timeline preference without treating it as project
 * data. Existing expanded timelines intentionally reopen compact, because the
 * old expanded size consumed a disproportionate amount of the editor.
 */
export function resolveTimelineSize(
  value: string | null | undefined,
  legacyCollapsed: string | null | undefined,
): TimelineSize {
  if (value === 'normal' || value === 'compact' || value === 'minimized') return value
  return legacyCollapsed === 'true' ? 'minimized' : 'compact'
}

export function restoredTimelineSize(size: TimelineSize): Exclude<TimelineSize, 'minimized'> {
  return size === 'minimized' ? 'compact' : size
}

export function resolveOpenTimelineSize(
  value: string | null | undefined,
  currentSize: TimelineSize,
): Exclude<TimelineSize, 'minimized'> {
  if (value === 'normal' || value === 'compact') return value
  return restoredTimelineSize(currentSize)
}
