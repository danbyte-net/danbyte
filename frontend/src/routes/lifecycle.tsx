import { useMemo } from "react"
import type { ReactNode } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  LifecycleOverview,
  LifecycleRow,
  LifecycleWindow,
} from "@/lib/api"
import { useServerList } from "@/lib/server-list"
import { cn } from "@/lib/utils"
import { useListSearch, useSearchWriter, useUrlSearch } from "@/lib/url-filters"
import { useUrlFlag } from "@/lib/use-url-state"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { LifecycleVersions } from "@/components/lifecycle-versions"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { wireFacetColumns } from "@/components/table-filters"
import {
  WINDOW_LABELS,
  WINDOW_ORDER,
  WINDOW_PARAMS,
  WINDOW_VARIANT,
  buildLifecycleColumns,
} from "@/components/columns/lifecycle-columns"

// The Lifecycle page (#436): every device and VM against the end dates that
// matter to it - hardware, OS, support coverage - one row per object per
// source, soonest first. Laid out like Port utilization: paged, sorted and
// counted on the server (#535). Deep links set the facets:
// /lifecycle?source=coverage&window=90. The Versions view (#451) counts
// devices and VMs per platform and running version: /lifecycle?view=versions.

export const Route = createFileRoute("/lifecycle")({
  component: LifecyclePage,
})

type Row = LifecycleRow & { id: string }

/** `/api/lifecycle/summary/`: the window chips' counts and the windows. */
type LifecycleSummary = Pick<
  LifecycleOverview,
  "counts" | "windows" | "eol_enabled"
>

type LifecycleView = "objects" | "versions"

const VIEWS = [
  { value: "objects", label: "Objects" },
  { value: "versions", label: "Versions" },
] as const

function LifecyclePage() {
  const search = useListSearch()
  const write = useSearchWriter()
  const view: LifecycleView =
    search.view === "versions" ? "versions" : "objects"
  // A view's filters mean nothing to the other one: switching starts clean.
  const viewSwitch = (
    <SegmentedTabs<LifecycleView>
      value={view}
      onValueChange={(v) => write(() => (v === "versions" ? { view: v } : {}))}
      items={VIEWS}
    />
  )
  return view === "versions" ? (
    <LifecycleVersions viewSwitch={viewSwitch} />
  ) : (
    <LifecycleObjects viewSwitch={viewSwitch} />
  )
}

/** The rail's facets, counted by the server (`/api/lifecycle/facets/`). */
const FACETS = [
  "kind",
  "source",
  "application",
  "status",
  "window",
  "site",
  "role",
  "manufacturer",
  "tags",
]

function LifecycleObjects({ viewSwitch }: { viewSwitch: ReactNode }) {
  const [search, setSearch] = useUrlSearch()
  // Rows with no date are counted, and listed only on request.
  const [undated, setUndated] = useUrlFlag("undated", false)
  const write = useSearchWriter()
  // The chips count every row you may see, not the rail's (#535: one
  // grouped query, not the whole list).
  const summary = useQuery({
    queryKey: ["lifecycle", "summary"],
    queryFn: () => api<LifecycleSummary>("/api/lifecycle/summary/"),
    staleTime: 60_000,
  })
  const windows = summary.data?.windows
  const facetColumns = useMemo(
    () => buildLifecycleColumns<Row>({ selection: true, windows }),
    [windows]
  )
  const list = useServerList<Row>({
    endpoint: "/api/lifecycle/",
    queryKey: "lifecycle",
    columns: facetColumns,
    facets: FACETS,
    params: { undated: undated ? "1" : undefined },
    savedViews: "lifecycle",
    railExtras: (
      <label className="-mx-1.5 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
        <Checkbox checked={undated} onCheckedChange={(v) => setUndated(!!v)} />
        <span>Show undated</span>
      </label>
    ),
  })
  const { selectedValues, toggleValue } = list
  const columns = useMemo(
    () => wireFacetColumns(facetColumns, selectedValues, toggleValue),
    [facetColumns, selectedValues, toggleValue]
  )
  const counts = summary.data?.counts
  // Nothing to list at all - not a filter that matches nothing.
  const nothing =
    !!counts &&
    !list.search &&
    Object.entries(counts).every(
      ([w, n]) => n === 0 || (w === "none" && !undated)
    )

  const picked = selectedValues("window")
  const pickWindow = (w: LifecycleWindow) => {
    // The undated rows are listed on request: asking for them asks for that.
    if (w === "none" && !undated) write((prev) => ({ ...prev, undated: "1" }))
    toggleValue("window", WINDOW_PARAMS[w])
  }

  return (
    <ListPageShell
      title="Lifecycle"
      count={list.query.data ? list.total : undefined}
      rail={list.rail}
      savedViews={list.savedViews}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Filter devices and VMs…",
      }}
      actions={viewSwitch}
      summary={
        counts && (
          <WindowChips counts={counts} picked={picked} onPick={pickWindow} />
        )
      }
      query={list.query}
    >
      {nothing ? (
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
          data={list.rows}
          columns={columns}
          {...list.tableProps}
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
  counts: LifecycleSummary["counts"]
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
