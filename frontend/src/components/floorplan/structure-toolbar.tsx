import { DoorOpen, FlipHorizontal2, Merge, Trash2 } from "lucide-react"

import { BarIconButton } from "@/components/map-toolbar"

import { runsTouch } from "./structure"
import type { RunRow, StructShape } from "./structure"

/**
 * The small bar above a selected wall, door, tray or raised floor (Edit):
 * add a door, flip a door's swing, join two runs picked together, delete.
 * The same bar the tiles, areas and labels carry.
 */
export function StructureToolbar({
  row,
  door,
  picked,
  doorArmed,
  onArmDoor,
  onFlipDoor,
  onDeleteDoor,
  onJoin,
  onDelete,
}: {
  row: StructShape | null
  /** The wall's door selected, by index. */
  door: number | null
  /** The runs picked with Shift or Ctrl/⌘. */
  picked: StructShape[]
  doorArmed: boolean
  onArmDoor: () => void
  onFlipDoor: (index: number) => void
  onDeleteDoor: (index: number) => void
  onJoin: (aId: string, bId: string) => void
  onDelete: (id: string) => void
}) {
  if (!row) return null
  const pair =
    picked.length === 2 &&
    picked[0].part === picked[1].part &&
    picked[0].part !== "raised_floor" &&
    runsTouch(picked[0] as RunRow, picked[1] as RunRow)
      ? picked
      : null
  const noun =
    row.part === "wall" ? "Wall" : row.part === "tray" ? "Tray" : "Raised floor"
  return (
    <div
      role="toolbar"
      aria-label={door !== null ? "Door" : noun}
      className="flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-md"
    >
      {row.part === "wall" && door !== null && (
        <BarIconButton
          label="Flip swing"
          shortcut="F"
          tipSide="top"
          onClick={() => onFlipDoor(door)}
        >
          <FlipHorizontal2 />
        </BarIconButton>
      )}
      {row.part === "wall" && door === null && (
        <BarIconButton
          label="Add door"
          tipSide="top"
          aria-pressed={doorArmed}
          onClick={onArmDoor}
        >
          <DoorOpen />
        </BarIconButton>
      )}
      {pair && (
        <BarIconButton
          label={row.part === "wall" ? "Join walls" : "Join trays"}
          shortcut="J"
          tipSide="top"
          onClick={() => onJoin(pair[0].id, pair[1].id)}
        >
          <Merge />
        </BarIconButton>
      )}
      <BarIconButton
        label={door !== null ? "Delete door" : `Delete ${noun.toLowerCase()}`}
        tipSide="top"
        destructive
        onClick={() =>
          door !== null ? onDeleteDoor(door) : onDelete(row.id)
        }
      >
        <Trash2 />
      </BarIconButton>
    </div>
  )
}
