import { useState } from 'react'
import { useStore } from '../store'
import { primaryModifier } from '../lib/platform'
import { BrandMark, CheckIcon, EditIcon, ForwardIcon, UndoIcon } from './Icons'

export default function WorkspaceHeader({ onHome, onExport, onShortcuts, theme, onToggleTheme, headingRef }: {
  onHome: () => void; onExport: () => void; onShortcuts: (trigger?: HTMLElement) => void; theme: string; onToggleTheme: () => void
  headingRef: React.RefObject<HTMLHeadingElement>
}) {
  const state = useStore()
  const renameProject = useStore((store) => store.renameProject)
  const [view, setView] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const commitRename = async () => {
    const draft = renaming
    setRenaming(null)
    if (draft === null || !state.projectId) return
    await renameProject(state.projectId, draft)
  }
  const label = state.saving ? 'Saving…' : state.rendering ? 'Updating preview…' : state.dirty ? 'Unsaved changes' : 'Saved locally'
  return <header className="workspace-header">
    <button className="home-button" onClick={onHome} title="Back to projects"><BrandMark size={32} title="ScriptSurgeon" /><span>Home</span></button>
    <div className="view-menu"><button aria-expanded={view} onClick={() => setView(!view)}>View</button>{view && <div onKeyDown={e => { if (e.key === 'Escape') setView(false) }}><button onClick={() => { onToggleTheme(); setView(false) }}>Switch to {theme === 'dark' ? 'light' : 'dark'} appearance</button><button onClick={e => { onShortcuts(e.currentTarget); setView(false) }}>Keyboard shortcuts</button></div>}</div>
    <button aria-label="Undo" title={`Undo (${primaryModifier}+Z)`} onClick={state.undo} disabled={!state.undoStack.length || state.status !== 'ready'}><UndoIcon /></button>
    <button aria-label="Redo" title={`Redo (${primaryModifier}+Shift+Z)`} onClick={state.redo} disabled={!state.redoStack.length || state.status !== 'ready'}><ForwardIcon /></button>
    <div className="project-breadcrumb"><span>Local projects</span><span>/</span>
      {renaming !== null ? (
        <input
          className="project-rename"
          autoFocus
          value={renaming}
          maxLength={160}
          aria-label="Project name"
          onChange={(e) => setRenaming(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
            else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
          }}
          onBlur={() => void commitRename()}
        />
      ) : (
        <>
          <h1 ref={headingRef} tabIndex={-1} onDoubleClick={() => state.projectId && setRenaming(state.projectName)} title="Double-click to rename">{state.projectName || 'New project'}</h1>
          <button type="button" className="project-rename-btn" aria-label="Rename project" title="Rename project" disabled={!state.projectId} onClick={() => setRenaming(state.projectName)}><EditIcon className="h-3.5 w-3.5" /></button>
        </>
      )}
    </div>
    <span className="workspace-save" role="status"><CheckIcon /><span>{label}</span></span>
    <button className="header-export" onClick={onExport} disabled={state.status !== 'ready'}>Export</button>
  </header>
}
