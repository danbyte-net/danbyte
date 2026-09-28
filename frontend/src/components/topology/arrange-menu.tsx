import { useRef, useState } from "react"
import {
  ArrowDown,
  ArrowRight,
  Eraser,
  Layers,
  LayoutGrid,
  RefreshCw,
  Rows3,
} from "lucide-react"

import { BarMenuTrigger } from "@/components/map-toolbar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LevelOrganiser } from "./level-organiser"
import type { LevelsProps } from "./level-organiser"

export type LayoutDirection = "LR" | "TB"

/**
 * The second bar's Arrange ▾: how the map is placed. Reset layout, then on
 * the Diagram the layer bands and the Layout group - the direction as a
 * radio pair and "Levels…", which opens the level organiser hanging from
 * this same button. The Hierarchy's layout has no direction or levels (its
 * ranks are the cabling), so it passes only `onReset`.
 */
export function ArrangeMenu({
  onReset,
  resetDisabled = false,
  bands,
  direction,
  levels,
}: {
  onReset: () => void
  resetDisabled?: boolean
  /** Diagram: arrange or clear the layer bands. */
  bands?: {
    onByRole: () => void
    onByType: () => void
    onClear: () => void
    /** There are bands to clear. */
    canClear: boolean
  }
  /** Diagram: which way the layout runs. */
  direction?: {
    value: LayoutDirection
    onChange: (direction: LayoutDirection) => void
  }
  /** Diagram, not grouped: the roles' levels. */
  levels?: LevelsProps
}) {
  const [levelsOpen, setLevelsOpen] = useState(false)
  // "Levels…" opens the popover once the menu has gone, and keeps the
  // focus off the button: opened while the menu was still closing, the
  // menu took the focus back and the popover shut again at once.
  const toLevels = useRef(false)
  const trigger = (
    <DropdownMenuTrigger asChild>
      <BarMenuTrigger>
        <LayoutGrid /> Arrange
      </BarMenuTrigger>
    </DropdownMenuTrigger>
  )
  return (
    <DropdownMenu>
      {levels ? (
        <LevelOrganiser
          open={levelsOpen}
          onOpenChange={setLevelsOpen}
          {...levels}
        >
          {trigger}
        </LevelOrganiser>
      ) : (
        trigger
      )}
      <DropdownMenuContent
        align="end"
        className="w-auto min-w-48 whitespace-nowrap"
        onCloseAutoFocus={(e) => {
          if (!toLevels.current) return
          toLevels.current = false
          e.preventDefault()
          setLevelsOpen(true)
        }}
      >
        <DropdownMenuItem disabled={resetDisabled} onSelect={onReset}>
          <RefreshCw /> Reset layout
        </DropdownMenuItem>
        {bands && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={bands.onByRole}>
              <Rows3 /> Bands by role
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={bands.onByType}>
              <Rows3 /> Bands by device type
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!bands.canClear}
              onSelect={bands.onClear}
            >
              <Eraser /> Clear bands
            </DropdownMenuItem>
          </>
        )}
        {(direction || levels) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Layout</DropdownMenuLabel>
            {direction && (
              <DropdownMenuRadioGroup
                value={direction.value}
                onValueChange={(v) => {
                  // Picking the way it already runs is no change: a new
                  // direction drops the arrangement.
                  if (v !== direction.value)
                    direction.onChange(v as LayoutDirection)
                }}
              >
                <DropdownMenuRadioItem value="LR">
                  <ArrowRight /> Left to right
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="TB">
                  <ArrowDown /> Top to bottom
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            )}
            {levels && (
              <DropdownMenuItem
                onSelect={() => {
                  toLevels.current = true
                }}
              >
                <Layers /> Levels…
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
