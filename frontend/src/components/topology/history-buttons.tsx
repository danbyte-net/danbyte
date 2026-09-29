import { Redo2, Undo2 } from "lucide-react"

import { BarIconButton } from "@/components/map-toolbar"
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu"
import { isApplePlatform, modKey } from "@/lib/mod-key"

// Undo and Redo for the map's document - the arrangement, bands, zones,
// text, hidden objects and the hand-picked set. They do what Ctrl+Z and
// Ctrl+Shift+Z do, and are disabled with nothing to step to.

export interface HistoryProps {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}

/** The undo key as a label: "Ctrl+Z", or "⌘Z" on a Mac. */
export const undoKey = () => `${modKey()}Z`
/** The redo key as a label: "Ctrl+Shift+Z", or "⇧⌘Z" on a Mac. */
export const redoKey = () => (isApplePlatform() ? "⇧⌘Z" : "Ctrl+Shift+Z")

/** The second bar's icon buttons, each with its key in the tooltip. */
export function HistoryButtons({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: HistoryProps) {
  return (
    <>
      <BarIconButton
        label="Undo"
        shortcut={undoKey()}
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Undo2 />
      </BarIconButton>
      <BarIconButton
        label="Redo"
        shortcut={redoKey()}
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2 />
      </BarIconButton>
    </>
  )
}

/** The same two in the bar's More menu, once the bar is too narrow. */
export function HistoryMenuItems({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: HistoryProps) {
  return (
    <>
      <DropdownMenuItem disabled={!canUndo} onSelect={onUndo}>
        <Undo2 /> Undo
        <DropdownMenuShortcut>{undoKey()}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canRedo} onSelect={onRedo}>
        <Redo2 /> Redo
        <DropdownMenuShortcut>{redoKey()}</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  )
}
