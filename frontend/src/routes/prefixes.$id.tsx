import { useCallback, useMemo, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { ChevronRight, CopyPlus, Pencil, Plus, Search } from "lucide-react"

import {
  api,
  type IPAddress,
  type IPListResponse,
  type Paginated,
  type Prefix,
  type SpaceMap as SpaceMapData,
  type SubnetDetailRow,
} from "@/lib/api"
import { CopyButton, KvCard, dash, type KvRow } from "@/components/kv-card"
import {
  annotateNesting,
  contains,
  parseCidr,
  type NestedPrefix,
} from "@/lib/prefix-tree"
import { StatusBadge } from "@/components/status-badge"
import { QueryError } from "@/components/query-error"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { TagList } from "@/components/cells/tag-list"
import { VrfCell } from "@/components/cells/vrf-cell"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { SpaceMap } from "@/components/space-map"
import { PrefixIpsTable } from "@/components/prefix-ips-table"
import { PrefixMonitoring } from "@/components/monitoring/prefix-monitoring"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import {
  formatCustomValue,
  hasCustomValue,
  useCustomFieldDefs,
} from "@/components/custom-field-display"
import { useTableFilters } from "@/components/table-filters"
import { IpFilterRail } from "@/components/ip-filter-rail"
import { PrefixDeleteDialog } from "@/components/prefix-delete-dialog"
import {
  AutoDiscoverButton,
  PrefixScanGroup,
} from "@/components/monitoring/auto-discover-button"
import { PrefixBulkBar } from "@/components/prefix-bulk-bar"
import { IpDeleteDialog } from "@/components/ip-delete-dialog"
import { IpBulkBar } from "@/components/ip-bulk-bar"
import { DataTable } from "@/components/data-table"
import { useMe, objCan } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export const Route = createFileRoute("/prefixes/$id")({
  component: PrefixDetail,
})

function PrefixDetail() {
  const { id } = Route.useParams()
  const prefix = useQuery({
    queryKey: ["prefix", id],
    queryFn: () => api<Prefix>(`/api/prefixes/${id}/`),
  })

  if (prefix.isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  }
  if (prefix.isError || !prefix.data) {
    return (
      <div className="p-6">
        <QueryError error={prefix.error} />
      </div>
    )
  }
  return <PrefixDetailBody prefix={prefix.data} />
}

function PrefixDetailBody({ prefix: p }: { prefix: Prefix }) {
  const nav = useNavigate()
  // Gate write actions to the user's RBAC grants so we never offer a button
  // that would only 403 on submit. Edit/Delete use the object's constraint-aware
  // per-object flag (`p.permissions`) when present, falling back to the
  // type-level grant; add/create has no object yet, so it stays type-level.
  const { canDo, humanIds } = useMe()
  const canEditPrefix = objCan(p, "change", canDo("prefix", "change"))
  const canAddPrefix = canDo("prefix", "add")
  const canDeletePrefix = objCan(p, "delete", canDo("prefix", "delete"))
  const canAddIp = canDo("ipaddress", "add")
  const [tab, setTab] = useState<
    | "overview"
    | "ips"
    | "children"
    | "map"
    | "monitoring"
    | "journal"
    | "history"
  >("overview")

  // Prefix-level delete confirm.
  const [deletePrefix, setDeletePrefix] = useState<Prefix | null>(null)

  // IP-level delete confirm.
  const [deletingIp, setDeletingIp] = useState<IPAddress | null>(null)
  const [selectedIps, setSelectedIps] = useState<IPAddress[]>([])

  // IP filter state.
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set())
  const [roleFilter, setRoleFilter] = useState<Set<string>>(new Set())
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [showAvailable, setShowAvailable] = useState(false)

  // Children filters/selection.
  const [selectedChildren, setSelectedChildren] = useState<Prefix[]>([])
  const [deletingChild, setDeletingChild] = useState<Prefix | null>(null)

  const ipsQuery = useQuery({
    queryKey: ["prefix-ips", p.id],
    queryFn: () => api<IPListResponse>(`/api/prefixes/${p.id}/ips/`),
  })
  const ipRows = ipsQuery.data?.results ?? []

  // Enumerable = small enough to list every host (any family; the backend caps
  // it). A /64 isn't, so it shows the subnet map instead.
  const canShowAvailable =
    p.is_enumerable && p.status?.name !== "container" && !p.has_descendants

  // Open the IP create page pre-seeded with `address` from the
  // "next available" picker. We pass `prefix=` so the create page can
  // scope its VRF/site defaults.
  const openAddIpAt = useCallback(
    (address = "") => {
      nav({
        to: "/ips/new",
        search: { address: address || undefined, prefix: p.id },
      })
    },
    [nav, p.id]
  )

  const handleEditIp = useCallback(
    (ip: IPAddress) => nav({ to: "/ips/$id/edit", params: { id: ip.id } }),
    [nav]
  )
  const handleDeleteIp = useCallback((ip: IPAddress) => setDeletingIp(ip), [])
  const handleEditChild = useCallback(
    (cp: Prefix) => nav({ to: "/prefixes/$id/edit", params: { id: cp.id } }),
    [nav]
  )
  const handleDeleteChild = useCallback(
    (cp: Prefix) => setDeletingChild(cp),
    []
  )

  const toggleStatus = useCallback(
    (v: string) => toggle(statusFilter, v, setStatusFilter),
    [statusFilter]
  )
  const toggleRole = useCallback(
    (v: string) => toggle(roleFilter, v, setRoleFilter),
    [roleFilter]
  )
  const toggleTag = useCallback(
    (v: string) => toggle(tagFilter, v, setTagFilter),
    [tagFilter]
  )

  const closeDeletePrefix = useCallback((o: boolean) => {
    if (!o) setDeletePrefix(null)
  }, [])
  const closeDeleteChild = useCallback((o: boolean) => {
    if (!o) setDeletingChild(null)
  }, [])
  const closeDeleteIp = useCallback((o: boolean) => {
    if (!o) setDeletingIp(null)
  }, [])
  const clearSelectedIps = useCallback(() => setSelectedIps([]), [])
  const clearSelectedChildren = useCallback(() => setSelectedChildren([]), [])

  const goBackOnPrefixDelete = useCallback(
    () => nav({ to: "/prefixes" }),
    [nav]
  )

  const ipsReturnPath = `/prefixes/${p.id}`

  return (
    <DetailShell
      backTo="/prefixes"
      backLabel="Prefixes"
      title={
        <>
          <span className="font-mono">{p.cidr}</span>
          {p.vrf && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              · VRF {p.vrf.name}
            </span>
          )}
        </>
      }
      presence={{ type: "prefix", id: p.id }}
      actions={
        <>
          <AutoDiscoverButton prefixId={p.id} initial={p.auto_discover} />
          <PrefixScanGroup prefixId={p.id} />
          {canEditPrefix && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/prefixes/$id/edit" params={{ id: p.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canAddPrefix && (
            <Button variant="outline" size="sm" asChild>
              <Link
                to="/prefixes/new"
                search={{
                  cidr: undefined,
                  vrf: undefined,
                  site: undefined,
                  location: undefined,
                  clone: p.id,
                }}
              >
                <CopyPlus className="h-3.5 w-3.5" /> Clone
              </Link>
            </Button>
          )}
          {canAddPrefix && (
            <Button variant="outline" size="sm" asChild>
              <Link
                to="/prefixes/new"
                search={{
                  cidr: undefined,
                  vrf: p.vrf?.id,
                  site: undefined,
                  location: undefined,
                }}
              >
                <Plus className="h-3.5 w-3.5" /> Add child prefix
              </Link>
            </Button>
          )}
          {canAddIp && (
            <Button size="sm" asChild>
              <Link to="/ips/new" search={{ address: undefined, prefix: p.id }}>
                <Plus className="h-3.5 w-3.5" /> Add IP
              </Link>
            </Button>
          )}
          {canDeletePrefix && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeletePrefix(p)}
            >
              Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <div className="font-mono text-3xl font-semibold tracking-tight">
                  {p.cidr}
                </div>
                <ViolationBadge objectId={p.id} prominent />
                <VrfCell vrf={p.vrf} showRd />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge status={p.status} />
                {/* The VLAN's security zone — network context worth surfacing
                    at the same glance level as status/tags. */}
                {p.vlan?.zone && (
                  <ColorBadge
                    name={p.vlan.zone.name}
                    color={p.vlan.zone.color || undefined}
                  />
                )}
                {p.tags.length > 0 && <TagList tags={p.tags} />}
              </div>
              {p.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {p.description}
                </p>
              )}
            </div>

            <dl className="ml-auto grid grid-cols-1 gap-y-3 text-[13px]">
              <Stat
                label="Utilisation"
                value={<UtilPct pct={p.utilisation_pct} />}
              />
            </dl>
          </section>

          <MastersStrip prefix={p} />

          <SubnetDetailsStrip prefix={p} onOpenAddIp={openAddIpAt} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "ips", label: "IPs", count: p.ip_count },
        {
          value: "children",
          label: "Child prefixes",
          count: p.child_count,
        },
        { value: "map", label: "Map" },
        { value: "monitoring", label: "Monitoring" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <PrefixOverview prefix={p} humanIds={humanIds} />
      </DetailTab>

      <DetailTab value="ips" bare>
        <IpFilterRail
          rows={ipRows}
          statusFilter={statusFilter}
          roleFilter={roleFilter}
          tagFilter={tagFilter}
          onToggleStatus={toggleStatus}
          onToggleRole={toggleRole}
          onToggleTag={toggleTag}
          showAvailable={showAvailable}
          onToggleShowAvailable={setShowAvailable}
          canShowAvailable={canShowAvailable}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
            <span className="num text-[11px] text-muted-foreground">
              {ipRows.length} row{ipRows.length === 1 ? "" : "s"}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter IPs…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 w-64 pl-8 text-xs"
                />
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <PrefixIpsTable
              prefixId={p.id}
              statusFilter={statusFilter}
              roleFilter={roleFilter}
              tagFilter={tagFilter}
              onToggleTag={toggleTag}
              search={search}
              showAvailable={showAvailable}
              cidr={p.cidr}
              hasDescendants={p.has_descendants}
              onEdit={handleEditIp}
              onDelete={handleDeleteIp}
              onCreateAt={openAddIpAt}
              onSelectedRowsChange={setSelectedIps}
              canEdit={canDo("ipaddress", "change")}
              canDelete={canDo("ipaddress", "delete")}
              canAdd={canAddIp}
            />
          </div>
        </div>
      </DetailTab>

      <DetailTab value="children" bare>
        <ChildPrefixesPane
          parent={p}
          onEdit={handleEditChild}
          onDelete={handleDeleteChild}
          onSelectedRowsChange={setSelectedChildren}
          canEdit={canEditPrefix}
          canDelete={canDeletePrefix}
        />
      </DetailTab>

      <DetailTab value="map">
        <MapPane prefixId={p.id} vrfId={p.vrf?.id ?? null} rootCidr={p.cidr} />
      </DetailTab>

      <DetailTab value="monitoring">
        <PrefixMonitoring
          prefix={{
            id: p.id,
            cidr: p.cidr,
            auto_discover: p.auto_discover,
          }}
        />
      </DetailTab>

      <DetailTab value="journal">
        <JournalPanel objectType="api.prefix" objectId={p.id} />
      </DetailTab>

      <DetailTab value="history">
        <ChangeLogPanel objectType="api.prefix" objectId={p.id} />
      </DetailTab>

      {/* Only delete confirms remain as modals. Add / edit are real
          routes (see /prefixes/new, /prefixes/$id/edit, /ips/new,
          /ips/$id/edit). Bulk bars live here so they survive tab switches. */}
      {deletePrefix && (
        <PrefixDeleteDialog
          prefix={deletePrefix}
          onOpenChange={closeDeletePrefix}
          onDeleted={goBackOnPrefixDelete}
        />
      )}
      {deletingChild && (
        <PrefixDeleteDialog
          prefix={deletingChild}
          onOpenChange={closeDeleteChild}
        />
      )}
      {deletingIp && (
        <IpDeleteDialog ip={deletingIp} onOpenChange={closeDeleteIp} />
      )}
      {selectedIps.length > 0 && (
        <IpBulkBar
          selected={selectedIps}
          onCleared={clearSelectedIps}
          returnTo={ipsReturnPath}
        />
      )}
      {selectedChildren.length > 0 && (
        <PrefixBulkBar
          selected={selectedChildren}
          onCleared={clearSelectedChildren}
        />
      )}
    </DetailShell>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-xl font-semibold tracking-tight">{value}</dd>
    </div>
  )
}

/** The prefix's attributes, grouped into labelled tables — the detail that used
 * to crowd the page header. Only headline data (CIDR, VRF, status, tags,
 * description) and the single most-scanned metric (utilisation) stay up top;
 * everything else reads here. */
function PrefixOverview({
  prefix: p,
  humanIds,
}: {
  prefix: Prefix
  humanIds: boolean | undefined
}) {
  // Custom fields live HERE (a table beside Details/Addressing) — not in the
  // always-visible header, where they'd repeat on every tab.
  const cfDefs = useCustomFieldDefs("prefix")
  const cfRows: KvRow[] = (cfDefs.data?.results ?? [])
    .filter((d) => hasCustomValue(p.custom_fields?.[d.key]))
    .map((d) => ({
      label: d.label,
      value: formatCustomValue(d, p.custom_fields?.[d.key]),
    }))

  const details: KvRow[] = [
    ...(humanIds && p.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{p.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Family", value: `IPv${p.family ?? "—"}` },
    { label: "Site", value: p.site?.name ?? dash },
  ]

  const addressing: KvRow[] = [
    { label: "Used", value: <span className="num">{p.ip_count}</span> },
    {
      label: "Free",
      value: (
        <span className="num">
          {p.utilisation_pct !== null ? freeCount(p) : "—"}
        </span>
      ),
    },
    {
      label: "VLAN",
      value: p.vlan ? (
        <span className="font-mono text-[13px]">
          {p.vlan.vlan_id} · {p.vlan.name}
        </span>
      ) : (
        dash
      ),
    },
    {
      label: "Gateway",
      value: p.gateway ? (
        <span className="font-mono text-[13px]">{p.gateway}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Details" rows={details} />
      <KvCard title="Addressing" rows={addressing} />
      {cfRows.length > 0 && <KvCard title="Custom fields" rows={cfRows} />}
    </div>
  )
}

function UtilPct({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted-foreground">—</span>
  const tone =
    pct > 95
      ? "text-red-600 dark:text-red-400"
      : pct > 85
        ? "text-amber-600 dark:text-amber-400"
        : ""
  const bar = pct > 95 ? "bg-red-500" : pct > 85 ? "bg-amber-500" : "bg-primary"
  return (
    <>
      <span className={`num ${tone}`}>{pct}%</span>
      <div className="mt-1 h-1 w-28 overflow-hidden rounded-full bg-border">
        <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
    </>
  )
}

function freeCount(p: Prefix): string {
  if (p.utilisation_pct === null) return "—"
  return `${100 - p.utilisation_pct}%`
}

function SubnetDetailsStrip({
  prefix,
  onOpenAddIp,
}: {
  prefix: Prefix
  onOpenAddIp: (addr: string) => void
}) {
  const space = useQuery({
    queryKey: ["prefix-space-map", prefix.id],
    queryFn: () => api<SpaceMapData>(`/api/prefixes/${prefix.id}/space-map/`),
  })
  const details = space.data?.subnet_details ?? []
  const next = space.data?.next_available ?? []
  if (details.length === 0 && next.length === 0) return null

  return (
    <details className="shrink-0 border-b border-border">
      <summary className="flex cursor-pointer items-center gap-2 px-6 py-2.5 text-[11px] tracking-[0.06em] text-muted-foreground uppercase hover:text-foreground">
        <ChevronRight className="h-3.5 w-3.5 transition-transform" />
        <span>Subnet details</span>
        <span className="ml-2 tracking-normal text-muted-foreground normal-case">
          network · mask · usable range · broadcast · next available
        </span>
      </summary>
      <div className="grid gap-5 bg-muted/40 px-6 pt-3 pb-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <SubnetDetailsTable rows={details} />
        <NextAvailableTable addresses={next} onPick={onOpenAddIp} />
      </div>
    </details>
  )
}

function SubnetDetailsTable({ rows }: { rows: SubnetDetailRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-40 text-xs">Field</TableHead>
            <TableHead className="text-xs">Value</TableHead>
            <TableHead className="w-10 text-xs"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={3}
                className="text-center text-[12px] text-muted-foreground"
              >
                No details.
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableCell className="py-2 text-xs text-muted-foreground">
                {row.label}
              </TableCell>
              <TableCell
                className={
                  "py-2 text-[13px] " + (row.mono ? "font-mono" : "num")
                }
              >
                {row.value}
              </TableCell>
              <TableCell className="py-2 pr-2 text-right">
                <CopyButton
                  value={
                    row.copy || (typeof row.value === "string" ? row.value : "")
                  }
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function NextAvailableTable({
  addresses,
  onPick,
}: {
  addresses: string[]
  onPick: (addr: string) => void
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Next available</TableHead>
            <TableHead className="w-10 text-right text-xs">
              <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                add
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {addresses.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={2}
                className="text-center text-[12px] text-muted-foreground"
              >
                No free hosts left in this prefix.
              </TableCell>
            </TableRow>
          )}
          {addresses.map((addr) => (
            <TableRow
              key={addr}
              className="cursor-pointer hover:bg-muted/50"
              onClick={() => onPick(addr)}
            >
              <TableCell className="py-2 font-mono text-[13px]">
                {addr}
              </TableCell>
              <TableCell className="py-2 pr-2 text-right">
                <Plus className="ml-auto h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function MastersStrip({ prefix }: { prefix: Prefix }) {
  const query = useQuery({
    queryKey: ["prefixes", "all"],
    queryFn: () => api<Paginated<Prefix>>("/api/prefixes/?page_size=2000"),
    staleTime: 30_000,
  })
  const masters = useMemo(() => {
    const all = query.data?.results ?? []
    const me = parseCidr(prefix.cidr)
    if (!me) return []
    const vrfKey = prefix.vrf?.id ?? "global"
    const ancestors = all
      .filter((p) => {
        if (p.id === prefix.id) return false
        if ((p.vrf?.id ?? "global") !== vrfKey) return false
        const c = parseCidr(p.cidr)
        return c ? contains(c, me) : false
      })
      .map((p) => ({ p, c: parseCidr(p.cidr)! }))
    ancestors.sort((a, b) => a.c.prefixlen - b.c.prefixlen)
    return ancestors.map((x) => x.p)
  }, [query.data, prefix])

  if (masters.length === 0) return null
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-6 py-2 text-xs">
      <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
        Masters
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {masters.map((m, i) => (
          <span key={m.id} className="inline-flex items-center gap-1">
            {i > 0 && (
              <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
            )}
            <Link
              to="/prefixes/$id"
              params={{ id: m.id }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted hover:underline"
              title={m.description || m.cidr}
            >
              {m.cidr}
              {m.status?.name === "container" && (
                <span className="text-[10px] text-muted-foreground">·</span>
              )}
            </Link>
          </span>
        ))}
      </div>
    </div>
  )
}

function MapPane({
  prefixId,
  vrfId,
  rootCidr,
}: {
  prefixId: string
  vrfId: string | null
  rootCidr: string
}) {
  return <SpaceMap prefixId={prefixId} vrfId={vrfId} rootCidr={rootCidr} />
}

function ChildPrefixesPane({
  parent,
  onEdit,
  onDelete,
  onSelectedRowsChange,
  canEdit,
  canDelete,
}: {
  parent: Prefix
  onEdit: (p: Prefix) => void
  onDelete: (p: Prefix) => void
  onSelectedRowsChange: (rows: Prefix[]) => void
  canEdit: boolean
  canDelete: boolean
}) {
  const query = useQuery({
    queryKey: ["prefixes", "all"],
    queryFn: () => api<Paginated<Prefix>>("/api/prefixes/?page_size=2000"),
  })
  const cfQuery = useCustomFieldDefs("prefix")

  const rows = useMemo<NestedPrefix[]>(() => {
    const all = query.data?.results ?? []
    const parentVrfKey = parent.vrf?.id ?? "global"
    const parentCidr = parseCidr(parent.cidr)
    if (!parentCidr) return []
    const descendants = all.filter((p) => {
      if (p.id === parent.id) return false
      if ((p.vrf?.id ?? "global") !== parentVrfKey) return false
      const c = parseCidr(p.cidr)
      return c ? contains(parentCidr, c) : false
    })
    const nested = annotateNesting([parent, ...descendants])
    // The parent anchors the tree at depth 0 but isn't shown — shift its
    // children back to depth 0 so the indent chevrons start at the edge.
    return nested
      .filter((p) => p.id !== parent.id)
      .map((p) => ({ ...p, _depth: Math.max(0, p._depth - 1) }))
  }, [query.data, parent])

  // Filter rail derives from the factory's facet metadata (status, site,
  // utilisation, tags + one facet per tenant custom field) — same machinery as
  // the /prefixes list, so a new facetable column shows up automatically.
  const cfDefs = useMemo(() => cfQuery.data?.results ?? [], [cfQuery.data])
  const includeCols = useMemo(
    () =>
      [
        "cidr",
        "status",
        "site",
        "description",
        "utilisation",
        "tags",
        "updated",
      ] as const,
    []
  )
  const facetColumns = useMemo<ColumnDef<NestedPrefix>[]>(
    () =>
      buildPrefixColumns<NestedPrefix>({
        include: [...includeCols],
        cfDefs,
      }),
    [includeCols, cfDefs]
  )
  const { rail, filteredRows, toggleValue, selectedValues } = useTableFilters(
    facetColumns,
    rows
  )
  const tagSelection = selectedValues("tags")

  // Shared factory — a child-prefix row reads exactly like /prefixes,
  // including the depth chevrons and the always-visible row actions.
  const columns = useMemo<ColumnDef<NestedPrefix>[]>(
    () =>
      buildPrefixColumns<NestedPrefix>({
        selection: true,
        nested: true,
        include: [...includeCols],
        cfDefs,
        tagFilter: {
          activeSlugs: tagSelection,
          onToggle: (slug) => toggleValue("tags", slug),
        },
        actions: {
          onEdit,
          onDelete,
          canEdit: (p) => objCan(p, "change", canEdit),
          canDelete: (p) => objCan(p, "delete", canDelete),
        },
      }),
    [
      onEdit,
      onDelete,
      canEdit,
      canDelete,
      includeCols,
      cfDefs,
      tagSelection,
      toggleValue,
    ]
  )

  if (query.isLoading)
    return (
      <p className="p-4 text-sm text-muted-foreground lg:p-6">
        Loading children…
      </p>
    )
  if (rows.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground lg:p-6">
        No child prefixes — this prefix sits flat.
      </p>
    )
  }
  return (
    <>
      {rail}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="num text-[11px] text-muted-foreground">
            {filteredRows.length} row{filteredRows.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <DataTable
            data={filteredRows}
            columns={columns}
            flexColumn="description"
            onSelectedRowsChange={onSelectedRowsChange}
            embedded
          />
        </div>
      </div>
    </>
  )
}

function toggle<T>(current: Set<T>, value: T, setter: (s: Set<T>) => void) {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  setter(next)
}
