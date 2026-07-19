import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { DetailActions } from "@/components/detail-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { ChevronLeft, ChevronRight, Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type VLAN, type VLANGroup } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { DataTable, SortHeader } from "@/components/data-table"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { VlanGroupDeleteDialog } from "@/components/vlan-group-delete-dialog"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

import { DetailPresence } from "@/components/detail-presence"

export const Route = createFileRoute("/vlan-groups/$id")({
  component: VlanGroupDetail,
})

function VlanGroupDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["vlan-group", id],
    queryFn: () => api<VLANGroup>(`/api/vlan-groups/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body group={q.data} />
}

function Body({ group: g }: { group: VLANGroup }) {
  const [tab, setTab] = useState<"overview" | "vlans" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const canEdit = canDo("vlangroup", "change")
  const canDelete = canDo("vlangroup", "delete")
  const [deleting, setDeleting] = useState<VLANGroup | null>(null)
  const goBack = useCallback(() => nav({ to: "/vlan-groups" }), [nav])

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Button variant="ghost" size="sm" asChild className="h-6 px-1">
            <Link to="/vlan-groups">
              <ChevronLeft className="h-3 w-3" /> VLAN groups
            </Link>
          </Button>
          <ChevronRight className="h-3 w-3 opacity-60" />
          <span className="font-semibold tracking-tight text-foreground">
            {g.name}
          </span>
        </nav>
        <DetailPresence type="vlangroup" />
        <div className="ml-auto flex items-center gap-1.5">
          <DetailActions />
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/vlan-groups/$id/edit" params={{ id: g.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(g)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </div>
      </header>

      <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
        <div className="min-w-0">
          <div className="text-2xl font-semibold tracking-tight">{g.name}</div>
          {g.description && (
            <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
              {g.description}
            </p>
          )}
        </div>
        <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
          <Stat
            label="VID range"
            value={
              <span className="num font-mono">
                {g.min_vid}–{g.max_vid}
              </span>
            }
          />
        </dl>
      </section>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as typeof tab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex h-10 items-center border-b border-border px-4 lg:px-6">
          <SegmentedTabs
            value={tab}
            onValueChange={(v) => setTab(v as typeof tab)}
            items={[
              { value: "overview", label: "Overview" },
              { value: "vlans", label: "VLANs", count: g.vlan_count },
              { value: "journal", label: "Journal" },
              { value: "history", label: "History" },
            ]}
          />
        </div>
        <TabsContent
          value="overview"
          className="m-0 flex-1 overflow-auto p-4 lg:p-6"
        >
          <VlanGroupOverview group={g} humanIds={humanIds} />
        </TabsContent>
        <TabsContent
          value="vlans"
          className="m-0 flex-1 overflow-auto p-4 lg:p-6"
        >
          <GroupVlansTable groupId={g.id} />
        </TabsContent>
        <TabsContent
          value="journal"
          className="m-0 flex-1 overflow-auto p-4 lg:p-6"
        >
          <JournalPanel objectType="api.vlangroup" objectId={g.id} />
        </TabsContent>
        <TabsContent
          value="history"
          className="m-0 flex-1 overflow-auto p-4 lg:p-6"
        >
          <ChangeLogPanel objectType="api.vlangroup" objectId={g.id} />
        </TabsContent>
      </Tabs>

      <VlanGroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </div>
  )
}

/** VLAN group attributes that used to crowd the header, grouped into a table. */
function VlanGroupOverview({
  group: g,
  humanIds,
}: {
  group: VLANGroup
  humanIds: boolean
}) {
  const attributes: KvRow[] = [
    ...(humanIds && g.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{g.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "VID range",
      value: (
        <span className="num font-mono">
          {g.min_vid}–{g.max_vid}
        </span>
      ),
    },
    { label: "Scope", value: g.site?.name ?? g.cluster?.name ?? dash },
    { label: "VLANs", value: <span className="num">{g.vlan_count}</span> },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Attributes" rows={attributes} />
    </div>
  )
}

function GroupVlansTable({ groupId }: { groupId: string }) {
  const q = useQuery({
    queryKey: ["group-vlans", groupId],
    queryFn: () =>
      api<Paginated<VLAN>>(`/api/vlans/?group=${groupId}&page_size=500`),
  })
  const columns = useMemo<ColumnDef<VLAN>[]>(
    () => [
      {
        id: "vlan_id",
        accessorKey: "vlan_id",
        header: ({ column }) => <SortHeader column={column} label="VID" />,
        cell: ({ row }) => (
          <Link
            to="/vlans/$id"
            params={{ id: row.original.id }}
            className="font-mono font-medium hover:underline"
          >
            {row.original.vlan_id}
          </Link>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => <span className="text-xs">{row.original.name}</span>,
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
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No VLANs belong to this group.
      </p>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      embedded
    />
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-[13px]">{value}</dd>
    </div>
  )
}
