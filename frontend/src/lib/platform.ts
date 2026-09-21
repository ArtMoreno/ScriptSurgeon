// Match the Command/Control handlers with labels familiar to the current OS.
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

export const primaryModifier = isMac ? '⌘' : 'Ctrl'
export const alternateModifier = isMac ? 'Option' : 'Alt'
