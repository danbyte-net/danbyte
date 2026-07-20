import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import {
  api,
  type ObjectPermission,
  type Paginated,
  type Prefix,
  type Site,
  type VLAN,
} from "@/lib/api"
import { TagList } from "@/components/cells/tag-list"
import { VrfCell } from "@/components/cells/vrf-cell"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { EmptyState } from "@/components/empty-state"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { SiteDeleteDialog } from "@/components/site-delete-dialog"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { MiniMap } from "@/components/site-map/mini-map"
import { ObjectImages } from "@/components/object-images"
import { EmbeddedDeviceTable } from "@/components/embedded-device-table"
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
    | "devices"
    | "prefixes"
    | "vlans"
    | "contacts"
    | "access"
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
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-3xl font-semibold tracking-tight">
                {s.name}
              </div>
              <ViolationBadge objectId={s.id} prominent />
            </div>
            {s.location && (
              <div className="mt-1 text-sm text-muted-foreground">
                {s.location}
              </div>
            )}
            {s.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={s.tags} />
              </div>
            )}
            {s.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {s.description}
              </p>
            )}
            {s.vrfs.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                  VRFs
                </span>
                {s.vrfs.map((v) => (
                  <VrfCell key={v.id} vrf={v} />
                ))}
              </div>
            )}
          </div>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "devices", label: "Devices" },
        { value: "prefixes", label: "Prefixes", count: s.prefix_count },
        { value: "vlans", label: "VLANs", count: s.vlan_count },
        { value: "contacts", label: "Contacts" },
        ...(showAccess ? [{ value: "access", label: "Access" }] : []),
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <SiteOverview site={s} humanIds={humanIds} />
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
      <DetailTab value="vlans">
        <SiteVlansTable siteId={s.id} />
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

/** Who can edit / view this site — the per-site face of the Site role feature.
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
              Grants are ordinary permissions — fine-tune or remove them on the{" "}
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
                    className="text-[13px] font-medium hover:underline"
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
          Prefixes assigned here are the site's <b>address scope</b> —
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

function SiteVlansTable({ siteId }: { siteId: string }) {
  const q = useQuery({
    queryKey: ["site-vlans", siteId],
    queryFn: () =>
      api<Paginated<VLAN>>(`/api/vlans/?site=${siteId}&page_size=500`),
  })
  const columns = useMemo<ColumnDef<VLAN>[]>(
    () => [
      {
        id: "vlan_id",
        accessorKey: "vlan_id",
        header: ({ column }) => <SortHeader column={column} label="VLAN" />,
        cell: ({ row }) => (
          <Link
            to="/vlans/$id"
            params={{ id: row.original.id }}
            className="num font-mono text-xs font-medium hover:underline"
          >
            {row.original.vlan_id}
          </Link>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/vlans/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "prefix_count",
        accessorKey: "prefix_count",
        header: "Prefixes",
        cell: ({ row }) =>
          row.original.prefix_count > 0 ? (
            <span className="num text-xs">{row.original.prefix_count}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="line-clamp-1 block text-muted-foreground">
            {row.original.description || "—"}
          </span>
        ),
      },
      timeAgoColumn<VLAN>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
    ],
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

/** The site's attributes, grouped into labelled tables — the detail that used
 * to crowd the page header. Only the name, compliance badge, location, tags and
 * description stay up top; everything else reads here. */
function SiteOverview({
  site: s,
  humanIds,
}: {
  site: Site
  humanIds: boolean
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
    { label: "Location", value: s.location || dash },
    {
      label: "Gateway policy",
      value: <span className="text-xs">{POLICY_LABEL[s.gateway_policy]}</span>,
    },
  ]

  const scope: KvRow[] = [
    { label: "Prefixes", value: <span className="num">{s.prefix_count}</span> },
    { label: "VLANs", value: <span className="num">{s.vlan_count}</span> },
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
