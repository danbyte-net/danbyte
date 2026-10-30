import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RotateCw,
  Trash2,
  X,
} from "lucide-react"

import type { DeviceRole, FloorPlanTile, FloorTileTypeOption } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { BarTip } from "@/components/map-toolbar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import type { EditTile } from "./use-plan-edit-state"

/** The bulk bar over a multi-selection: facing, turn, type and delete for
 * every selected tile at once. */
export function SelectionBar({
  multiSel,
  setMultiSel,
  tiles,
  tileTypes,
  roles,
  setTileFacing,
  rotateSelectionTurn,
  changeTile,
  deleteTile,
}: {
  multiSel: Set<string>
  setMultiSel: (next: Set<string>) => void
  tiles: EditTile[]
  tileTypes: FloorTileTypeOption[]
  roles: DeviceRole[]
  setTileFacing: (tile: EditTile, orientation: EditTile["orientation"]) => void
  rotateSelectionTurn: () => void
  changeTile: (tileId: string, patch: Partial<FloorPlanTile>) => void
  deleteTile: (tileId: string) => void
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
        <span className="num pl-1 text-xs font-medium">
          {multiSel.size} selected
        </span>
        <span className="h-4 w-px bg-border" />
        <span className="text-[11px] text-muted-foreground">Front faces</span>
        {(
          [
            { o: 0 as const, icon: ArrowUp, label: "up" },
            { o: 90 as const, icon: ArrowRight, label: "right" },
            { o: 180 as const, icon: ArrowDown, label: "down" },
            { o: 270 as const, icon: ArrowLeft, label: "left" },
          ] as const
        ).map(({ o, icon: Icon, label }) => (
          <BarTip key={o} tip={`Front faces ${label}`}>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              aria-label={`Front faces ${label}`}
              onClick={() => {
                // Per-tile absolute facing - setTileFacing keeps the
                // footprint-swap + collision rules a hand rotate has.
                for (const tid of multiSel) {
                  const t = tiles.find((x) => x.id === tid)
                  if (t) setTileFacing(t, o)
                }
              }}
            >
              <Icon className="h-3.5 w-3.5" />
            </Button>
          </BarTip>
        ))}
        <BarTip tip="Turn the selection">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            aria-label="Turn the selection"
            disabled={multiSel.size < 2}
            onClick={rotateSelectionTurn}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        </BarTip>
        <span className="h-4 w-px bg-border" />
        <Select
          value=""
          onValueChange={(key) => {
            // "tt:<id>" | "role:<id>" - the palette's own keys.
            const [kind, tid] = key.split(":")
            if (kind === "tt") {
              const row = tileTypes.find((r) => r.id === tid)
              if (!row) return
              for (const sel of multiSel)
                changeTile(sel, {
                  tile_type: row,
                  role_type: null,
                })
            } else {
              const row = roles.find((r) => r.id === tid)
              if (!row) return
              for (const sel of multiSel)
                changeTile(sel, {
                  tile_type: null,
                  role_type: row,
                })
            }
          }}
        >
          <SelectTrigger size="sm" className="w-32 text-xs data-[size=sm]:h-7">
            <SelectValue placeholder="Set type…" />
          </SelectTrigger>
          <SelectContent>
            {tileTypes
              .filter((tt) => !tt.is_zone)
              .map((tt) => (
                <SelectItem key={tt.id} value={`tt:${tt.id}`}>
                  {tt.name}
                </SelectItem>
              ))}
            {roles.map((r) => (
              <SelectItem key={r.id} value={`role:${r.id}`}>
                <ColorBadge name={r.name} color={r.color} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="h-4 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-destructive hover:text-destructive"
          onClick={() => {
            for (const tid of multiSel) deleteTile(tid)
            setMultiSel(new Set())
          }}
        >
          <Trash2 className="mr-1 h-3 w-3" /> Delete
        </Button>
        <BarTip tip="Clear selection">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => setMultiSel(new Set())}
            aria-label="Clear selection"
          >
            <X className="h-3 w-3" />
          </Button>
        </BarTip>
      </div>
    </div>
  )
}
