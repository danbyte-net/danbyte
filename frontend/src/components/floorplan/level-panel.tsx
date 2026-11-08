import { useSyncExternalStore } from "react"
import { Layers, Play } from "lucide-react"

import type { FloorPlanFloor, FloorPlanStack } from "@/lib/api"
import { BarMenuTrigger, BarTip } from "@/components/map-toolbar"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"

import { ANIMATE_LEVELS_MS, nextAnimateTarget } from "./level-explode"
import type { ExplodeStore } from "./level-explode"
import { elevationLabel } from "./levels"

/** Which other level the 2D onion skin draws under this one. */
export type OnionSide = "off" | "below" | "above"
/** What the 3D building draws: every level (upper ones ghosted), the levels
 * up to the active one, or the active one only. */
export type LevelMode = "all" | "upto" | "only"

/** The levels of an aligned floor plan, roof at the top and basements at
 * the bottom, each with its elevation - in place of the floor tabs. In 2D
 * it carries the onion skin; in 3D the level mode and the explode slider. */
export function LevelPanel({
  stack,
  currentId,
  onGo,
  view3d,
  onion,
  onOnion,
  mode,
  onMode,
  explode,
}: {
  stack: FloorPlanStack
  currentId: string
  onGo: (id: string) => void
  view3d: boolean
  onion: OnionSide
  onOnion: (side: OnionSide) => void
  mode: LevelMode
  onMode: (mode: LevelMode) => void
  /** Extra gap between levels, 0-1 of a storey - a store, so a slider
   * step re-renders this panel only. */
  explode: ExplodeStore
}) {
  const explodeValue = useSyncExternalStore(explode.subscribe, explode.get)
  const levels: FloorPlanFloor[] = [...stack.floors].reverse()
  return (
    <div
      className={cn(
        "absolute left-3 z-10 flex w-40 flex-col gap-1 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur",
        // 2D: clear of the legend at the bottom; 3D: clear of the cards
        // at the top.
        view3d ? "bottom-3" : "top-3"
      )}
      aria-label="Levels"
    >
      <ul className="grid max-h-72 gap-0.5 overflow-y-auto">
        {levels.map((f) => {
          const active = f.id === currentId
          return (
            <li key={f.id}>
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => !active && onGo(f.id)}
                className={cn(
                  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs whitespace-nowrap transition-colors",
                  active
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="num shrink-0 text-[11px] text-muted-foreground">
                  {elevationLabel(f.elevation)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="grid gap-1 border-t border-border pt-1">
        {view3d ? (
          <>
            <SegmentedTabs<LevelMode>
              value={mode}
              onValueChange={onMode}
              className="[&_button]:h-7 [&_button]:px-2 [&_button]:text-xs"
              items={[
                { value: "all", label: "All" },
                { value: "upto", label: "Up to" },
                { value: "only", label: "Only" },
              ]}
            />
            {mode !== "only" && (
              <div className="flex h-7 items-center gap-1">
                <BarTip tip="Animate levels" side="right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Animate levels"
                    className="size-7 shrink-0"
                    onClick={() => {
                      const to = nextAnimateTarget(explode)
                      // The full travel takes ANIMATE_LEVELS_MS; part of
                      // it, its share.
                      const ms =
                        ANIMATE_LEVELS_MS * Math.abs(to - explode.get())
                      explode.animateTo(to, Math.max(ms, 300))
                    }}
                  >
                    <Play />
                  </Button>
                </BarTip>
                <BarTip tip="Explode" side="right">
                  <div className="flex h-7 min-w-0 flex-1 items-center pr-2">
                    <Slider
                      thumbProps={{ "aria-label": "Explode" }}
                      min={0}
                      max={100}
                      step={5}
                      value={[Math.round(explodeValue * 100)]}
                      onValueChange={([v]) => explode.set(v / 100)}
                    />
                  </div>
                </BarTip>
              </div>
            )}
          </>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <BarMenuTrigger
                variant="ghost"
                aria-label="Onion skin"
                className={cn(
                  "w-full justify-between",
                  onion === "off" && "text-muted-foreground"
                )}
              >
                <Layers />
                <span className="flex-1 text-left">
                  {onion === "below"
                    ? "Below"
                    : onion === "above"
                      ? "Above"
                      : "Onion skin"}
                </span>
              </BarMenuTrigger>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end">
              <DropdownMenuRadioGroup
                value={onion}
                onValueChange={(v) => onOnion(v as OnionSide)}
              >
                <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="below">
                  Level below
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="above">
                  Level above
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}
