import { useDeferredValue, useMemo, useState } from "react"
import type { DragEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { Check, Search } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { CHASSIS_IDS_MIME } from "./diagram/placement"

// The device list's other kind on the Diagram: the virtual chassis the user
// may see (GET /api/topology/chassis/), each with the members they may see.
// A row drags onto a hand-picked map (CHASSIS_IDS_MIME) or is added with a
// double-click or Enter: the chassis is placed as a stack, and its members
// come with it as they are whenever the map loads.

/** One chassis as the palette lists it. */
export interface TopologyChassisRow {
  id: string
  name: string
  /** Its master, when that member is one the caller may see. */
  master_id: string | null
  /** The members the caller may see, by member number. */
  members: { id: string; name: string; vc_position: number | null }[]
}

export const CHASSIS_PALETTE_KEY = ["topology-chassis"] as const

export const chassisPaletteQuery = {
  queryKey: CHASSIS_PALETTE_KEY,
  queryFn: () =>
    api<{ results: TopologyChassisRow[] }>("/api/topology/chassis/"),
  staleTime: 60_000,
}

/** The rows matching `search`: by the chassis' name or a member's. */
export function filterChassis(
  rows: readonly TopologyChassisRow[],
  search: string
): TopologyChassisRow[] {
  const needle = search.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter(
    (r) =>
      r.name.toLowerCase().includes(needle) ||
      r.members.some((m) => m.name.toLowerCase().includes(needle))
  )
}

export interface ChassisPaletteProps {
  /** Chassis already placed on the map. */
  placed: ReadonlySet<string>
  /** The map is built by hand: rows drag onto it and Enter adds them. */
  editable: boolean
  /** Place these in the middle of what is on screen. */
  onAdd: (rows: TopologyChassisRow[]) => void
}

export function ChassisPalette({
  placed,
  editable,
  onAdd,
}: ChassisPaletteProps) {
  const q = useQuery(chassisPaletteQuery)
  const [search, setSearch] = useState("")
  const needle = useDeferredValue(search)
  const all = useMemo(() => q.data?.results ?? [], [q.data])
  const shown = useMemo(() => filterChassis(all, needle), [all, needle])

  const add = (r: TopologyChassisRow) => {
    if (editable && !placed.has(r.id)) onAdd([r])
  }
  const onDragStart = (e: DragEvent, r: TopologyChassisRow) => {
    if (!editable || placed.has(r.id)) {
      e.preventDefault()
      return
    }
    e.dataTransfer.effectAllowed = "copy"
    e.dataTransfer.setData(CHASSIS_IDS_MIME, JSON.stringify([r.id]))
  }

  return (
    <>
      <div className="px-2 pb-1.5">
        <div className="relative min-w-0">
          <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search virtual chassis…"
            aria-label="Search virtual chassis"
            className="h-8 pl-7 text-[13px]"
          />
        </div>
      </div>
      <div
        role="listbox"
        aria-label="Virtual chassis to place"
        className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {q.isLoading && <Loading />}
        {q.isError && <QueryError error={q.error} />}
        {q.data && !all.length && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No virtual chassis yet.
          </p>
        )}
        {q.data && all.length > 0 && !shown.length && (
          <p className="px-1 py-2 text-xs text-muted-foreground">No matches.</p>
        )}
        {shown.map((r) => {
          const on = placed.has(r.id)
          const draggable = editable && !on
          return (
            <div
              key={r.id}
              role="option"
              aria-selected={false}
              tabIndex={0}
              draggable={draggable}
              data-chassis={r.id}
              data-placed={on || undefined}
              onDoubleClick={() => add(r)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return
                e.preventDefault()
                add(r)
              }}
              onDragStart={(e) => onDragStart(e, r)}
              className={cn(
                "flex h-10 cursor-default items-center gap-2 rounded-md px-2 outline-none select-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50",
                draggable && "cursor-grab active:cursor-grabbing",
                on && "text-muted-foreground/60"
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] leading-4 font-medium">
                  {r.name}
                </div>
                <div
                  className={cn(
                    "truncate text-[11px] leading-4",
                    on ? "text-muted-foreground/50" : "text-muted-foreground"
                  )}
                >
                  {r.members.map((m) => m.name).join(" · ")}
                </div>
              </div>
              <Badge variant="secondary" className="num shrink-0">
                {r.members.length}
              </Badge>
              {on && (
                <Check className="size-3.5 shrink-0" aria-label="On the map" />
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
