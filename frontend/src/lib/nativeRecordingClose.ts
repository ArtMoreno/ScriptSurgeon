export const RECORDING_CLOSE_REQUEST_EVENT = 'scriptcut:recording-close-request'

export interface RecordingCloseRequestDetail {
  /** Set synchronously by the mounted recording dialog. */
  handled: boolean
  /** Resolve the native close attempt. Calls after the first are ignored. */
  respond: (discardAndClose: boolean) => void
}

/**
 * Ask the mounted recording dialog to own the native-window close decision.
 * Missing listeners fail closed so the desktop shell never discards a take
 * merely because React is mounting, unmounting, or recovering from an error.
 */
export function requestRecordingCloseConfirmation(target: EventTarget = window): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const respond = (discardAndClose: boolean) => {
      if (settled) return
      settled = true
      resolve(discardAndClose)
    }
    const detail: RecordingCloseRequestDetail = { handled: false, respond }
    target.dispatchEvent(new CustomEvent<RecordingCloseRequestDetail>(RECORDING_CLOSE_REQUEST_EVENT, { detail }))
    if (!detail.handled) respond(false)
  })
}
