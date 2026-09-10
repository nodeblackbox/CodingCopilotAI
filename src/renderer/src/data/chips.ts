import {
  Lightbulb,
  Sparkles,
  Map as MapIcon,
  Wand2,
  FlaskConical,
  Bug,
  Code2,
  Zap,
  CheckCircle2,
  ArrowUpRight,
  type LucideIcon
} from 'lucide-react'
import type { ChipId } from '@shared/types'
import { DIFF_CHIPS } from '@shared/types'

export interface ChipDef {
  id: ChipId
  label: string
  icon: LucideIcon
  diff: boolean
}

export const CHIP_DEFS: ChipDef[] = [
  { id: 'explain', label: 'Explain problem', icon: Lightbulb, diff: DIFF_CHIPS.has('explain') },
  { id: 'hints', label: 'Get hints', icon: Sparkles, diff: DIFF_CHIPS.has('hints') },
  { id: 'ideaMap', label: 'Idea map', icon: MapIcon, diff: DIFF_CHIPS.has('ideaMap') },
  { id: 'generate', label: 'Generate code', icon: Wand2, diff: DIFF_CHIPS.has('generate') },
  { id: 'addTests', label: 'Add test cases', icon: FlaskConical, diff: DIFF_CHIPS.has('addTests') },
  { id: 'lint', label: 'Lint code', icon: Bug, diff: DIFF_CHIPS.has('lint') },
  { id: 'complete', label: 'Complete code', icon: Code2, diff: DIFF_CHIPS.has('complete') },
  { id: 'optimize', label: 'Optimize solution', icon: Zap, diff: DIFF_CHIPS.has('optimize') },
  { id: 'checkLogic', label: 'Check code logic', icon: CheckCircle2, diff: DIFF_CHIPS.has('checkLogic') },
  { id: 'related', label: 'Related problems', icon: ArrowUpRight, diff: DIFF_CHIPS.has('related') }
]
