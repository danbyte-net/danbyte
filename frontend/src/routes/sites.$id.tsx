import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Network, Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import {
  api,
  type Location,
  type ObjectPermission,
  type Paginated,
  type Prefix,
  type Site,
  type VirtualMachine,
  type VLAN,
} from "@/lib/api"
import { TagList } from "@/components/cells/tag-list"
import { StatusBadge } from "@/components/status-badge"
import { VrfCell } from "@/components/cells/vrf-cell"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { buildVlanColumns } from "@/components/columns/vlan-columns"
import { buildVmColumns } from "@/components/columns/vm-columns"
import { EmptyState } from "@/components/empty-state"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import { SiteDeleteDialog } from "@/components/site-delete-dialog"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { MiniMap } from "@/components/site-map/mini-map"
import { ObjectImages } from "@/components/object-images"
import { ObjectDocuments } from "@/components/object-documents"
import { EmbeddedDeviceTable } from "@/components/embedded-device-table"
import { EmbeddedCircuitTable } from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { ContactsPanel } from "@/components/contacts-panel"
import { SiteRoleDialog } from "@/components/site-role-dialog"
import { SiteAssignPrefixDialog } from "@/components/site-assign-prefix-dialog"
import { Badge } from "@/components/ui/badge"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/sites/$id")({ component: SiteDetail })

const POLICY_LABEL = {
  first: "First usable address",
  last: "Last usable address",
  none: "No automatic gateway",
} as const

function SiteDetail() {
  const { id } = Route.useParams()
  const site = useQuery({
    queryKey: ["site", id],
    queryFn: () => api<Site>(`/api/sites/${id}/`),
  })
  if (site.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (site.isError)
    return (
      <div className="p-6">
        <QueryError error={site.error} />
      </div>
    )
  if (!site.data) return null
  return <SiteDetailBody site={site.data} />
}

function SiteDetailBody({ site: s }: { site: Site }) {
  const [tab, setTab] = useUrlTab<
    | "overview"
    | "locations"
    | "devices"
    | "vms"
    | "prefixes"
    | "vlans"
    | "circuits"
    | "contacts"
    | "access"
    | "documents"
    | "journal"
    | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo, canManage, canDelegateSite, humanIds } = useMe()
  // Access tab is for permission admins; a delegating site editor also sees it
  // (limited to inviting viewers, enforced server-side).
  const canDelegateHere = canDelegateSite(s.id)
  const showAccess = canManage || canDelegateHere
  const [deleting, setDeleting] = useState<Site | null>(null)
  const openDelete = useCallback(() => setDeleting(s), [s])
  const closeDelete = useCallback((o: boolean) => {
    if (!o) setDeleting(null)
  }, [])
  const goBack = useCallback(() => nav({ to: "/sites" }), [nav])

  return (
    <DetailShell
      backTo="/sites"
      backLabel="Sites"
      title={s.name}
      presence={{ type: "site", id: s.id }}
      actions={
        <>
          <Button variant="outline" size="sm" asChild>
            <Link to="/racks/elevations" search={{ site: s.id }}>
              Rack elevations
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/topology" search={{ site: s.id }}>
              <Network className="h-3.5 w-3.5" /> Topology
            </Link>
          </Button>
          {canDo("site", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/sites/$id/edit" params={{ id: s.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("site", "delete") && (
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
          title={s.name}
          badges={<ViolationBadge objectId={s.id} prominent />}
          subtitle={s.location}
          tags={s.tags.length > 0 && <TagList tags={s.tags} />}
          description={s.description}
        >
          {s.vrfs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                VRFs
              </span>
              {s.vrfs.map((v) => (
                <VrfCell key={v.id} vrf={v} />
              ))}
            </div>
          )}
        </DetailHero>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "locations", label: "Locations" },
        { value: "devices", label: "Devices", count: s.device_count },
        { value: "vms", label: "Virtual machines", count: s.vm_count },
        { value: "prefixes", label: "Prefixes", count: s.prefix_count },
        { value: "vlans", label: "VLANs", count: s.vlan_count },
        { value: "circuits", label: "Circuits", count: s.circuit_count },
        { value: "contacts", label: "Contacts", count: s.contact_count },
        ...(showAccess ? [{ value: "access", label: "Access" }] : []),
        { value: "documents", label: "Documents" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <SiteOverview site={s} humanIds={humanIds} onGoTab={setTab} />
      </DetailTab>
      <DetailTab value="locations">
        <SiteLocationsTable siteId={s.id} />
      </DetailTab>
      <DetailTab value="devices">
        <EmbeddedDeviceTable
          filter={{ site: s.id }}
          emptyText="No devices at this site yet."
        />
      </DetailTab>
      <DetailTab value="prefixes">
        <SitePrefixesTable siteId={s.id} siteName={s.name} />
      </DetailTab>
      <DetailTab value="vms">
        <SiteVmsTable siteId={s.id} />
      </DetailTab>
      <DetailTab value="vlans">
        <SiteVlansTable siteId={s.id} />
      </DetailTab>
      <DetailTab value="circuits">
        <EmbeddedCircuitTable
          filter={{ site: s.id }}
          emptyText="No circuits terminate at this site."
        />
      </DetailTab>
      <DetailTab value="contacts">
        <ContactsPanel objectType="api.site" objectId={s.id} />
      </DetailTab>
      {showAccess && (
        <DetailTab value="access">
          <SiteAccessPanel
            siteId={s.id}
            siteName={s.name}
            viewerOnly={!canManage}
          />
        </DetailTab>
      )}
      <DetailTab value="documents">
        <ObjectDocuments objectType="api.site" objectId={s.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.site" objectId={s.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.site" objectId={s.id} />
      </DetailTab>

      <SiteDeleteDialog
        site={deleting}
        onOpenChange={closeDelete}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function roleOf(p: ObjectPermission): "editor" | "viewer" {
  return p.actions.some((a) => a === "add" || a === "change" || a === "delete")
    ? "editor"
    : "viewer"
}

/** Who can edit / view this site - the per-site face of the Site role feature.
 * `viewerOnly` is a delegating local editor: they may invite *viewers* only and
 * can't read the full permission list (admin-gated), so we hide it for them. */
function SiteAccessPanel({
  siteId,
  siteName,
  viewerOnly,
}: {
  siteId: string
  siteName: string
  viewerOnly?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const q = useQuery({
    queryKey: ["object-permissions"],
    queryFn: () => api<Paginated<ObjectPermission>>("/api/object-permissions/"),
    enabled: !viewerOnly,
  })
  const perms = (q.data?.results ?? []).filter((p) =>
    p.sites.some((s) => s.id === siteId)
  )

  if (!viewerOnly && q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading access…</p>
  if (!viewerOnly && q.isError) return <QueryError error={q.error} />

  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex items-start gap-3">
        <p className="text-[11px] text-muted-foreground">
          {viewerOnly ? (
            <>
              Invite a teammate to <b>view</b> <b>{siteName}</b>. They'll get
              read-only access to this site and nothing else.
            </>
          ) : (
            <>
              People and groups scoped to <b>{siteName}</b>. <b>Editors</b>{" "}
              manage everything in this site; <b>viewers</b> can only read it.
              Grants are ordinary permissions - fine-tune or remove them on the{" "}
              <Link
                to="/permissions"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Permissions
              </Link>{" "}
              page.
            </>
          )}
        </p>
        <Button
          size="sm"
          className="ml-auto shrink-0"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3.5 w-3.5" />{" "}
          {viewerOnly ? "Invite viewer" : "Assign people"}
        </Button>
      </div>

      {viewerOnly ? null : perms.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No one is scoped to this site yet. Use <b>Assign people</b> to grant a
          user or group editor or viewer access.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {perms.map((p) => {
            const role = roleOf(p)
            const members = [
              ...p.users.map((u) => u.username),
              ...p.groups.map((g) => `${g.name} (group)`),
            ]
            return (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <Badge
                  variant={role === "editor" ? "default" : "secondary"}
                  className="shrink-0 capitalize"
                >
                  {role}
                </Badge>
                <div className="min-w-0">
                  <Link
                    to="/permissions/$id/edit"
                    params={{ id: p.id }}
                    className="link text-[13px] font-medium"
                  >
                    {p.name}
                  </Link>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {members.length
                      ? members.join(" · ")
                      : "No one assigned yet"}
                  </div>
                </div>
                {!p.enabled && (
                  <Badge variant="secondary" className="ml-auto text-[10px]">
                    disabled
                  </Badge>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <SiteRoleDialog
        open={adding}
        onOpenChange={setAdding}
        lockedSiteId={siteId}
        lockedSiteName={siteName}
        viewerOnly={viewerOnly}
      />
    </div>
  )
}

/** The site's locations (buildings / floors / rooms), each linked. Closes the
 * region → site → location → rack navigation chain (#26). */
function SiteLocationsTable({ siteId }: { siteId: string }) {
  const q = useQuery({
    queryKey: ["site-locations", siteId],
    queryFn: () =>
      api<Paginated<Location>>(`/api/locations/?site=${siteId}&page_size=500`),
  })
  const columns = useMemo<ColumnDef<Location>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <Link
            to="/locations/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "devices",
        accessorKey: "device_count",
        header: "Devices",
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.device_count}</span>
        ),
      },
      {
        id: "racks",
        accessorKey: "rack_count",
        header: "Racks",
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.rack_count}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
    ],
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading locations…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <EmptyState title="No locations yet.">
        This site has no locations (buildings / floors / rooms) yet.
      </EmptyState>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      tableId="site-locations-embedded"
      flexColumn="name"
      embedded
    />
  )
}

function SitePrefixesTable({
  siteId,
  siteName,
}: {
  siteId: string
  siteName: string
}) {
  const { canDo } = useMe()
  const [assigning, setAssigning] = useState(false)
  const q = useQuery({
    queryKey: ["site-prefixes", siteId],
    queryFn: () =>
      api<Paginated<Prefix>>(`/api/prefixes/?site=${siteId}&page_size=500`),
  })
  const columns = useMemo<ColumnDef<Prefix>[]>(
    () => buildPrefixColumns({ omit: ["site"] }),
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading prefixes…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-[11px] text-muted-foreground">
          Prefixes assigned here are the site's <b>address scope</b> -
          site-scoped users can only carve child prefixes within these ranges.
        </p>
        {canDo("prefix", "change") && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => setAssigning(true)}
          >
            <Plus className="h-3.5 w-3.5" /> Assign prefix
          </Button>
        )}
        {canDo("prefix", "add") && (
          <Button
            size="sm"
            className={canDo("prefix", "change") ? "" : "ml-auto"}
            asChild
          >
            <Link
              to="/prefixes/new"
              search={{
                cidr: undefined,
                vrf: undefined,
                site: siteId,
                location: undefined,
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Add prefix range
            </Link>
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No prefixes yet.">
          No address ranges assigned to this site yet.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="prefix-embedded"
        />
      )}
      <SiteAssignPrefixDialog
        siteId={siteId}
        siteName={siteName}
        open={assigning}
        onOpenChange={setAssigning}
      />
    </div>
  )
}

/** What runs at a site, in two honest groups.
 *
 * A VM's site is its own field and a cluster's site is not inherited (a central
 * cluster routinely runs branch workloads), so "placed here" and "hosted here"
 * are different questions. Both are worth answering on a site page. */
function SiteVmsTable({ siteId }: { siteId: string }) {
  const placed = useQuery({
    queryKey: ["site-vms", siteId],
    queryFn: () =>
      api<Paginated<VirtualMachine>>(
        `/api/virtual-machines/?site=${siteId}&page_size=500`
      ),
  })
  // Hosted by a cluster that sits here, but carrying no site of their own.
  const hosted = useQuery({
    queryKey: ["site-cluster-vms", siteId],
    queryFn: () =>
      api<Paginated<VirtualMachine>>(
        `/api/virtual-machines/?cluster_site=${siteId}&page_size=500`
      ),
  })
  const columns = useMemo<ColumnDef<VirtualMachine>[]>(
    () =>
      buildVmColumns({
        include: ["name", "status", "cluster", "vcpus", "memory", "primary_ip"],
      }),
    []
  )

  if (placed.isLoading || hosted.isLoading)
    return <p className="text-sm text-muted-foreground">Loading VMs…</p>
  if (placed.isError) return <QueryError error={placed.error} />
  const placedRows = placed.data?.results ?? []
  const placedIds = new Set(placedRows.map((v) => v.id))
  const hostedRows = (hosted.data?.results ?? []).filter(
    (v) => !placedIds.has(v.id)
  )

  if (placedRows.length === 0 && hostedRows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No virtual machines are placed at or hosted from this site.
      </p>
    )

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Placed here
        </h3>
        {placedRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No VM has this site set. A VM's site is its own field - set it on the
            VM, or tick <strong>Give VMs on this cluster its site</strong> on a
            cluster that really is here.
          </p>
        ) : (
          <DataTable
            data={placedRows}
            columns={columns}
            flexColumn="primary_ip"
          />
        )}
      </section>

      {hostedRows.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
            Hosted by clusters here ({hostedRows.length})
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            These run on a cluster at this site but have no site of their own,
            so they are not counted above.
          </p>
          <DataTable
            data={hostedRows}
            columns={columns}
            flexColumn="primary_ip"
          />
        </section>
      )}
    </div>
  )
}

function SiteVlansTable({ siteId }: { siteId: string }) {
  const q = useQuery({
    queryKey: ["site-vlans", siteId],
    queryFn: () =>
      api<Paginated<VLAN>>(`/api/vlans/?site=${siteId}&page_size=500`),
  })
  const columns = useMemo<ColumnDef<VLAN>[]>(
    () =>
      buildVlanColumns({
        include: ["vlan_id", "name", "prefixes", "description", "updated"],
      }),
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading VLANs…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No VLANs at this site.</p>
    )
  return <DataTable data={rows} columns={columns} flexColumn="description" />
}

/** The site's IANA zone plus its current local time - so an operator can read
 * the offset between sites at a glance. Recomputed each render (cheap; the page
 * isn't a clock, it just needs to be right when opened). */
function SiteLocalTime({ tz }: { tz: string }) {
  let local = ""
  try {
    local = new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date())
  } catch {
    // Unknown zone (shouldn't pass validation) - show the name alone.
  }
  return (
    <span className="text-xs">
      {tz}
      {local && <span className="ml-2 text-muted-foreground">{local}</span>}
    </span>
  )
}

/** The site's attributes, grouped into labelled tables - the detail that used
 * to crowd the page header. Only the name, compliance badge, location, tags and
 * description stay up top; everything else reads here. */
function SiteOverview({
  site: s,
  humanIds,
  onGoTab,
}: {
  site: Site
  humanIds: boolean
  onGoTab: (tab: "prefixes" | "vlans") => void
}) {
  const details: KvRow[] = [
    ...(humanIds && s.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{s.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Address", value: s.location || dash },
    {
      label: "Time zone",
      value: s.time_zone ? <SiteLocalTime tz={s.time_zone} /> : dash,
    },
    {
      label: "Gateway policy",
      value: <span className="text-xs">{POLICY_LABEL[s.gateway_policy]}</span>,
    },
  ]

  const scope: KvRow[] = [
    {
      label: "Prefixes",
      value: (
        <button
          type="button"
          onClick={() => onGoTab("prefixes")}
          className="link num"
        >
          {s.prefix_count}
        </button>
      ),
    },
    {
      label: "VLANs",
      value: (
        <button
          type="button"
          onClick={() => onGoTab("vlans")}
          className="link num"
        >
          {s.vlan_count}
        </button>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Details" rows={details} />
        <section>
          <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
            On the map
          </h2>
          <div className="relative h-40 overflow-hidden rounded-lg border border-border">
            <MiniMap
              className="h-full w-full"
              highlightSiteId={s.id}
              onlyConnectionsOf={s.id}
            />
            <Link
              to="/site-map"
              className="absolute right-2 bottom-2 z-[500] rounded-md border border-border bg-background/85 px-2 py-1 text-[11px] backdrop-blur hover:bg-background"
              title="Open the Site map"
            >
              Open map →
            </Link>
          </div>
        </section>
        <KvCard title="Scope" rows={scope} />
      </div>
      <ObjectImages apiBase={`/api/sites/${s.id}`} objectType="site" />
    </div>
  )
}
