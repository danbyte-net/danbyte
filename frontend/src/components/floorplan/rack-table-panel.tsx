import { useEffect, useMemo, useRef, useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Search, X } from "lucide-react"

import { buildRackColumns } from "@/components/columns/rack-columns"
import { DataTable } from "@/components/data-table"
import { Loading } from "@/components/loading"
import { BarIconButton } from "@/components/map-toolbar"
import { SectionLabel } from "@/components/map-panel"
import { QueryError } from "@/components/query-error"
import { useTableFilters } from "@/components/table-filters"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

import type { PlanRack } from "./plan-racks"

/** The panel's height, px: what it opens at, and the range a drag keeps it
 * in. Remembered per browser. */
const HEIGHT_KEY = "floorplan:rack-table-height"
const DEFAULT_HEIGHT = 300
const MIN_HEIGHT = 160
const MAX_SHARE = 0.6

function readHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY))
    return Number.isFinite(v) && v >= MIN_HEIGHT ? v : DEFAULT_HEIGHT
  } catch {
    return DEFAULT_HEIGHT
  }
}

function storeHeight(px: number) {
  try {
    localStorage.setItem(HEIGHT_KEY, String(Math.round(px)))
  } catch {
    /* private window or blocked storage: the height lasts this visit */
  }
}

/** The columns a plan's racks are compared by: what fills a rack. */
const COLUMNS = [
  "name",
  "role",
  "status",
  "devices",
  "utilisation",
  "power",
  "ports",
  "panel_ports",
  "tags",
] as const

/** Does a rack match the name box: its name or facility ID. */
export function matchesRackSearch(rack: PlanRack, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [rack.name, rack.facility_id].some((s) =>
    s.toLowerCase().includes(needle)
  )
}

/**
 * The plan's racks as a table under the canvas (#247): built from the rack
 * column factory, with the racks list's filters - the name box, then tags,
 * role, status and the advanced filter (custom fields among them) in the
 * rail. While it is open it stands in for the Objects list's racks.
 *
 * Pointing at a row points at its rack on the plan (`onHover`); a click on
 * the row - not on its links - focuses it (`onFocus`). While anything is
 * filtered, `onMatchChange` hands the page the racks still listed, so the
 * plan can fade the rest; null when nothing is.
 */
export function RackTablePanel({
  racks,
  loading = false,
  error,
  humanIds = false,
  onHover,
  onFocus,
  onMatchChange,
  onClose,
}: {
  racks: readonly PlanRack[]
  loading?: boolean
  error?: unknown
  humanIds?: boolean
  onHover: (rack: PlanRack | null) => void
  onFocus: (rack: PlanRack) => void
  onMatchChange: (rackIds: ReadonlySet<string> | null) => void
  onClose: () => void
}) {
  const [q, setQ] = useState("")
  const [height, setHeight] = useState(readHeight)
  const panel = useRef<HTMLElement>(null)

  const columns = useMemo<ColumnDef<PlanRack, unknown>[]>(
    () =>
      buildRackColumns<PlanRack>({
        include: [...COLUMNS],
        show: ["power", "ports", "panel_ports"],
        humanIds,
      }),
    [humanIds]
  )
  const searched = useMemo(
    () => racks.filter((r) => matchesRackSearch(r, q)),
    [racks, q]
  )
  const {
    rail,
    filteredRows,
    activeCount,
    columns: wired,
  } = useTableFilters(columns, searched)

  // The racks the filter keeps, for the plan to fade the rest - reported
  // only when the set changes, so a poll that refreshes the rows does not
  // re-render the page for nothing.
  const filtered = !!q.trim() || activeCount > 0
  const matchKey = filtered
    ? filteredRows
        .map((r) => r.id)
        .sort()
        .join(",")
    : null
  const report = useRef(onMatchChange)
  report.current = onMatchChange
  useEffect(() => {
    report.current(
      matchKey == null ? null : new Set(matchKey ? matchKey.split(",") : [])
    )
  }, [matchKey])
  // Closing the panel ends its filter's hold on the plan.
  useEffect(() => () => report.current(null), [])

  // Drag the top edge to resize, within MIN_HEIGHT and a share of the
  // column it sits in.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const parent = panel.current?.parentElement
    const max = Math.max(MIN_HEIGHT, (parent?.clientHeight ?? 800) * MAX_SHARE)
    const clamp = (v: number) => Math.min(max, Math.max(MIN_HEIGHT, v))
    let last = startH
    const move = (ev: PointerEvent) => {
      last = clamp(startH + startY - ev.clientY)
      setHeight(last)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      storeHeight(last)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  return (
    <section
      ref={panel}
      aria-label="Racks"
      data-slot="rack-table-panel"
      className="relative flex shrink-0 flex-col border-t border-border bg-background"
      style={{ height }}
    >
      <div
        aria-hidden
        onPointerDown={startResize}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
      />
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <SectionLabel className="mb-0">Racks</SectionLabel>
        <Badge variant="secondary" className="num">
          {filtered
            ? `${filteredRows.length} of ${racks.length}`
            : racks.length}
        </Badge>
        <div className="relative ml-2 w-56">
          <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find rack…"
            aria-label="Find rack"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <BarIconButton label="Close" className="ml-auto" onClick={onClose}>
          <X />
        </BarIconButton>
      </div>
      <div className="flex min-h-0 flex-1">
        {rail}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-3 pt-1.5 pb-2">
          {error ? (
            <QueryError error={error} />
          ) : loading ? (
            <Loading />
          ) : (
            <DataTable
              data={filteredRows}
              columns={wired}
              tableId="floorplan-racks"
              flexColumn="tags"
              stickyHeader
              onRowHover={onHover}
              onRowClick={onFocus}
            />
          )}
        </div>
      </div>
    </section>
  )
}
