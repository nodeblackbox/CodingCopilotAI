import { LayoutGrid, Library as LibraryIcon, Settings as SettingsIcon, PanelLeft, type LucideIcon } from 'lucide-react'
import { useAppStore, type View } from '@renderer/state/store'

function RailButton({
  active,
  onClick,
  title,
  Icon
}: {
  active: boolean
  onClick: () => void
  title: string
  Icon: LucideIcon
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
        active ? 'bg-teal-400/10 text-teal-300' : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
      }`}
    >
      {active && <span className="absolute left-[-9px] h-4 w-[2px] rounded-full bg-teal-300" />}
      <Icon size={17} strokeWidth={1.75} />
    </button>
  )
}

export function Rail() {
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)

  const go = (v: View) => () => setView(v)

  return (
    <div className="flex w-14 flex-none flex-col items-center gap-1 border-r border-white/[0.06] bg-[#0d0f15]/60 py-4">
      <RailButton active={view === 'workspace'} onClick={go('workspace')} title="Workspace" Icon={PanelLeft} />
      <div className="my-2 h-px w-6 bg-white/[0.08]" />
      <RailButton active={view === 'playgrounds'} onClick={go('playgrounds')} title="Playgrounds" Icon={LayoutGrid} />
      <RailButton active={view === 'library'} onClick={go('library')} title="Question library" Icon={LibraryIcon} />
      <div className="flex-1" />
      <RailButton active={view === 'settings'} onClick={go('settings')} title="Settings" Icon={SettingsIcon} />
    </div>
  )
}
