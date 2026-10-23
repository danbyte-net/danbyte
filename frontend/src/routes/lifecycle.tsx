import { useMemo } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  LifecycleOverview,
  LifecycleRow,
  LifecycleWindow,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { useSearchWriter, useUrlSearch } from "@/lib/url-filters"
import { useUrlFlag } from "@/lib/use-url-state"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { useUrlTableFilters } from "@/components/table-filters"
import {
  WINDOW_LABELS,
  WINDOW_ORDER,
  WINDOW_PARAMS,
  WINDOW_VARIANT,
  buildLifecycleColumns,
} from "@/components/columns/lifecycle-columns"

// The Lifecycle page (#436): every device and VM against the end dates that
// matter to it - hardware, OS, support coverage - one row per object per
// source, soonest first. Laid out like Port utilization: the rows come in one
// request and the rail narrows them. Deep links set the facets:
// /lifecycle?source=coverage&window=90.

export const Route = createFileRoute("/lifecycle")({
  component: LifecyclePage,
})

type Row = LifecycleRow & { id: string }

function LifecyclePage() {
  const [search, setSearch] = useUrlSearch()
  // Rows with no date are counted, and listed only on request.
  const [undated, setUndated] = useUrlFlag("undated", false)
  const write = useSearchWriter()
  const q = useQuery({
    queryKey: ["lifecycle", undated],
    queryFn: () =>
      api<LifecycleOverview>(
        undated ? "/api/lifecycle/?undated=1" : "/api/lifecycle/"
      ),
    staleTime: 60_000,
  })
  const rows = useMemo<Row[]>(
    () =>
      (q.data?.results ?? []).map((r) => ({
        ...r,
        id: `${r.object.kind}:${r.object.id}:${r.source}`,
      })),
    [q.data]
  )
  const searched = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return rows
    return rows.filter(
      (r) =>
        r.object.name.toLowerCase().includes(s) ||
        (r.item?.name ?? "").toLowerCase().includes(s)
    )
  }, [rows, search])

  const windows = q.data?.windows
  const columns = useMemo(
    () => buildLifecycleColumns<Row>({ selection: true, windows }),
    [windows]
  )
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
    toggleValue,
    selectedValues,
  } = useUrlTableFilters(columns, searched, {
    railExtras: (
      <label className="-mx-1.5 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
        <Checkbox checked={undated} onCheckedChange={(v) => setUndated(!!v)} />
        <span>Show undated</span>
      </label>
    ),
  })

  const picked = selectedValues("window")
  const pickWindow = (w: LifecycleWindow) => {
    // The undated rows are listed on request: asking for them asks for that.
    if (w === "none" && !undated) write((prev) => ({ ...prev, undated: "1" }))
    toggleValue("window", WINDOW_PARAMS[w])
  }

  return (
    <ListPageShell
      title="Lifecycle"
      count={q.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        // Its own page key, like Port utilization's (#107): a Devices view
        // evaluated against these rows would blank the table.
        objectType: "lifecycle",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Filter devices and VMs…",
      }}
      summary={
        q.data && (
          <WindowChips
            counts={q.data.counts}
            picked={picked}
            onPick={pickWindow}
          />
        )
      }
      query={q}
    >
      {rows.length === 0 ? (
        <EmptyState title="No end dates yet.">
          Enter lifecycle dates on{" "}
          <Link to="/device-types" className="link">
            device types
          </Link>{" "}
          and{" "}
          <Link to="/platforms" className="link">
            platforms
          </Link>
          , or turn on{" "}
          <Link to="/settings/admin" className="link">
            Settings → General → End-of-life data
          </Link>
          .
        </EmptyState>
      ) : (
        <DataTable
          data={filteredRows}
          columns={wiredColumns}
          flexColumn="object"
          tableId="lifecycle"
          exportName="lifecycle"
          exportTitle="Lifecycle"
        />
      )}
    </ListPageShell>
  )
}

/** A count chip per window, from the response - so they follow your access,
 * not the rail. A chip toggles its window in the Window facet. */
function WindowChips({
  counts,
  picked,
  onPick,
}: {
  counts: LifecycleOverview["counts"]
  picked: Set<string>
  onPick: (w: LifecycleWindow) => void
}) {
  return (
    <div
      role="group"
      aria-label="Windows"
      className="flex flex-wrap items-center gap-1.5"
    >
      {WINDOW_ORDER.map((w) => {
        const on = picked.has(WINDOW_PARAMS[w])
        return (
          <button
            key={w}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(w)}
            className={cn(
              "rounded-[5px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              on && "ring-1 ring-foreground/40"
            )}
          >
            <Badge variant={WINDOW_VARIANT[w]} className="cursor-pointer">
              {WINDOW_LABELS[w]} <span className="num">{counts[w]}</span>
            </Badge>
          </button>
        )
      })}
    </div>
  )
}
