import { createFileRoute } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import type {
  MacEntry,
  MacSightingPage,
  MacSightingRow,
  Paginated,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, selectionColumn } from "@/components/data-table"
import { buildMacColumns, learnedAtKey } from "@/components/columns/mac-columns"
import { useTableFilters } from "@/components/table-filters"
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
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { buildLearnedMacColumns } from "@/components/columns/learned-mac-columns"

interface MacList {
  count: number
  results: MacEntry[]
}

/** A list row keyed by its MAC, so a tick stays on the address it was put on. */
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
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/sites/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const devices = useQuery({
    queryKey: ["devices-picker", ...(site ? ["site", site] : [])],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
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
  return (
    <div>
      <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h3>
      {children}
    </div>
  )
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
  const [q, setQ] = useState("")
  const [adding, setAdding] = useState(false)
  const [ranges, setRanges] = useState(false)
  const [selected, setSelected] = useState<MacRow[]>([])

  const query = useQuery({
    queryKey: ["macs"],
    queryFn: () => api<MacList>("/api/macs/"),
  })

  const allRows = useMemo<MacRow[]>(
    () => (query.data?.results ?? []).map((m) => ({ ...m, id: m.mac })),
    [query.data]
  )
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return allRows
    return allRows.filter((m) => {
      if (m.mac.toLowerCase().includes(needle)) return true
      if (m.vendor?.name.toLowerCase().includes(needle)) return true
      if (
        m.interfaces.some(
          (i) =>
            i.name.toLowerCase().includes(needle) ||
            i.device.name.toLowerCase().includes(needle)
        )
      )
        return true
      if (
        m.vm_interfaces.some(
          (i) =>
            i.name.toLowerCase().includes(needle) ||
            i.vm.name.toLowerCase().includes(needle)
        )
      )
        return true
      if (m.objects.some((o) => o.description.toLowerCase().includes(needle)))
        return true
      if (learnedAtKey(m).toLowerCase().includes(needle)) return true
      return m.ips.some((ip) => ip.ip_address.toLowerCase().includes(needle))
    })
  }, [allRows, q])

  const columns = useMemo<ColumnDef<MacRow>[]>(
    () =>
      canRemove
        ? [selectionColumn<MacRow>(), ...buildMacColumns<MacRow>()]
        : buildMacColumns<MacRow>(),
    [canRemove]
  )
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="MAC addresses"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "macaddress",
        filters: { snapshot, restore, activeCount },
      }}
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
      query={query}
    >
      {/* The table stays mounted while a search or filter matches nothing,
          so rows filtered away leave the selection as on the other lists. */}
      {allRows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No MAC addresses yet - set a MAC on an interface, or pair one with an
          IP, and it shows up here.
        </p>
      ) : (
        <DataTable
          data={filteredRows}
          columns={wiredColumns}
          onSelectedRowsChange={canRemove ? setSelected : undefined}
          selectedRows={selected}
          flexColumn="description"
          tableId="macs"
        />
      )}
      <MacBulkBar
        selected={allRows.length ? selected : []}
        onCleared={() => setSelected([])}
      />
      <MacObjectDialog open={adding} onOpenChange={setAdding} />
      <OuiRangesDialog open={ranges} onOpenChange={setRanges} />
    </ListPageShell>
  )
}
