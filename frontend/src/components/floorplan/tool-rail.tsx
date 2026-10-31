import {
  BrickWall,
  Cable,
  DoorOpen,
  Crop,
  LayoutGrid,
  MousePointer2,
  Move,
  Pentagon,
  Square,
  Type,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { BarIconButton } from "@/components/map-toolbar"
import { cn } from "@/lib/utils"

import type { EditorTool } from "./use-plan-edit-state"

/** The tool rail's tools in order, with their keys. */
export const TOOLS: {
  tool: EditorTool
  label: string
  /** The key that picks it, as `KeyboardEvent.key` (lower case). */
  key: string
  /** Shift is held with the key. */
  shift?: boolean
  icon: LucideIcon
}[] = [
  { tool: "select", label: "Select", key: "v", icon: MousePointer2 },
  { tool: "rect", label: "Room or area", key: "r", icon: Square },
  {
    tool: "polygon",
    label: "Polygon area",
    key: "r",
    shift: true,
    icon: Pentagon,
  },
  { tool: "label", label: "Label", key: "t", icon: Type },
  { tool: "tiles", label: "Tiles", key: "g", icon: LayoutGrid },
  {
    tool: "structure",
    label: "Walls and raised floors",
    key: "w",
    icon: BrickWall,
  },
  { tool: "door", label: "Door", key: "d", icon: DoorOpen },
  { tool: "trays", label: "Cable trays", key: "c", icon: Cable },
  { tool: "snapshot", label: "Snapshot", key: "s", icon: Crop },
]

/** The tool a key picks, if any. */
export function toolForKey(key: string, shift: boolean): EditorTool | null {
  const k = key.toLowerCase()
  return TOOLS.find((t) => t.key === k && !!t.shift === shift)?.tool ?? null
}

/** The editor's tool rail (Edit only): one button per tool, and the plan's
 * placement mode at the foot. */
export function ToolRail({
  tool,
  onToolChange,
  free,
  onToggleFree,
  canToggleFree = true,
}: {
  tool: EditorTool
  onToolChange: (tool: EditorTool) => void
  /** The plan places tiles freely. */
  free: boolean
  /** Grid → free at once; free → grid through Snap all. */
  onToggleFree: () => void
  /** False on a live view: its layout is its source's. */
  canToggleFree?: boolean
}) {
  return (
    <nav
      aria-label="Tools"
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border py-2"
    >
      {TOOLS.map((t) => {
        const Icon = t.icon
        const active = t.tool === tool
        return (
          <BarIconButton
            key={t.tool}
            label={t.label}
            shortcut={(t.shift ? "⇧" : "") + t.key.toUpperCase()}
            tipSide="right"
            aria-pressed={active}
            className={cn(
              active &&
                "border-primary/50 bg-accent text-accent-foreground hover:bg-accent"
            )}
            onClick={() => onToolChange(t.tool)}
          >
            <Icon />
          </BarIconButton>
        )
      })}
      <div className="mt-auto" />
      {canToggleFree && (
        <BarIconButton
          label={free ? "Back to the grid…" : "Free placement"}
          tipSide="right"
          aria-pressed={free}
          className={cn(
            free &&
              "border-primary/50 bg-accent text-accent-foreground hover:bg-accent"
          )}
          onClick={onToggleFree}
        >
          <Move />
        </BarIconButton>
      )}
    </nav>
  )
}
