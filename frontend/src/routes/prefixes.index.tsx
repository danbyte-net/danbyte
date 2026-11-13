import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useEffect, useMemo, useState } from "react"
import { LayoutList } from "lucide-react"

import { api } from "@/lib/api"
import type { BulkStatusEntry, Paginated, Prefix } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { annotateNesting, contains, parseCidr } from "@/lib/prefix-tree"
import type { NestedPrefix } from "@/lib/prefix-tree"
import {
  blocksByParent,
  isFreeRow,
  layoutFreeRows,
  parseSize,
  scopeError,
} from "@/lib/prefix-free"
import type { FreeBlock, ListRow } from "@/lib/prefix-free"
import { createSearch } from "@/lib/prefix-free"
import { PrefixFreeRail, withFreeCells } from "@/components/prefix-free-rows"
import { cn } from "@/lib/utils"
import { PrefixPlanDialog } from "@/components/prefix-plan-dialog"
import type { FilterSnapshot } from "@/components/table-filters"
import { ColorBadge } from "@/components/cells/color-badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import {
  useUrlTableFilters,
  wireFacetColumns,
} from "@/components/table-filters"
import { useCustomFieldDefs } from "@/components/custom-field-display"
import { PrefixDeleteDialog } from "@/components/prefix-delete-dialog"
import { useViolationMap } from "@/components/compliance/violation-badge"
import { PrefixBulkBar } from "@/components/prefix-bulk-bar"
import { reportExport, useObjectReport } from "@/components/object-report"
import { useMe, objCan } from "@/lib/use-me"
import {
  decodeText,
  useListSearch,
  useSearchWriter,
  useUrlSearch,
} from "@/lib/url-filters"
import {
  AvailabilityFramePicker,
  useSlaStatus,
} from "@/components/monitoring/sla-status"
import { fetchPrefixStatuses } from "@/components/monitoring/bulk-status"
import { naturalCompare } from "@/lib/natural-sort"
import {
  RailModeSwitch,
  TreeOrFilterRail,
  WithinChip,
  narrowTreeRail,
  usePrefixTreeRail,
} from "@/components/prefix-tree-rail"

export const Route = createFileRoute("/prefixes/")({
  component: PrefixesPage,
  // `?status=<id>` / `?family=4|6` are the Status / Family facet params (the
  // rail keeps every filter in the URL), typed here for the dashboard
  // "Prefixes by status" and "Prefixes by family" links. Keys optional so a
  // plain /prefixes stays valid.
  validateSearch: (
    s: Record<string, unknown>
  ): { status?: string; family?: string } => {
    const out: { status?: string; family?: string } = {}
    if (typeof s.status === "string") out.status = s.status
    if (typeof s.family === "string") out.family = s.family
    return out
  },
})

// Stable empty fallback so `columns` (which depends on `monitoring`) keeps a
// constant identity while the status query loads - otherwise facets/filteredRows
// churn every render and DataTable's selection effect loops (see useTableFilters).
const EMPTY_MON: Record<string, BulkStatusEntry> = {}

// A list page with the free blocks of its parents (GET ?free=1).
type FreePage = Paginated<Prefix> & {
  free?: FreeBlock[]
  free_totals?: Record<string, number>
}

function PrefixesPage() {
  const { canDo } = useMe()
  const canAdd = canDo("prefix", "add")
  const navigate = useNavigate()
  const canEdit = canDo("prefix", "change")
  const canDelete = canDo("prefix", "delete")
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<Prefix | null>(null)
  const [selectedRows, setSelectedRows] = useState<Prefix[]>([])

  // Free space (lib/prefix-free): `?free=1`, a size (`size=29`), Next
  // available (`next=1`) and a scope (`scope=10.20.0.0/19`), all in the URL.
  const search = useListSearch()
  const writeSearch = useSearchWriter()
  const showFree = decodeText(search.free) === "1"
  const nextOnly = decodeText(search.next) === "1"
  const [sizeText, setSizeText] = useUrlSearch("size")
  const [scopeText, setScopeText] = useUrlSearch("scope")
  const sizeUrl = decodeText(search.size)
  const scopeUrl = decodeText(search.scope).trim()
  const size = showFree ? parseSize(sizeUrl) : null
  const scope = showFree && scopeUrl && !scopeError(scopeUrl) ? scopeUrl : ""
  const freeParams = useMemo<Record<string, string>>(
    () =>
      showFree
        ? {
            free: "1",
            ...(size !== null ? { length: String(size) } : {}),
            ...(scope ? { scope } : {}),
          }
        : {},
    [showFree, size, scope]
  )
  const setFlag = useCallback(
    (key: string, on: boolean) =>
      writeSearch((prev) => ({ ...prev, [key]: on ? "1" : undefined })),
    [writeSearch]
  )

  // The Filters / Tree rail; a tree selection (`?within=`) or, with the
  // tree open, its VRF narrows the list on the server.
  const treeRail = usePrefixTreeRail("prefixes")
  const scopeParams = treeRail.scopeParams
  const query = useQuery({
    queryKey: ["prefixes", q, freeParams, scopeParams],
    queryFn: () =>
      apiAll<Prefix>(
        `/api/prefixes/?${new URLSearchParams({ search: q, ...freeParams, ...scopeParams }).toString()}`,
        { join: ["free", "free_totals"] }
      ) as Promise<FreePage>,
    placeholderData: keepPreviousData,
  })
  const allRows = useMemo(() => query.data?.results ?? [], [query.data])

  // "+ N more free": the rest of one parent's blocks, fetched on demand.
  // Parents whose "+ N more free" row is open. View state, not a filter:
  // it resets with the free-space settings and is not worth a URL.
  const [expandedIds, setExpandedIds] = useState<readonly string[]>([])
  useEffect(() => setExpandedIds([]), [freeParams])
  const expanded = useMemo(() => new Set(expandedIds), [expandedIds])
  const extraQueries = useQueries({
    queries: expandedIds.map((id) => ({
      queryKey: ["prefix-available", id, freeParams],
      queryFn: () =>
        api<FreeBlock[]>(
          `/api/prefixes/available/?${new URLSearchParams({
            within: id,
            limit: "256",
            ...(freeParams.length ? { length: freeParams.length } : {}),
            ...(freeParams.scope ? { scope: freeParams.scope } : {}),
          }).toString()}`
        ),
    })),
  })
  const extraSig = extraQueries.map((x) => x.dataUpdatedAt).join(",")
  const freeBlocks = useMemo(() => {
    const map = blocksByParent(query.data?.free ?? [])
    expandedIds.forEach((id, i) => {
      const got = extraQueries[i]?.data
      if (got) map.set(id, got)
    })
    return map
    // extraSig stands in for the fetched blocks' identity.
  }, [query.data, expandedIds, extraSig])
  const freeTotals = useMemo(() => query.data?.free_totals ?? {}, [query.data])

  const cfQuery = useCustomFieldDefs("prefix")
  const cfDefs = useMemo(() => cfQuery.data?.results ?? [], [cfQuery.data])

  // Monitoring roll-up status for every listed prefix (separate query so the
  // api app stays decoupled from the monitoring app). Merged into the table
  // as a status column and into the rail as a facet - fetched for all rows,
  // not the filtered ones, so filtering on the rollup can't starve itself.
  const prefixIds = useMemo(() => allRows.map((r) => r.id), [allRows])
  const monQuery = useQuery({
    queryKey: ["prefix-mon-status", prefixIds],
    // POST - a page of UUIDs makes a URL longer than proxy request-line
    // limits (gunicorn 400s at ~110 ids), which blanked the whole column.
    // Batched to the server's bound (#430).
    queryFn: () => fetchPrefixStatuses(prefixIds),
    enabled: prefixIds.length > 0,
  })
  const monitoring = monQuery.data?.statuses ?? EMPTY_MON
  const sla = useSlaStatus("prefix", prefixIds)

  // The filter rail derives from the factory's facet metadata (status, VLAN,
  // site, VRF, utilisation, tags + one facet per tenant custom field), so a
  // new facetable column - or a new custom field - shows up automatically.
  // These facet-source columns are never rendered; the render columns below
  // add the interactive extras (selection, tag-chip wiring, actions).
  const facetColumns = useMemo<ColumnDef<Prefix>[]>(
    () =>
      buildPrefixColumns<Prefix>({
        omit: ["vrf"],
        cfDefs,
        monitoring,
        vrfGroupColumn: true,
      }),
    [cfDefs, monitoring]
  )
  // Sizes that fit somewhere on the page, and the parents a scope can be.
  const sizeSuggestions = useMemo(() => {
    const blocks = query.data?.free ?? []
    const out: string[] = []
    for (const fam of [4, 6] as const) {
      const lens = blocks
        .filter((b) => b.family === fam)
        .map((b) => b.prefixlen)
      if (!lens.length) continue
      const top = Math.min(...lens)
      const end = fam === 4 ? 32 : Math.max(64, top)
      for (let n = top; n <= Math.min(end, top + 12); n++) out.push(`/${n}`)
    }
    return [...new Set(out)]
  }, [query.data])
  const scopeSuggestions = useMemo(
    () =>
      allRows
        .filter((p) => (freeTotals[p.id] ?? 0) > 0)
        .slice(0, 50)
        .map((p) => p.cidr),
    [allRows, freeTotals]
  )
  const sizeError =
    sizeText.trim() && parseSize(sizeText) === null
      ? "A length, e.g. /29."
      : null
  const railExtras = (
    <>
      <RailModeSwitch mode={treeRail.mode} onChange={treeRail.setMode} />
      <PrefixFreeRail
        show={showFree}
        onShow={(v) =>
          writeSearch((prev) => ({
            ...prev,
            free: v ? "1" : undefined,
            ...(v
              ? {}
              : { size: undefined, next: undefined, scope: undefined }),
          }))
        }
        size={sizeText}
        onSize={setSizeText}
        sizeError={sizeError}
        sizes={sizeSuggestions}
        next={nextOnly}
        onNext={(v) => setFlag("next", v)}
        scope={scopeText}
        onScope={setScopeText}
        scopeError={scopeError(scopeText)}
        scopes={scopeSuggestions}
      />
    </>
  )
  const {
    rail,
    filteredRows,
    toggleValue,
    selectedValues,
    snapshot,
    restore,
    activeCount,
  } = useUrlTableFilters(facetColumns, allRows, { railExtras })
  const tagSelection = selectedValues("tags")

  // Saved views keep the free-space switches with the facets.
  const viewSnapshot = useCallback((): FilterSnapshot => {
    const out = snapshot()
    if (showFree) out.__free = "1"
    if (showFree && sizeUrl) out.__free_size = sizeUrl
    if (showFree && nextOnly) out.__free_next = "1"
    if (showFree && scopeUrl) out.__free_scope = scopeUrl
    return out
  }, [snapshot, showFree, sizeUrl, nextOnly, scopeUrl])
  const viewRestore = useCallback(
    (saved: FilterSnapshot | null | undefined) => {
      restore(saved)
      const text = (k: string) => {
        const v = saved?.[k]
        return typeof v === "string" ? v : undefined
      }
      writeSearch((prev) => ({
        ...prev,
        free: text("__free"),
        size: text("__free_size"),
        next: text("__free_next"),
        scope: text("__free_scope"),
      }))
    },
    [restore, writeSearch]
  )

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
      if (an !== bn) return naturalCompare(an, bn) // then VRF name
      // Don't re-sort by CIDR - annotateNesting already laid out a stable
      // depth-first parent→child order within each VRF.
      return 0
    })
  }, [filteredRows])

  // Free rows between the real ones; never selected, exported or counted.
  const listRows = useMemo<ListRow[]>(
    () =>
      showFree
        ? layoutFreeRows(rows, {
            blocks: freeBlocks,
            totals: freeTotals,
            expanded,
            collapsed: size !== null ? 16 : 8,
            sized: size !== null,
            nextOnly: size !== null && nextOnly,
          })
        : rows,
    [showFree, rows, freeBlocks, freeTotals, expanded, size, nextOnly]
  )
  const shownCount = useMemo(
    () => listRows.filter((r) => !isFreeRow(r)).length,
    [listRows]
  )

  // "Plan subnets…" in the toolbar when one parent is in scope: the most
  // specific listed parent holding the scope, else the only root row.
  const planTarget = useMemo<Prefix | null>(() => {
    if (!showFree) return null
    if (scope) {
      const s = parseCidr(scope)
      let best: { p: Prefix; len: number } | null = null
      for (const p of allRows) {
        const c = parseCidr(p.cidr)
        if (!s || !c) continue
        const same =
          c.family === s.family &&
          c.start === s.start &&
          c.prefixlen === s.prefixlen
        if (!same && !contains(c, s)) continue
        if (!best || c.prefixlen > best.len) best = { p, len: c.prefixlen }
      }
      return best?.p ?? null
    }
    const roots = rows.filter((r) => r._depth === 0)
    return roots.length === 1 && (freeTotals[roots[0].id] ?? 0) > 0
      ? roots[0]
      : null
  }, [showFree, scope, allRows, rows, freeTotals])
  const [planning, setPlanning] = useState(false)

  const violations = useViolationMap()
  // The PDF report of the rows the list shows now.
  const report = useObjectReport("prefix")
  const reportItem = reportExport(
    report.openReport,
    () => ({
      ids: rows.map((p) => p.id),
      filters: q ? { search: q } : undefined,
      scope: "filtered",
    }),
    rows.length === 0
  )

  const columns = useMemo<ColumnDef<ListRow>[]>(
    () =>
      withFreeCells(
        wireFacetColumns(
          buildPrefixColumns<ListRow>({
            // VRF renders as the group banner (hidden vrfName column), not a
            // per-row column.
            omit: ["vrf"],
            selection: true,
            nested: true,
            violations,
            monitoring,
            sla: { entries: sla.entries, frame: sla.frame },
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
          selectedValues,
          toggleValue
        ),
        {
          canAdd,
          onExpand: (id) =>
            setExpandedIds((prev) =>
              prev.includes(id) ? prev : [...prev, id]
            ),
        }
      ),
    [
      canAdd,
      tagSelection,
      selectedValues,
      toggleValue,
      cfDefs,
      monitoring,
      violations,
      canEdit,
      canDelete,
      sla.entries,
      sla.frame,
    ]
  )

  return (
    // The main prefixes page is just the prefix table. IPs live at their own
    // /ips list, and the space map is on each prefix's detail page.
    <>
      <ListPageShell
        title="Prefixes"
        count={query.data ? shownCount : undefined}
        /* Filter rail - derived from the columns' facet metadata - or the
           prefix tree. */
        rail={
          <TreeOrFilterRail
            rail={treeRail}
            filterRail={rail}
            activeFilters={activeCount}
          />
        }
        narrowRail={narrowTreeRail({
          rail: treeRail,
          filterRail: rail,
          activeFilters: activeCount,
        })}
        summary={treeRail.within ? <WithinChip rail={treeRail} /> : undefined}
        savedViews={{
          objectType: "prefix",
          filters: {
            snapshot: viewSnapshot,
            restore: viewRestore,
            activeCount,
          },
        }}
        search={{
          value: q,
          onChange: setQ,
          placeholder: "Filter by CIDR, description…",
        }}
        actions={
          <>
            <AvailabilityFramePicker
              value={sla.frame}
              onChange={sla.setFrame}
            />
            <TableActions ioType="prefix" extraExports={[reportItem]} />
            {canAdd && planTarget && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPlanning(true)}
              >
                <LayoutList className="h-3.5 w-3.5" /> Plan subnets…
              </Button>
            )}
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
          </>
        }
        query={query}
        page={query.data}
      >
        <DataTable
          data={listRows}
          columns={columns}
          groupBy="vrfName"
          renderGroupHeader={renderVrfGroupHeader}
          isPlaceholderRow={isFreeRow}
          onRowClick={(r) => {
            // A free block's whole row opens the form, like its Create.
            if (canAdd && r._free && r._free.kind !== "more")
              void navigate({ to: "/prefixes/new", search: createSearch(r) })
          }}
          rowClassName={(r) =>
            cn(
              r._free?.next && "bg-muted",
              canAdd && r._free && r._free.kind !== "more" && "cursor-pointer"
            )
          }
          onSelectedRowsChange={(picked) =>
            setSelectedRows(picked.filter((r) => !isFreeRow(r)))
          }
          initialColumnVisibility={{ vrfName: false }}
          tableId="prefixes"
        />
      </ListPageShell>

      {/* Delete confirm + bulk-action bar at root so the table can unmount
          safely without losing modal state mid-action. Add / edit are
          dedicated routes (see /prefixes/new and /prefixes/$id/edit). */}
      <PrefixDeleteDialog
        prefix={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      {report.dialog}
      {planning && planTarget && (
        <PrefixPlanDialog
          prefix={planTarget}
          scope={scope}
          onOpenChange={setPlanning}
        />
      )}
      <PrefixBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </>
  )
}

// ─── Group header - VRF colour dot · name · RD · row count ──────────────

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
        name={isGlobal ? "Global" : vrf.name || String(value)}
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
