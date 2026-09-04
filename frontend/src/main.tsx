import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AppErrorBoundary from './components/AppErrorBoundary'
import { frontendBuildIdentity } from './lib/buildIdentity'
import { installGlobalErrorReporting } from './lib/clientErrors'
import { requestRecordingCloseConfirmation } from './lib/nativeRecordingClose'
import { resolveWorkspaceTheme, WORKSPACE_THEME_KEY } from './lib/workspacePreferences'
import { useStore } from './store'
import './index.css'

document.documentElement.dataset.buildCommit = frontendBuildIdentity.commit
// Kept out of the editor UI; useful when diagnosing an installed package.
console.info('[ScriptSurgeon build]', frontendBuildIdentity)

// Apply the display preference before React paints so reopening the desktop app
// never flashes the opposite theme.
try {
  const theme = resolveWorkspaceTheme(window.localStorage.getItem(WORKSPACE_THEME_KEY))
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
} catch {
  document.documentElement.dataset.theme = 'dark'
}

installGlobalErrorReporting()

declare global {
  interface Window {
    __scriptcutFlushForClose?: () => Promise<NativeCloseDisposition>
    __scriptcutUnsavedRecording?: boolean
  }
}

/**
 * The native launcher treats only `saved` as an automatic close. Every other
 * result either keeps the app open or requires an explicit native warning
 * before it can discard edits. Keep this a small string protocol so the
 * Python host never has to infer intent from JavaScript truthiness.
 */
type NativeCloseDisposition = 'saved' | 'save-failed' | 'cancelled'

let recordingCloseRequest: Promise<boolean> | null = null

async function confirmRecordingClose(): Promise<boolean> {
  if (recordingCloseRequest) return recordingCloseRequest
  const request = requestRecordingCloseConfirmation(window)
  recordingCloseRequest = request
  try {
    return await request
  } finally {
    if (recordingCloseRequest === request) recordingCloseRequest = null
  }
}

// The native desktop shell calls this before it allows the window to close.
// Returning a promise lets the shell wait for the complete project state to
// reach disk instead of racing the normal save debounce.
window.__scriptcutFlushForClose = async (): Promise<NativeCloseDisposition> => {
  if (window.__scriptcutUnsavedRecording) {
    let discardAndClose = false
    try {
      discardAndClose = await confirmRecordingClose()
    } catch {
      // A recording take is never safe to discard merely because its dialog
      // could not answer the native close request.
      return 'cancelled'
    }
    if (!discardAndClose) return 'cancelled'
  }

  const state = useStore.getState()
  if (!state.dirty && !state.saving) return 'saved'
  try {
    await state.flushSave()
    return !useStore.getState().dirty ? 'saved' : 'save-failed'
  } catch {
    return 'save-failed'
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
)

import './workspace.css'
