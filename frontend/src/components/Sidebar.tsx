import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../store'
import { fmtTime } from '../lib/timeline'
import { sidebarProjectStatus } from '../lib/transcriptionStatus'
import type { WorkspaceTheme } from '../lib/workspacePreferences'
import productIcon from '../assets/scriptcut-icon.png'
import { AudioIcon, CloseIcon, MoonIcon, SunIcon, UploadIcon } from './Icons'
import { PRODUCT_NAME } from '../lib/branding'

interface SidebarProps {
  onRecordNewProject: (trigger: HTMLElement) => void
  theme: WorkspaceTheme
  onToggleTheme: () => void
}

export default function Sidebar({ onRecordNewProject, theme, onToggleTheme }: SidebarProps) {
  const projects = useStore((state) => state.projects)
  const projectId = useStore((state) => state.projectId)
  const status = useStore((state) => state.status)
  const progress = useStore((state) => state.progress)
  const loadProjects = useStore((state) => state.loadProjects)
  const uploadFile = useStore((state) => state.uploadFile)
  const openProject = useStore((state) => state.openProject)
  const deleteProject = useStore((state) => state.deleteProject)
  const closeProject = useStore((state) => state.closeProject)
  const [dragOver, setDragOver] = useState(false)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()

  const needle = filter.trim().toLowerCase()
  const visibleProjects = needle
    ? projects.filter((project) => project.name.toLowerCase().includes(needle))
    : projects

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const importFile = useCallback((file?: File) => {
    if (file) void uploadFile(file).catch(() => undefined)
  }, [uploadFile])

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    setDragOver(false)
    importFile(event.dataTransfer.files?.[0])
  }, [importFile])

  return (
    <aside className="app-sidebar w-[280px] max-xl:w-60 max-md:w-[76px] shrink-0 border-r border-charcoal-line bg-charcoal flex flex-col relative z-20 text-charcoal-ink">
      <div className="h-[68px] px-4 max-md:px-3 border-b border-charcoal-line flex items-center">
        <button
          type="button"
          onClick={() => void closeProject().catch(() => undefined)}
          className="flex items-center gap-3 min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
          aria-label={`Go to ${PRODUCT_NAME} home`}
        >
          <span className="h-9 w-9 shrink-0 overflow-hidden rounded-xl bg-ember shadow-lg shadow-black/25">
            <img src={productIcon} alt="" className="h-full w-full object-cover" />
          </span>
          <span className="sidebar-copy min-w-0 text-left max-md:hidden">
            <span className="block text-[15px] font-semibold tracking-tight text-charcoal-ink">{PRODUCT_NAME}</span>
            <span className="block text-[11px] text-charcoal-muted">Local audio workspace</span>
          </span>
        </button>
      </div>

      <div
        onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className="px-3 pt-3"
        role="group"
        aria-label="New project"
      >
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept=".mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.webm"
          className="sr-only"
          aria-label="Choose media to import"
          onChange={(event) => {
            importFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={`w-full rounded-xl border px-3 py-3.5 max-md:px-2 flex items-center gap-3 max-md:justify-center text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember ${
            dragOver
              ? 'border-ember bg-ember/15 text-charcoal-ink'
              : 'border-charcoal-line bg-charcoal-raised hover:border-charcoal-muted/60 hover:bg-charcoal-hover text-charcoal-ink'
          }`}
          aria-label="Import media"
          aria-describedby={`${inputId}-hint`}
        >
          <span className="h-9 w-9 shrink-0 rounded-lg bg-charcoal-hover text-charcoal-ink grid place-items-center">
            <UploadIcon className="h-5 w-5" />
          </span>
          <span className="sidebar-copy min-w-0 max-md:hidden">
            <span className="block text-sm font-semibold">Import media</span>
            <span id={`${inputId}-hint`} className="block text-[11px] text-charcoal-muted mt-0.5">Audio or MP4 - processed locally</span>
          </span>
        </button>
        <button
          type="button"
          data-record-new-project
          onClick={(event) => onRecordNewProject(event.currentTarget)}
          disabled={status === 'uploading' || status === 'loading' || status === 'transcribing'}
          className="mt-2 w-full rounded-xl border border-ember/45 bg-ember/10 px-3 py-3 max-md:px-2 flex items-center gap-3 max-md:justify-center text-left text-charcoal-ink transition-colors hover:border-ember hover:bg-ember/20 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
          aria-label="Record new project"
          title="Record new project"
        >
          <span className="h-9 w-9 shrink-0 rounded-lg bg-ember text-on-accent grid place-items-center">
            <AudioIcon className="h-5 w-5" />
          </span>
          <span className="sidebar-copy min-w-0 max-md:hidden">
            <span className="block text-sm font-semibold">Record new project</span>
            <span className="block text-[11px] text-charcoal-muted mt-0.5">Microphone - transcribed locally</span>
          </span>
        </button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto px-2.5 py-4" aria-label="Local projects">
        <div className="sidebar-copy px-2 mb-2 flex items-center justify-between max-md:hidden">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-charcoal-muted">Recent projects</span>
          <span className="text-[10px] tabular-nums text-charcoal-muted">
            {needle ? `${visibleProjects.length}/${projects.length}` : projects.length}
          </span>
        </div>
        {/* Only worth the space once the list is long enough to scan poorly. */}
        {projects.length > 7 && (
          <div className="sidebar-copy px-1 mb-2 max-md:hidden">
            <label htmlFor="project-filter" className="sr-only">Filter projects by name</label>
            <input
              id="project-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setFilter('') }}
              placeholder="Filter projects"
              autoComplete="off"
              spellCheck={false}
              className="h-7 w-full rounded-lg border border-charcoal-line bg-charcoal-raised px-2 text-[11px] text-charcoal-ink placeholder:text-charcoal-faint outline-none focus-visible:ring-2 focus-visible:ring-ember"
            />
          </div>
        )}
        {projects.length === 0 && (
          <div className="sidebar-copy mx-1 rounded-xl border border-dashed border-charcoal-line px-3 py-5 text-center max-md:hidden">
            <AudioIcon className="h-5 w-5 text-charcoal-faint mx-auto mb-2" />
            <p className="text-xs text-charcoal-muted">Your local projects will appear here.</p>
          </div>
        )}
        {projects.length > 0 && visibleProjects.length === 0 && (
          <p className="sidebar-copy mx-1 px-3 py-4 text-center text-[11px] text-charcoal-muted max-md:hidden">
            No project matches “{filter.trim()}”.
          </p>
        )}
        <div className="space-y-1">
          {visibleProjects.map((project) => {
            const projectStatus = sidebarProjectStatus(project, fmtTime(project.duration ?? 0))
            return (
            <div
              key={project.id}
              className={`group flex items-center rounded-xl transition-colors ${
                project.id === projectId ? 'bg-ember/15' : 'hover:bg-charcoal-raised'
              }`}
            >
              <button
                type="button"
                onClick={() => void openProject(project.id).catch(() => undefined)}
                className="min-w-0 flex-1 flex items-center gap-2.5 px-2.5 py-2.5 max-md:justify-center rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ember"
                aria-current={project.id === projectId ? 'page' : undefined}
                title={project.name}
              >
                <span className={`h-8 w-8 shrink-0 rounded-lg grid place-items-center ${
                  project.id === projectId ? 'bg-ember/25 text-ember-soft' : 'bg-charcoal-raised text-charcoal-muted'
                }`}>
                  <AudioIcon className="h-4 w-4" />
                </span>
                <span className="sidebar-copy min-w-0 max-md:hidden">
                  <span className={`block truncate text-[13px] font-medium ${project.id === projectId ? 'text-charcoal-ink' : 'text-charcoal-muted'}`}>
                    {project.name}
                  </span>
                  <span className={`block text-[11px] mt-0.5 ${
                    projectStatus.tone === 'attention'
                      ? 'text-ember-soft'
                      : projectStatus.tone === 'working'
                        ? 'text-charcoal-ink'
                        : 'text-charcoal-muted'
                  }`}>
                    {projectStatus.label}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  if (confirm(`Delete "${project.name}"? This removes its local files.`)) {
                    void deleteProject(project.id).catch(() => undefined)
                  }
                }}
                className="sidebar-copy mr-2 h-7 w-7 grid place-items-center rounded-md text-charcoal-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-danger/20 hover:text-ember-soft focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember max-md:hidden"
                aria-label={`Delete ${project.name}`}
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            )
          })}
        </div>
      </nav>

      <div className="border-t border-charcoal-line p-3 max-md:px-2">
        <div aria-live="polite">
          {(status === 'transcribing' || status === 'uploading' || status === 'loading') ? (
            <div className="rounded-xl bg-charcoal-raised px-3 py-2.5 max-md:px-2">
              <div className="flex items-center gap-2 max-md:justify-center">
                <span className="h-2 w-2 rounded-full bg-ember animate-pulse" />
                <span className="sidebar-copy text-[11px] font-medium text-charcoal-ink max-md:hidden">
                  {status === 'uploading'
                    ? 'Importing media'
                    : status === 'loading'
                      ? 'Opening project'
                      : projects.find((project) => project.id === projectId)?.status === 'queued'
                        ? 'Queued locally'
                        : 'Transcribing locally'}
                </span>
              </div>
              <div className="sidebar-copy h-1 rounded-full bg-charcoal-hover mt-2 overflow-hidden max-md:hidden">
                <div className="h-full rounded-full bg-ember transition-[width]" style={{ width: `${Math.max(4, progress * 100)}%` }} />
              </div>
            </div>
          ) : status === 'error' || status === 'cancelled' ? (
            <div className="flex items-center gap-2 max-md:justify-center rounded-xl bg-charcoal-raised px-3 py-2.5 text-[11px] text-charcoal-ink">
              <span className={`h-2 w-2 rounded-full ${status === 'cancelled' ? 'bg-ochre' : 'bg-danger'}`} />
              <span className="sidebar-copy max-md:hidden">
                {status === 'cancelled' ? 'Transcription cancelled' : 'Project needs attention'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 max-md:justify-center px-1 text-[11px] text-charcoal-muted">
              <span className="h-2 w-2 rounded-full bg-forest" />
              <span className="sidebar-copy max-md:hidden">Private - saved on this device</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleTheme}
          aria-pressed={theme === 'dark'}
          className="mt-2 flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[11px] font-medium text-charcoal-muted transition-colors hover:bg-charcoal-raised hover:text-charcoal-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember max-md:justify-center"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
          <span className="sidebar-copy max-md:hidden">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
      </div>
    </aside>
  )
}
