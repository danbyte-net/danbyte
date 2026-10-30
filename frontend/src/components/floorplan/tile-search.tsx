import { Search } from "lucide-react"
import { useState } from "react"

import type { FloorPlanTile } from "@/lib/api"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

import { tileName } from "./floor-canvas"
import { searchTiles } from "./selection"

/** Header search - jump to a tile by label / linked object / type name. */
export function TileSearch({
  tiles,
  value,
  onChange,
  onPick,
}: {
  tiles: FloorPlanTile[]
  value: string
  onChange: (v: string) => void
  onPick: (tile: FloorPlanTile) => void
}) {
  const [open, setOpen] = useState(false)
  const matches = searchTiles(tiles, value).map((h) => h.tile)
  return (
    <Popover open={open && matches.length > 0} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <InputGroup className="h-7 w-40 shrink-0">
          <InputGroupAddon>
            <Search className="size-3" />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Find on plan…"
            aria-label="Find on plan"
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              setOpen(true)
            }}
            onKeyDown={(e) => {
              // Enter jumps to the best hit, as the Objects list's search does.
              if (e.key === "Enter" && matches[0]) {
                e.preventDefault()
                onPick(matches[0])
                setOpen(false)
              }
            }}
            className="h-7 text-xs md:text-xs"
          />
        </InputGroup>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {matches.map((t) => {
          const label =
            tileName(t) || t.tile_type?.name || t.role_type?.name || "Tile"
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                onPick(t)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-muted/60"
            >
              <span className="truncate">{label}</span>
              {t.linked && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {t.linked.kind}
                </span>
              )}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
