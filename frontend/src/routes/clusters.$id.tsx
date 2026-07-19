import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"

import {
  api,
  type Cluster,
  type Paginated,
  type VirtualMachine,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { DataTable, SortHeader } from "@/components/data-table"
import { CustomFieldValues } from "@/components/custom-field-display"
import { QueryError } from "@/components/query-error"
import { ClusterDeleteDialog } from "@/components/cluster-delete-dialog"
import { StatusBadge } from "@/components/status-badge"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

/** Memory in MB → "x GB" when an even multiple of 1024, else "x MB". */
function formatMemory(mb: number): string {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`
  return `${mb} MB`
}

export const Route = createFileRoute("/clusters/$id")({
  component: ClusterDetail,
})

function ClusterDetail() {
  const { id } = Route.useParams()
  const cluster = useQuery({
    queryKey: ["cluster", id],
    queryFn: () => api<Cluster>(`/api/clusters/${id}/`),
  })
  if (cluster.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (cluster.isError)
    return (
      <div className="p-6">
        <QueryError error={cluster.error} />
      </div>
    )
  if (!cluster.data) return null
  return <ClusterDetailBody cluster={cluster.data} />
}

function ClusterDetailBody({ cluster: c }: { cluster: Cluster }) {
  const { canDo } = useMe()
  const canEdit = canDo("cluster", "change")
  const canDelete = canDo("cluster", "delete")
  const [tab, setTab] = useState<"overview" | "vms" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<Cluster | null>(null)
  const openDelete = useCallback(() => setDeleting(c), [c])
  const goBack = useCallback(() => nav({ to: "/clusters" }), [nav])

  return (
    <DetailShell
      backTo="/clusters"
      backLabel="Clusters"
      title={c.name}
      presence={{ type: "cluster", id: c.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/clusters/$id/edit" params={{ id: c.id }}>
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
        <>
          <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <div className="text-3xl font-semibold tracking-tight">
                  {c.name}
                </div>
                <StatusBadge status={c.status} />
              </div>
              {c.tags.length > 0 && (
                <div className="mt-2">
                  <TagList tags={c.tags} />
                </div>
              )}
              {c.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {c.description}
                </p>
              )}
            </div>
            <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              <DetailStat
                label="Type"
                value={<span className="text-xs">{c.type.name}</span>}
              />
              <DetailStat
                label="Site"
                value={
                  c.site ? (
                    <Link
                      to="/sites/$id"
                      params={{ id: c.site.id }}
                      className="text-xs text-primary hover:underline"
                    >
                      {c.site.name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
              />
            </dl>
          </section>

          <CustomFieldValues model="cluster" values={c.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "vms", label: "Virtual machines", count: c.vm_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <ClusterOverview cluster={c} />
      </DetailTab>
      <DetailTab value="vms">
        <ClusterVmsPane clusterId={c.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.cluster" objectId={c.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.cluster" objectId={c.id} />
      </DetailTab>

      <ClusterDeleteDialog
        cluster={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function ClusterVmsPane({ clusterId }: { clusterId: string }) {
  const q = useQuery({
    queryKey: ["cluster-vms", clusterId],
    queryFn: () =>
      api<Paginated<VirtualMachine>>(
        `/api/virtual-machines/?cluster=${clusterId}`
      ),
  })
  const rows = q.data?.results ?? []
  const columns = useMemo<ColumnDef<VirtualMachine>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/virtual-machines/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: ({ column }) => <SortHeader column={column} label="Status" />,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "vcpus",
        accessorKey: "vcpus",
        header: ({ column }) => <SortHeader column={column} label="vCPUs" />,
        cell: ({ row }) =>
          row.original.vcpus != null ? (
            <span className="num text-xs">{row.original.vcpus}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "memory",
        accessorKey: "memory_mb",
        header: ({ column }) => <SortHeader column={column} label="Memory" />,
        cell: ({ row }) =>
          row.original.memory_mb != null ? (
            <span className="num text-xs">
              {formatMemory(row.original.memory_mb)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "primary_ip",
        header: "Primary IP",
        cell: ({ row }) =>
          row.original.primary_ip ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.primary_ip.id }}
              className="font-mono text-xs hover:underline"
            >
              {row.original.primary_ip.ip_address}
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    []
  )
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No virtual machines yet.</p>
    )
  return (
    <DataTable data={rows} columns={columns} flexColumn="primary_ip" embedded />
  )
}

/** The cluster's attributes, grouped into labelled tables — the detail that
 * used to crowd the page header. Only name, status, and type stay up top. */
function ClusterOverview({ cluster: c }: { cluster: Cluster }) {
  const { humanIds } = useMe()
  const clusterRows: KvRow[] = [
    ...(humanIds && c.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{c.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Type", value: c.type.name },
    { label: "Group", value: c.group ? c.group.name : dash },
    {
      label: "Site",
      value: c.site ? (
        <Link
          to="/sites/$id"
          params={{ id: c.site.id }}
          className="text-primary hover:underline"
        >
          {c.site.name}
        </Link>
      ) : (
        dash
      ),
    },
  ]
  const membersRows: KvRow[] = [
    {
      label: "Virtual machines",
      value: <span className="num">{c.vm_count}</span>,
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Cluster" rows={clusterRows} />
      <KvCard title="Members" rows={membersRows} />
    </div>
  )
}
