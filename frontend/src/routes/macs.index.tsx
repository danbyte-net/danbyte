import { createFileRoute } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useId, useMemo, useState } from "react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { MacEntry, MacSightingPage, MacSightingRow } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, selectionColumn } from "@/components/data-table"
import { buildMacColumns } from "@/components/columns/mac-columns"
import { wireFacetColumns } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { MacBulkBar } from "@/components/mac-bulk-bar"
import { MacObjectDialog } from "@/components/mac-object-dialog"
import { OuiRangesDialog } from "@/components/oui-ranges-dialog"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import {
  useUrlEnum,
  useUrlInt,
  useUrlPatch,
  useUrlText,
} from "@/lib/use-url-state"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { FilterRail } from "@/components/filter-rail"
import { EmptyState } from "@/components/empty-state"
import { Combobox } from "@/components/ui/combobox"
import { CaptionControl } from "@/components/ui/field-control"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { buildLearnedMacColumns } from "@/components/columns/learned-mac-columns"
import { useUrlSearch } from "@/lib/url-filters"
import { useServerList } from "@/lib/server-list"

/** A list row keyed by its MAC (the server's `id`, trimmed and lower case),
 * so a tick stays on the address it was put on. */
type MacRow = MacEntry & { id: string }

/** The list's URL: the tab, and the Learned tab's filters and page - declared
 * so they survive Back. */
interface MacsSearch {
  tab?: string
  q?: string
  site?: string
  device?: string
  vlan?: string
  state?: string
  page?: number
}

export const Route = createFileRoute("/macs/")({
  validateSearch: (s: Record<string, unknown>): MacsSearch => {
    const out: MacsSearch = {}
    for (const k of ["tab", "q", "site", "device", "vlan", "state"] as const)
      if (typeof s[k] === "string" && s[k]) out[k] = s[k]
    const page = Number(s.page)
    if (Number.isFinite(page) && page > 1) out.page = Math.round(page)
    return out
  },
  component: MacsPage,
})

const TABS = ["recorded", "learned"] as const

/** Recorded: the MACs Danbyte records - interfaces, IPs, MAC objects.
 * Learned (#284): the network's MAC table, one row per MAC where it sits. */
function MacsPage() {
  const [tab, setTab] = useUrlTab<(typeof TABS)[number]>(
    "recorded",
    "tab",
    TABS
  )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 lg:px-6">
        <SegmentedTabs
          value={tab}
          onValueChange={setTab}
          items={[
            { value: "recorded", label: "Recorded" },
            { value: "learned", label: "Learned" },
          ]}
        />
      </div>
      {tab === "learned" ? <LearnedMacs /> : <RecordedMacs />}
    </div>
  )
}

const LEARNED_PAGE = 50
const STATES = ["present", "gone", "all"] as const
const STATE_LABEL: Record<(typeof STATES)[number], string> = {
  present: "Present",
  gone: "Gone",
  all: "All",
}

/** The Learned columns - State only where rows can differ in it. */
function learnedColumns(withState: boolean) {
  return buildLearnedMacColumns<MacSightingRow>({
    include: [
      "mac",
      "vendor",
      "device",
      "port",
      "vlan",
      "ip",
      "name",
      "first_seen",
      "last_seen",
      ...(withState ? (["state"] as const) : []),
    ],
    // Server-paged, ordered by MAC: sorting one page would mislead.
    sortable: false,
  })
}

/** The network-wide learned MAC table, filtered and paged on the server. */
function LearnedMacs() {
  const patch = useUrlPatch()
  const [q] = useUrlText("q", "", { replace: true })
  const [site] = useUrlText("site")
  const [device] = useUrlText("device")
  const [vlan] = useUrlText("vlan", "", { replace: true })
  const [state] = useUrlEnum("state", "present", STATES)
  const [page, setPage] = useUrlInt("page", 1, { min: 1 })
  // A filter change starts over at page 1 - one navigation for both.
  const filter = (
    values: Record<string, string | undefined>,
    replace = false
  ) => patch({ ...values, page: undefined }, { replace })

  const filters = new URLSearchParams()
  if (q.trim()) filters.set("q", q.trim())
  if (site) filters.set("site", site)
  if (device) filters.set("device", device)
  if (/^\d{1,4}$/.test(vlan)) filters.set("vlan", vlan)
  if (state !== "present") filters.set("state", state)
  const pageUrl = (n: number, size: number) => {
    const p = new URLSearchParams(filters)
    p.set("page", String(n))
    p.set("page_size", String(size))
    return `/api/monitoring/mac-sightings/?${p}`
  }
  const query = useQuery({
    queryKey: ["mac-sightings", filters.toString(), page],
    queryFn: () => api<MacSightingPage>(pageUrl(page, LEARNED_PAGE)),
    placeholderData: keepPreviousData,
  })
  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => apiAll<{ id: string; name: string }>("/api/sites/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const devices = useQuery({
    queryKey: ["devices-picker", ...(site ? ["site", site] : [])],
    queryFn: () =>
      apiAll<{ id: string; name: string }>(
        `/api/devices/?picker=1${site ? `&site=${site}` : ""}`
      ),
    staleTime: 5 * 60_000,
  })
  const rows = query.data?.results ?? []
  const filtered = !!(q.trim() || site || device || vlan || state !== "present")
  const columns = useMemo(() => learnedColumns(state !== "present"), [state])

  return (
    <ListPageShell
      title="MAC addresses"
      count={query.data?.count}
      rail={
        <FilterRail>
          <RailFilter label="Site">
            <Combobox
              value={site || null}
              onChange={(v) =>
                filter({ site: v ?? undefined, device: undefined })
              }
              options={(sites.data?.results ?? []).map((s) => ({
                value: s.id,
                label: s.name,
              }))}
              noneLabel="All sites"
              placeholder="All sites"
              searchPlaceholder="Search sites…"
              emptyText="No sites."
              className="h-8 text-xs"
            />
          </RailFilter>
          <RailFilter label="Device">
            <Combobox
              value={device || null}
              onChange={(v) => filter({ device: v ?? undefined })}
              options={(devices.data?.results ?? []).map((d) => ({
                value: d.id,
                label: d.name,
              }))}
              noneLabel="All devices"
              placeholder="All devices"
              searchPlaceholder="Search devices…"
              emptyText="No devices."
              className="h-8 text-xs"
            />
          </RailFilter>
          <RailFilter label="VLAN">
            <Input
              type="number"
              min={1}
              max={4094}
              value={vlan}
              onChange={(e) =>
                filter({ vlan: e.target.value || undefined }, true)
              }
              placeholder="Any VID"
              className="h-8 text-xs"
            />
          </RailFilter>
          <RailFilter label="State">
            <Select
              value={state}
              onValueChange={(v) =>
                filter({ state: v === "present" ? undefined : v })
              }
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATES.map((st) => (
                  <SelectItem key={st} value={st}>
                    {STATE_LABEL[st]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </RailFilter>
        </FilterRail>
      }
      search={{
        value: q,
        onChange: (v) => filter({ q: v || undefined }, true),
        placeholder: "MAC in any notation, device, port…",
      }}
      query={query}
    >
      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No learned MACs match." : "No learned MACs yet."}
        />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="name"
          serverPagination={{
            page,
            pageCount: query.data?.num_pages ?? 1,
            totalRows: query.data?.count ?? rows.length,
            onPageChange: setPage,
          }}
          // The table holds one page; a download takes every match.
          exportAll={async () => {
            const all: MacSightingRow[] = []
            for (let n = 1; n <= 40; n++) {
              const r = await api<MacSightingPage>(pageUrl(n, 500))
              all.push(...r.results)
              if (n >= r.num_pages) break
            }
            return all
          }}
          exportName="learned-macs"
          exportTitle="Learned MACs"
        />
      )}
    </ListPageShell>
  )
}

function RailFilter({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  // The heading names the picker under it (#461).
  const labelId = useId()
  return (
    <div>
      <h3
        id={labelId}
        className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {label}
      </h3>
      <CaptionControl labelId={labelId}>{children}</CaptionControl>
    </div>
  )
}

/** The recorded MAC list's facets, counted and filtered by the server
 * (`/api/macs/facets/`, #527). */
const MAC_FACETS = [
  "vendor",
  "location",
  "interfaces",
  "ips",
  "tags",
  "description",
]

/** The stored summary behind the list: still building after an upgrade, or
 * catching up with recent writes. */
interface MacListSummary {
  building: boolean
  updating: boolean
}

function RecordedMacs() {
  const { canDo } = useMe()
  const canAdd = canDo("macaddress", "add")
  // Any one of the removal grants is enough to offer the selection; the
  // dialog shows which parts this user may act on.
  const canRemove =
    canDo("macaddress", "delete") ||
    canDo("interface", "change") ||
    canDo("vminterface", "change") ||
    canDo("ipaddress", "change")
  const [q, setQ] = useUrlSearch()
  const [adding, setAdding] = useState(false)
  const [ranges, setRanges] = useState(false)
  const [selected, setSelected] = useState<MacRow[]>([])

  // One page at a time from the server, searched, sorted and counted there.
  const facetColumns = useMemo(() => buildMacColumns<MacRow>(), [])
  const list = useServerList<MacRow>({
    endpoint: "/api/macs/",
    queryKey: "macs",
    columns: facetColumns,
    facets: MAC_FACETS,
    savedViews: "macaddress",
  })
  const { selectedValues, toggleValue } = list
  const columns = useMemo<ColumnDef<MacRow>[]>(
    () =>
      wireFacetColumns(
        canRemove
          ? [selectionColumn<MacRow>(), ...buildMacColumns<MacRow>()]
          : buildMacColumns<MacRow>(),
        selectedValues,
        toggleValue
      ),
    [canRemove, selectedValues, toggleValue]
  )
  const summary = (list.query.data as { summary?: MacListSummary } | undefined)
    ?.summary
  // A row ticked by "Select all" on another page is only its id - its MAC.
  const picked = useMemo(
    () => selected.map((r) => (r.mac ? r : { ...r, mac: r.id })),
    [selected]
  )
  const empty =
    !!list.query.data && list.total === 0 && !list.search && !list.activeCount

  return (
    <ListPageShell
      title="MAC addresses"
      count={list.query.data ? list.total : undefined}
      rail={list.rail}
      savedViews={list.savedViews}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by MAC, device, interface, IP…",
      }}
      actions={
        <>
          <TableActions ioType="macaddress" />
          <Button size="sm" variant="outline" onClick={() => setRanges(true)}>
            Vendor ranges
          </Button>
          {canAdd && (
            <Button size="sm" onClick={() => setAdding(true)}>
              Add MAC
            </Button>
          )}
        </>
      }
      summary={
        summary?.building && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="warning">Building</Badge>
            The list is still being built - some MACs are not in it yet.
          </p>
        )
      }
      query={list.query}
    >
      {/* The table stays mounted while a search or filter matches nothing,
          so rows filtered away leave the selection as on the other lists. */}
      {empty ? (
        <p className="text-sm text-muted-foreground">
          No MAC addresses yet - set a MAC on an interface, or pair one with an
          IP, and it shows up here.
        </p>
      ) : (
        <DataTable
          data={list.rows}
          columns={columns}
          {...list.tableProps}
          onSelectedRowsChange={canRemove ? setSelected : undefined}
          selectedRows={selected}
          flexColumn="description"
          tableId="macs"
          exportName="macs"
          exportTitle="MAC addresses"
        />
      )}
      <MacBulkBar
        selected={empty ? [] : picked}
        onCleared={() => setSelected([])}
      />
      <MacObjectDialog open={adding} onOpenChange={setAdding} />
      <OuiRangesDialog open={ranges} onOpenChange={setRanges} />
    </ListPageShell>
  )
}
