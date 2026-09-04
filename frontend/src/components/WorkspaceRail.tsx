import { AudioIcon, SparklesIcon, LevelsIcon, GapIcon, MoonIcon } from './Icons'
const tools = [{ name: 'Project', Icon: AudioIcon }, { name: 'Cleanup', Icon: SparklesIcon }, { name: 'Properties', Icon: LevelsIcon }, { name: 'Chapters', Icon: GapIcon }, { name: 'Settings', Icon: MoonIcon }]
export default function WorkspaceRail({ selected, onSelect }: { selected: string | null; onSelect: (name: string) => void }) {
  return <nav className="workspace-rail" aria-label="Workspace tools">{tools.map(({ name, Icon }) => <button key={name} aria-pressed={selected === name} onClick={() => onSelect(name)}><Icon className="h-5 w-5" /><span>{name}</span></button>)}</nav>
}
