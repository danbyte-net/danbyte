import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Prefix, type VLAN } from "@/lib/api"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { Button } from "@/components/ui/button"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { VlanDeleteDialog } from "@/components/vlan-delete-dialog"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/vlans/$id")({ component: VlanDetail })

function VlanDetail() {
  const { id } = Route.useParams()
  const vlan = useQuery({
    queryKey: ["vlan", id],
    queryFn: () => api<VLAN>(`/api/vlans/${id}/`),
  })

  if (vlan.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (vlan.isError)
    return (
      <div className="p-6">
        <QueryError error={vlan.error} />
      </div>
    )
  if (!vlan.data) return null
  return <VlanDetailBody vlan={vlan.data} />
}

function VlanDetailBody({ vlan: v }: { vlan: VLAN }) {
  const [tab, setTab] = useState<
    "overview" | "prefixes" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const canEdit = canDo("vlan", "change")
  const canDelete = canDo("vlan", "delete")
  const [deleting, setDeleting] = useState<VLAN | null>(null)

  const openDelete = useCallback(() => setDeleting(v), [v])
  const closeDelete = useCallback((o: boolean) => {
    if (!o) setDeleting(null)
  }, [])
  const goBack = useCallback(() => nav({ to: "/vlans" }), [nav])

  return (
    <DetailShell
      backTo="/vlans"
      backLabel="VLANs"
      title={
        <span className="font-mono">
          {v.vlan_id} · {v.name}
        </span>
      }
      presence={{ type: "vlan", id: v.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/vlans/$id/edit" params={{ id: v.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
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
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="font-mono text-3xl font-semibold tracking-tight">
                <span className="text-xl text-muted-foreground/70">VLAN </span>
                {v.vlan_id}
              </div>
              <div className="text-xl font-medium text-foreground">
                {v.name}
              </div>
              <ViolationBadge objectId={v.id} prominent />
            </div>
            {v.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={v.tags} />
              </div>
            )}
            {v.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {v.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
            <DetailStat
              label="Prefixes"
              value={<span className="num">{v.prefix_count}</span>}
            />
          </dl>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "prefixes", label: "Prefixes", count: v.prefix_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <VlanOverview vlan={v} humanIds={humanIds} />
      </DetailTab>
      <DetailTab value="prefixes">
        <VlanPrefixesTable vlanId={v.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.vlan" objectId={v.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.vlan" objectId={v.id} />
      </DetailTab>

      <VlanDeleteDialog
        vlan={deleting}
        onOpenChange={closeDelete}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** VLAN attributes that used to crowd the header, grouped into a table. */
function VlanOverview({
  vlan: v,
  humanIds,
}: {
  vlan: VLAN
  humanIds: boolean
}) {
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
      label: "VLAN ID",
      value: <span className="num font-mono">{v.vlan_id}</span>,
    },
    { label: "Site", value: v.site?.name ?? dash },
    {
      label: "Updated",
      value: <TimeCell iso={v.updated_at} />,
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Attributes" rows={attributes} />
    </div>
  )
}

function VlanPrefixesTable({ vlanId }: { vlanId: string }) {
  const q = useQuery({
    queryKey: ["vlan-prefixes", vlanId],
    queryFn: () =>
      api<Paginated<Prefix>>(`/api/prefixes/?vlan=${vlanId}&page_size=500`),
  })

  const columns = useMemo<ColumnDef<Prefix>[]>(
    () => buildPrefixColumns({ omit: ["vlan"] }),
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading prefixes…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0) {
    return (
      <EmptyState title="No prefixes yet.">
        No prefixes are tied to this VLAN.
      </EmptyState>
    )
  }
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      tableId="prefix-embedded"
    />
  )
}
