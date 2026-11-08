import { Search } from "lucide-react"
import { useEffect, useState } from "react"

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
import { cn } from "@/lib/utils"

import { endText } from "./cable-draw"
import { tileName } from "./floor-canvas"
import { HIT_GROUPS, searchPlan } from "./plan-search"
import type { PlanHit } from "./plan-search"
import { areaName } from "./shapes"

type SearchIn = Parameters<typeof searchPlan>[0]

function hitLabel(h: PlanHit): { main: string; sub: string } {
  switch (h.kind) {
    case "object": {
      const t = h.tile
      return {
        main: tileName(t) || t.tile_type?.name || t.role_type?.name || "Tile",
        sub: t.linked?.kind ?? "",
      }
    }
    case "cable": {
      const cp = h.cable
      return {
        main: cp.label || "Cable",
        sub:
          h.match ||
          `${endText(cp.a_points.length ? cp.a_points : (cp.a_far ?? []))} – ${endText(cp.b_points.length ? cp.b_points : (cp.b_far ?? []))}`,
      }
    }
    case "tray":
      return { main: h.tray.name || "Tray", sub: h.tray.kind }
    case "area":
      return { main: areaName(h.area) || "Area", sub: "" }
  }
}

/** "Find on plan…": objects, cables (by label, id, or an end's device and
 * port), trays and areas, grouped; arrows move, Enter picks. */
export function PlanSearch({
  searchIn,
  value,
  onChange,
  onPick,
}: {
  searchIn: SearchIn
  value: string
  onChange: (v: string) => void
  onPick: (hit: PlanHit) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const hits = searchPlan(searchIn, value)
  useEffect(() => setActive(0), [value])
  const pick = (h: PlanHit | undefined) => {
    if (!h) return
    onPick(h)
    setOpen(false)
  }
  return (
    <Popover open={open && hits.length > 0} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <InputGroup className="h-7 w-40 shrink-0">
          <InputGroupAddon>
            <Search className="size-3" />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Find on plan…"
            aria-label="Find on plan"
            role="combobox"
            aria-expanded={open && hits.length > 0}
            aria-controls="plan-search-results"
            aria-activedescendant={
              hits[active] ? `plan-hit-${hits[active].id}` : undefined
            }
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              setOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                setOpen(true)
                if (!hits.length) return
                const step = e.key === "ArrowDown" ? 1 : -1
                setActive((i) => (i + step + hits.length) % hits.length)
              } else if (e.key === "Enter") {
                e.preventDefault()
                pick(hits[active] ?? hits[0])
              } else if (e.key === "Escape") {
                setOpen(false)
              }
            }}
            className="h-7 text-xs md:text-xs"
          />
        </InputGroup>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-96 w-72 overflow-auto p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div id="plan-search-results" role="listbox">
          {HIT_GROUPS.map((g) => {
            const rows = hits.filter((h) => h.kind === g.kind)
            if (!rows.length) return null
            return (
              <div key={g.kind} role="group" aria-label={g.label}>
                <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                  {g.label}
                </div>
                {rows.map((h) => {
                  const i = hits.indexOf(h)
                  const { main, sub } = hitLabel(h)
                  return (
                    <button
                      key={h.id}
                      id={`plan-hit-${h.id}`}
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(h)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px]",
                        i === active ? "bg-muted" : "hover:bg-muted/60"
                      )}
                    >
                      <span
                        className={cn(
                          "min-w-0 truncate",
                          h.kind === "cable" && "font-mono"
                        )}
                      >
                        {main}
                      </span>
                      {sub && (
                        <span className="ml-auto min-w-0 shrink truncate text-[10px] text-muted-foreground">
                          {sub}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
