import { useState } from 'react'
import { useStore } from '../store'
import { CheckIcon, UndoIcon, ForwardIcon } from './Icons'
import icon from '../assets/scriptcut-icon.png'

export default function WorkspaceHeader({ onHome, onExport, onShortcuts, theme, onToggleTheme, headingRef }: {
  onHome: () => void; onExport: () => void; onShortcuts: (trigger?: HTMLElement) => void; theme: string; onToggleTheme: () => void
  headingRef: React.RefObject<HTMLHeadingElement>
}) {
  const state = useStore()
  const [view, setView] = useState(false)
  const label = state.saving ? 'Saving…' : state.rendering ? 'Updating preview…' : state.dirty ? 'Unsaved changes' : 'Saved locally'
  return <header className="workspace-header">
    <button className="home-button" onClick={onHome} title="Back to projects"><img src={icon} alt="ScriptSurgeon" /><span>Home</span></button>
    <div className="view-menu"><button aria-expanded={view} onClick={() => setView(!view)}>View</button>{view && <div onKeyDown={e => { if (e.key === 'Escape') setView(false) }}><button onClick={() => { onToggleTheme(); setView(false) }}>Switch to {theme === 'dark' ? 'light' : 'dark'} appearance</button><button onClick={e => { onShortcuts(e.currentTarget); setView(false) }}>Keyboard shortcuts</button></div>}</div>
    <button aria-label="Undo" title="Undo (Ctrl+Z)" onClick={state.undo} disabled={!state.undoStack.length || state.status !== 'ready'}><UndoIcon /></button>
    <button aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={state.redo} disabled={!state.redoStack.length || state.status !== 'ready'}><ForwardIcon /></button>
    <div className="project-breadcrumb"><span>Local projects</span><span>/</span><h1 ref={headingRef} tabIndex={-1}>{state.projectName || 'New project'}</h1></div>
    <span className="workspace-save" role="status"><CheckIcon /><span>{label}</span></span>
    <button className="header-export" onClick={onExport} disabled={state.status !== 'ready'}>Export</button>
  </header>
}
