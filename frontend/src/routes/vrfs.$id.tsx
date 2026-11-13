import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import {
  CustomFieldValues,
  useCustomFieldDefs,
} from "@/components/custom-field-display"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { CopyPlus, Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import type { ReactNode } from "react"

import {
  api,
  type Paginated,
  type Prefix,
  type VLAN,
  type VRF,
} from "@/lib/api"
import type { IPAddress } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { listCap, listCapCount } from "@/lib/list-cap"
import { TagList } from "@/components/cells/tag-list"
import { ColorBadge } from "@/components/cells/color-badge"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { Button } from "@/components/ui/button"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { DataTable } from "@/components/data-table"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { Loading } from "@/components/loading"
import { NarrowRailSheet } from "@/components/narrow-rail-sheet"
import {
  RailModeSwitch,
  TreeOrFilterRail,
  WithinChip,
  narrowTreeRail,
  usePrefixTreeRail,
} from "@/components/prefix-tree-rail"
import type { PrefixTreeRail } from "@/components/prefix-tree-rail"
import { useTableFilters, wireFacetColumns } from "@/components/table-filters"
import { buildVlanColumns } from "@/components/columns/vlan-columns"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { VrfDeleteDialog } from "@/components/vrf-delete-dialog"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import {
  EmbeddedBGPSessionTable,
  EmbeddedStaticRouteTable,
} from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/vrfs/$id")({ component: VrfDetail })

function VrfDetail() {
  const { id } = Route.useParams()
  const vrf = useQuery({
    queryKey: ["vrf", id],
    queryFn: () => api<VRF>(`/api/vrfs/${id}/`),
  })
  if (vrf.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (vrf.isError)
    return (
      <div className="p-6">
        <QueryError error={vrf.error} />
      </div>
    )
  if (!vrf.data) return null
  return <VrfDetailBody vrf={vrf.data} />
}

function VrfDetailBody({ vrf: v }: { vrf: VRF }) {
  const [tab, setTab] = useUrlTab<
    | "overview"
    | "prefixes"
    | "ips"
    | "vlans"
    | "bgp-sessions"
    | "static-routes"
    | "journal"
    | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const canEdit = canDo("vrf", "change")
  const canDelete = canDo("vrf", "delete")
  const [deleting, setDeleting] = useState<VRF | null>(null)
  const openDelete = useCallback(() => setDeleting(v), [v])
  const closeDelete = useCallback((o: boolean) => {
    if (!o) setDeleting(null)
  }, [])
  const goBack = useCallback(() => nav({ to: "/vrfs" }), [nav])
  // The Prefixes and IPs tabs' Filters / Tree rail: this VRF's prefix
  // tree. A selected node (`?within=`) scopes both tabs to it.
  const tree = usePrefixTreeRail("vrf-detail", {
    vrf: v.id,
    active: tab === "prefixes" || tab === "ips",
  })

  return (
    <DetailShell
      backTo="/vrfs"
      backLabel="VRFs"
      title={v.name}
      presence={{ type: "vrf", id: v.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/vrfs/$id/edit" params={{ id: v.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("vrf", "add") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/vrfs/new" search={{ clone: v.id }}>
                <CopyPlus className="h-3.5 w-3.5" /> Clone
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={openDelete}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={
            <ColorBadge
              name={v.name}
              color={v.color || undefined}
              className="h-7 px-3 text-sm"
            />
          }
          badges={
            <>
              {v.rd && (
                <span className="font-mono text-sm text-muted-foreground">
                  RD {v.rd}
                </span>
              )}
              <ViolationBadge objectId={v.id} prominent />
            </>
          }
          tags={v.tags.length > 0 && <TagList tags={v.tags} listTo="/vrfs" />}
          description={v.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "prefixes", label: "Prefixes", count: v.prefix_count },
        { value: "ips", label: "IPs", count: v.ip_count },
        { value: "vlans", label: "VLANs", count: v.vlan_count },
        {
          value: "bgp-sessions",
          label: "BGP sessions",
          count: v.bgp_session_count,
        },
        {
          value: "static-routes",
          label: "Static routes",
          count: v.static_route_count,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <VrfOverview vrf={v} humanIds={humanIds} />
      </DetailTab>
      <DetailTab value="prefixes" bare>
        <VrfPrefixesPane vrfId={v.id} tree={tree} />
      </DetailTab>
      <DetailTab value="ips" bare>
        <VrfIpsPane vrfId={v.id} tree={tree} />
      </DetailTab>
      <DetailTab value="vlans">
        <VrfVlansTable vrfId={v.id} />
      </DetailTab>
      <DetailTab value="bgp-sessions">
        <EmbeddedBGPSessionTable
          filter={{ vrf: v.id }}
          omit={["vrf"]}
          emptyText="No BGP session in this VRF."
        />
      </DetailTab>
      <DetailTab value="static-routes">
        <EmbeddedStaticRouteTable
          filter={{ vrf: v.id }}
          omit={["vrf"]}
          emptyText="No static route in this VRF."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.vrf" objectId={v.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.vrf" objectId={v.id} />
      </DetailTab>

      <VrfDeleteDialog
        vrf={deleting}
        onOpenChange={closeDelete}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function rtValue(rts: { id: string; name: string }[]): React.ReactNode {
  if (rts.length === 0) return dash
  return (
    <div className="flex flex-wrap items-center gap-1">
      {rts.map((rt) => (
        <Link
          key={rt.id}
          to="/route-targets/$id"
          params={{ id: rt.id }}
          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:bg-muted/80"
        >
          {rt.name}
        </Link>
      ))}
    </div>
  )
}

/** VRF attributes that used to crowd the header, grouped into tables. */
function VrfOverview({ vrf: v, humanIds }: { vrf: VRF; humanIds: boolean }) {
  const attributes: KvRow[] = [
    ...(humanIds && v.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{v.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Route distinguisher",
      value: v.rd ? (
        <span className="font-mono text-[13px]">{v.rd}</span>
      ) : (
        dash
      ),
      copy: v.rd || undefined,
    },
    { label: "Prefixes", value: <span className="num">{v.prefix_count}</span> },
    { label: "IPs", value: <span className="num">{v.ip_count}</span> },
    { label: "Enforce unique", value: v.enforce_unique ? "Yes" : "No" },
  ]
  const routeTargets: KvRow[] = [
    { label: "Import targets", value: rtValue(v.import_targets) },
    { label: "Export targets", value: rtValue(v.export_targets) },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Attributes" rows={attributes} />
      <KvCard title="Route targets" rows={routeTargets} />
      <CustomFieldValues model="vrf" values={v.custom_fields} layout="cards" />
    </div>
  )
}

function VrfVlansTable({ vrfId }: { vrfId: string }) {
  const q = useQuery({
    queryKey: ["vrf-vlans", vrfId],
    queryFn: () =>
      api<Paginated<VLAN>>(`/api/vlans/?vrf=${vrfId}&page_size=500`),
  })
  const columns = useMemo<ColumnDef<VLAN>[]>(
    () => buildVlanColumns({ omit: ["vrf"] }),
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading VLANs…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0) {
    return (
      <EmptyState title="No VLANs yet.">
        No VLAN names this VRF as the table its SVI lives in.
      </EmptyState>
    )
  }
  return (
    <DataTable
      data={rows}
      total={q.data?.count}
      columns={columns}
      flexColumn="description"
      tableId="vlan-embedded"
      searchable
      searchPlaceholder="Search VLANs…"
    />
  )
}

/** A VRF tab with the tree rail: the rail (or its narrow sheet), the row
 * count and the selection's chip over the table. */
function TreeTab({
  tree,
  filterRail,
  activeFilters,
  count,
  children,
}: {
  tree: PrefixTreeRail
  filterRail: ReactNode
  activeFilters: number
  count: ReactNode
  children: ReactNode
}) {
  const narrow = narrowTreeRail({ rail: tree, filterRail, activeFilters })
  return (
    <>
      <TreeOrFilterRail
        rail={tree}
        filterRail={filterRail}
        activeFilters={activeFilters}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <NarrowRailSheet rail={narrow} className="h-7" />
          <span className="num text-[11px] whitespace-nowrap text-muted-foreground">
            {count}
          </span>
          {tree.within && <WithinChip rail={tree} />}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
          {children}
        </div>
      </div>
    </>
  )
}

/** "12 rows", or "12 of 40,000" when the list ran past what was loaded. */
function rowCount(
  shown: number,
  page: { count?: number; results?: unknown[] } | undefined
) {
  const cap = listCap(page)
  if (cap) return listCapCount(shown, cap)
  return `${shown} row${shown === 1 ? "" : "s"}`
}

/** A list's rows in this VRF, scoped on the server: `vrf=`, and the tree's
 * selection as `within=`. */
function vrfListUrl(endpoint: string, vrfId: string, within: string | null) {
  const p = new URLSearchParams({ vrf: vrfId })
  if (within) p.set("within", within)
  return `${endpoint}?${p}`
}

function VrfPrefixesPane({
  vrfId,
  tree,
}: {
  vrfId: string
  tree: PrefixTreeRail
}) {
  const within = tree.scoped
  const q = useQuery({
    queryKey: ["vrf-prefixes", vrfId, within],
    queryFn: () => apiAll<Prefix>(vrfListUrl("/api/prefixes/", vrfId, within)),
  })
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const cfQuery = useCustomFieldDefs("prefix")
  const cfDefs = useMemo(() => cfQuery.data?.results ?? [], [cfQuery.data])
  // The /prefixes list's facets, less VRF: it is this one.
  const facetColumns = useMemo<ColumnDef<Prefix>[]>(
    () => buildPrefixColumns<Prefix>({ omit: ["vrf"], cfDefs }),
    [cfDefs]
  )
  const { rail, filteredRows, toggleValue, selectedValues, activeCount } =
    useTableFilters(facetColumns, rows, undefined, {
      railExtras: <RailModeSwitch mode={tree.mode} onChange={tree.setMode} />,
    })
  const tagSelection = selectedValues("tags")
  const columns = useMemo<ColumnDef<Prefix>[]>(
    () =>
      wireFacetColumns(
        buildPrefixColumns<Prefix>({
          omit: ["vrf"],
          cfDefs,
          tagFilter: {
            activeSlugs: tagSelection,
            onToggle: (slug) => toggleValue("tags", slug),
          },
        }),
        selectedValues,
        toggleValue
      ),
    [cfDefs, tagSelection, selectedValues, toggleValue]
  )

  return (
    <TreeTab
      tree={tree}
      filterRail={rail}
      activeFilters={activeCount}
      count={rowCount(filteredRows.length, q.data)}
    >
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : rows.length === 0 && !within ? (
        <EmptyState title="No prefixes yet.">
          No prefixes are tied to this VRF.
        </EmptyState>
      ) : (
        <DataTable
          data={filteredRows}
          columns={columns}
          flexColumn="description"
          tableId="prefix-embedded"
          searchable
          searchPlaceholder="Search prefixes…"
        />
      )}
    </TreeTab>
  )
}

function VrfIpsPane({ vrfId, tree }: { vrfId: string; tree: PrefixTreeRail }) {
  const within = tree.scoped
  const q = useQuery({
    queryKey: ["vrf-ips", vrfId, within],
    queryFn: () => apiAll<IPAddress>(vrfListUrl("/api/ips/", vrfId, within)),
  })
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  // The /ips list's facets.
  const facetColumns = useMemo<ColumnDef<IPAddress>[]>(
    () => buildIpColumns<IPAddress>(),
    []
  )
  const { rail, filteredRows, toggleValue, selectedValues, activeCount } =
    useTableFilters(facetColumns, rows, undefined, {
      railExtras: <RailModeSwitch mode={tree.mode} onChange={tree.setMode} />,
    })
  const columns = useMemo<ColumnDef<IPAddress>[]>(
    () =>
      wireFacetColumns(
        buildIpColumns<IPAddress>({
          include: ["ip", "status", "dhcp", "dns", "assigned"],
          copyButton: true,
        }),
        selectedValues,
        toggleValue
      ),
    [selectedValues, toggleValue]
  )

  return (
    <TreeTab
      tree={tree}
      filterRail={rail}
      activeFilters={activeCount}
      count={rowCount(filteredRows.length, q.data)}
    >
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : rows.length === 0 && !within ? (
        <EmptyState title="No IP addresses." />
      ) : (
        <DataTable
          data={filteredRows}
          columns={columns}
          flexColumn="dns"
          tableId="ip-embedded"
          searchable
          searchPlaceholder="Search IP addresses…"
        />
      )}
    </TreeTab>
  )
}
