import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Search } from "lucide-react"
import { useMemo, useState } from "react"

import {
  api,
  type BulkStatusEntry,
  type BulkStatusResponse,
  type Paginated,
  type Prefix,
} from "@/lib/api"
import { annotateNesting, type NestedPrefix } from "@/lib/prefix-tree"
import { ColorBadge } from "@/components/cells/color-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/data-table"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { useTableFilters } from "@/components/table-filters"
import { useCustomFieldDefs } from "@/components/custom-field-display"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { PrefixSpaceOverview } from "@/components/prefix-space-overview"
import { QueryError } from "@/components/query-error"
import { PrefixDeleteDialog } from "@/components/prefix-delete-dialog"
import { useViolationMap } from "@/components/compliance/violation-badge"
import { PrefixBulkBar } from "@/components/prefix-bulk-bar"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/prefixes/")({ component: PrefixesPage })

// Stable empty fallback so `columns` (which depends on `monitoring`) keeps a
// constant identity while the status query loads — otherwise facets/filteredRows
// churn every render and DataTable's selection effect loops (see useTableFilters).
const EMPTY_MON: Record<string, BulkStatusEntry> = {}

function PrefixesPage() {
  const { canDo } = useMe()
  const canAdd = canDo("prefix", "add")
  const canEdit = canDo("prefix", "change")
  const canDelete = canDo("prefix", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Prefix | null>(null)
  const [selectedRows, setSelectedRows] = useState<Prefix[]>([])
  const [tab, setTab] = useState<"prefixes" | "ips" | "map">("prefixes")

  const query = useQuery({
    queryKey: ["prefixes", q],
    queryFn: () =>
      api<Paginated<Prefix>>(
        `/api/prefixes/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = useMemo(() => query.data?.results ?? [], [query.data])

  const cfQuery = useCustomFieldDefs("prefix")
  const cfDefs = useMemo(() => cfQuery.data?.results ?? [], [cfQuery.data])

  // The filter rail derives from the factory's facet metadata (status, VLAN,
  // site, VRF, utilisation, tags + one facet per tenant custom field), so a
  // new facetable column — or a new custom field — shows up automatically.
  // These facet-source columns are never rendered; the render columns below
  // add the interactive extras (selection, tag-chip wiring, actions).
  const facetColumns = useMemo<ColumnDef<Prefix>[]>(
    () =>
      buildPrefixColumns<Prefix>({
        omit: ["vrf"],
        cfDefs,
        vrfGroupColumn: true,
      }),
    [cfDefs]
  )
  const { rail, filteredRows, toggleValue, selectedValues } = useTableFilters(
    facetColumns,
    allRows
  )
  const tagSelection = selectedValues("tags")

  // Filter → annotate with nesting depth → keep Global VRF on top. The
  // annotation runs on the filtered set so a hidden parent doesn't push
  // its visible children to depth 0 (they'd otherwise float at the root
  // and look unrelated to the rest of their subnet).
  const rows = useMemo<NestedPrefix[]>(() => {
    const nested = annotateNesting(filteredRows)
    return nested.sort((a, b) => {
      const av = a.vrf ? 1 : 0
      const bv = b.vrf ? 1 : 0
      if (av !== bv) return av - bv // Global first
      const an = a.vrf?.name ?? ""
      const bn = b.vrf?.name ?? ""
      if (an !== bn) return an.localeCompare(bn) // then VRF alpha
      // Don't re-sort by CIDR — annotateNesting already laid out a stable
      // depth-first parent→child order within each VRF.
      return 0
    })
  }, [filteredRows])

  // Monitoring roll-up status for the visible prefixes (separate query so the
  // api app stays decoupled from the monitoring app). Merged into the table as
  // a status column.
  const prefixIds = useMemo(() => rows.map((r) => r.id), [rows])
  const monQuery = useQuery({
    queryKey: ["prefix-mon-status", prefixIds],
    // POST — a page of UUIDs makes a URL longer than proxy request-line
    // limits (gunicorn 400s at ~110 ids), which blanked the whole column.
    queryFn: () =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ prefixes: prefixIds }),
      }),
    enabled: prefixIds.length > 0,
  })
  const monitoring = monQuery.data?.statuses ?? EMPTY_MON
  const violations = useViolationMap()

  const columns = useMemo<ColumnDef<NestedPrefix>[]>(
    () =>
      buildPrefixColumns<NestedPrefix>({
        // VRF renders as the group banner (hidden vrfName column), not a
        // per-row column.
        omit: ["vrf"],
        selection: true,
        nested: true,
        violations,
        monitoring,
        cfDefs,
        tagFilter: {
          activeSlugs: tagSelection,
          onToggle: (slug) => toggleValue("tags", slug),
        },
        vrfGroupColumn: true,
        actions: {
          editTo: "/prefixes/$id/edit",
          editParams: (p) => ({ id: p.id }),
          canEdit: (p) => objCan(p, "change", canEdit),
          onDelete: setDeleting,
          canDelete: (p) => objCan(p, "delete", canDelete),
        },
      }),
    [
      tagSelection,
      toggleValue,
      cfDefs,
      monitoring,
      violations,
      canEdit,
      canDelete,
    ]
  )

  return (
    // Outer column: detail-style tabs on top, then the row (filter rail +
    // main). `min-h-0` lets the row honour its own overflow rules instead
    // of expanding the parent — what makes both columns scroll independently.
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as typeof tab)}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex h-10 items-center border-b border-border px-4 lg:px-6">
        <SegmentedTabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          items={[
            { value: "prefixes", label: "Prefixes" },
            { value: "ips", label: "IPs" },
            { value: "map", label: "Map" },
          ]}
        />
      </div>

      <TabsContent value="prefixes" className="m-0 flex min-h-0 flex-1">
        {/* Filter rail — derived from the columns' facet metadata. */}
        {rail}

        {/* Main — independent scroll for the table area. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
            <h1 className="text-base font-semibold">Prefixes</h1>
            {query.data && (
              <Badge variant="secondary" className="rounded-md">
                {rows.length}
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-2">
              <TableActions ioType="prefix" />
              <div className="relative">
                <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter by CIDR, description…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="h-8 w-72 pl-8 text-xs"
                />
              </div>
              {canAdd && (
                <Button size="sm" asChild>
                  <Link
                    to="/prefixes/new"
                    search={{
                      cidr: undefined,
                      vrf: undefined,
                      site: undefined,
                      location: undefined,
                    }}
                  >
                    Add prefix
                  </Link>
                </Button>
              )}
            </div>
          </header>

          <div className="flex-1 overflow-auto p-4 lg:p-6">
            {query.isLoading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {query.isError && <QueryError error={query.error} />}
            {query.data && (
              <DataTable
                data={rows}
                columns={columns}
                groupBy="vrfName"
                renderGroupHeader={renderVrfGroupHeader}
                onSelectedRowsChange={setSelectedRows}
                initialColumnVisibility={{ vrfName: false }}
                tableId="prefixes"
              />
            )}
          </div>
        </div>
      </TabsContent>

      <TabsContent value="ips" className="m-0 flex-1 overflow-auto p-4 lg:p-6">
        <p className="text-sm text-muted-foreground">
          All IP addresses — coming next.
        </p>
      </TabsContent>

      <TabsContent value="map" className="m-0 flex-1 overflow-auto p-4 lg:p-6">
        <PrefixSpaceOverview />
      </TabsContent>

      {/* Delete confirm + bulk-action bar at root so the table can unmount
          safely without losing modal state mid-action. Add / edit are
          dedicated routes (see /prefixes/new and /prefixes/$id/edit). */}
      <PrefixDeleteDialog
        prefix={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <PrefixBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </Tabs>
  )
}

// ─── Group header — VRF colour dot · name · RD · row count ──────────────

function renderVrfGroupHeader({
  value,
  count,
  sampleRow,
}: {
  value: unknown
  count: number
  sampleRow: Prefix
}) {
  const vrf = sampleRow.vrf
  const isGlobal = vrf === null
  return (
    <>
      <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
        VRF
      </span>
      <ColorBadge
        name={isGlobal ? "Global" : vrf!.name || String(value)}
        color={vrf?.color || undefined}
      />
      {vrf?.rd && (
        <span className="font-mono text-[10px] tracking-normal text-muted-foreground/80 normal-case">
          RD {vrf.rd}
        </span>
      )}
      <span className="ml-1 tracking-normal text-muted-foreground/70 normal-case">
        {count} {count === 1 ? "row" : "rows"}
      </span>
    </>
  )
}
