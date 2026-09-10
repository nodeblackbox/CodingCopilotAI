import { useEffect, useRef, useState } from 'react'
import { Sparkles, User } from 'lucide-react'
import { Rail } from '@renderer/components/rail/Rail'
import { QuestionPanel } from '@renderer/components/workspace/QuestionPanel'
import { EditorColumn } from '@renderer/components/workspace/EditorColumn'
import { CopilotPanel } from '@renderer/components/workspace/CopilotPanel'
import { PlaygroundsView } from '@renderer/components/views/PlaygroundsView'
import { LibraryView } from '@renderer/components/views/LibraryView'
import { SettingsView } from '@renderer/components/views/SettingsView'
import { useAppStore } from '@renderer/state/store'

const PAGE_TITLE: Record<string, string> = {
  library: 'Question library',
  playgrounds: 'Playgrounds',
  settings: 'Settings'
}

export default function App() {
  const view = useAppStore((s) => s.view)
  const question = useAppStore((s) => s.question)
  const autosave = useAppStore((s) => s.autosave)
  const init = useAppStore((s) => s.init)

  const [leftWidth, setLeftWidth] = useState(360)
  const [rightWidth, setRightWidth] = useState(360)
  const dragging = useRef<'left' | 'right' | null>(null)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (dragging.current === 'left') {
        setLeftWidth(Math.min(560, Math.max(280, e.clientX - 56)))
      } else if (dragging.current === 'right') {
        setRightWidth(Math.min(480, Math.max(280, window.innerWidth - e.clientX)))
      }
    }
    function onUp() {
      dragging.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const startDrag = (side: 'left' | 'right') => () => {
    dragging.current = side
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const pageTitle = PAGE_TITLE[view]

  return (
    <div className="h-screen w-full overflow-x-auto bg-[#0a0c11]">
      <div style={{ minWidth: 1180 }} className="relative flex h-screen flex-col text-zinc-100">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-teal-500/[0.07] to-transparent" />

        <div className="relative z-10 flex h-14 flex-none items-center gap-3 border-b border-white/[0.06] bg-[#0d0f15]/90 px-4 backdrop-blur">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-teal-400 to-cyan-500 text-[#0a0c11]">
              <Sparkles size={14} strokeWidth={2.25} />
            </div>
            <span className="text-[15px] font-semibold tracking-tight">Prep</span>
          </div>
          <div className="h-5 w-px bg-white/[0.08]" />
          {view === 'workspace' ? (
            <div className="flex items-center gap-1.5 text-[13px]">
              <span className="text-zinc-500">{question.category}</span>
              <span className="text-zinc-700">/</span>
              <span className="font-medium text-zinc-200">{question.title}</span>
            </div>
          ) : (
            <span className="text-[13px] font-medium text-zinc-300">{pageTitle}</span>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-2 text-[12px] text-zinc-500">
            <span className={`h-1.5 w-1.5 rounded-full bg-teal-400 ${autosave === 'saving' ? 'animate-pulse' : ''}`} />
            {autosave === 'saving' ? 'Saving…' : 'Saved'}
          </div>
          <button className="ml-1 flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] text-zinc-400 hover:bg-white/5 hover:text-zinc-200">
            <User size={15} strokeWidth={1.75} />
          </button>
        </div>

        <div className="relative z-10 flex flex-1 overflow-hidden">
          <Rail />

          {view === 'settings' && <SettingsView />}
          {view === 'library' && <LibraryView />}
          {view === 'playgrounds' && <PlaygroundsView />}

          {view === 'workspace' && (
            <>
              <QuestionPanel width={leftWidth} />
              <div onMouseDown={startDrag('left')} className="w-1 flex-none cursor-col-resize hover:bg-teal-400/20" />
              <EditorColumn />
              <div onMouseDown={startDrag('right')} className="w-1 flex-none cursor-col-resize hover:bg-teal-400/20" />
              <CopilotPanel width={rightWidth} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
