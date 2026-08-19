import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"

import {
  api,
  type Cluster,
  type Device,
  type Paginated,
  type VirtualMachine,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { DataTable } from "@/components/data-table"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { buildVmColumns } from "@/components/columns/vm-columns"
import { CustomFieldValues } from "@/components/custom-field-display"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { ClusterDeleteDialog } from "@/components/cluster-delete-dialog"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

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
  const [tab, setTab] = useUrlTab<"overview" | "vms" | "devices" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const devices = useQuery({
    queryKey: ["cluster-devices", c.id],
    queryFn: () =>
      api<Paginated<Device>>(`/api/devices/?cluster=${c.id}&page_size=1`),
  })
  const deviceCount = devices.data?.count ?? 0
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
          <DetailHero
            title={c.name}
            badges={<StatusBadge status={c.status} />}
            tags={c.tags.length > 0 && <TagList tags={c.tags} />}
            description={c.description}
            stats={
              <>
                <DetailStat
                  label="Type"
                  value={
                    <Link
                      to="/cluster-types/$id"
                      params={{ id: c.type.id }}
                      className="link text-xs"
                    >
                      {c.type.name}
                    </Link>
                  }
                />
                <DetailStat
                  label="Site"
                  value={
                    c.site ? (
                      <Link
                        to="/sites/$id"
                        params={{ id: c.site.id }}
                        className="link text-xs"
                      >
                        {c.site.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )
                  }
                />
              </>
            }
          />

          <CustomFieldValues model="cluster" values={c.custom_fields} />
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "vms", label: "Virtual machines", count: c.vm_count },
        { value: "devices", label: "Hosts", count: deviceCount },
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
      <DetailTab value="devices">
        <ClusterDevicesPane clusterId={c.id} />
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
    () =>
      buildVmColumns({
        include: ["name", "status", "vcpus", "memory", "primary_ip"],
      }),
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

/** The cluster's attributes, grouped into labelled tables - the detail that
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
    {
      label: "Type",
      value: (
        <Link
          to="/cluster-types/$id"
          params={{ id: c.type.id }}
          className="link"
        >
          {c.type.name}
        </Link>
      ),
    },
    { label: "Group", value: c.group ? c.group.name : dash },
    {
      label: "Site",
      value: c.site ? (
        <span className="inline-flex items-center gap-1.5">
          <Link to="/sites/$id" params={{ id: c.site.id }} className="link">
            {c.site.name}
          </Link>
          {c.apply_site_to_vms && (
            <Badge variant="outline" className="text-[10px]">
              applied to VMs
            </Badge>
          )}
        </span>
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


/** The physical hosts in this cluster.
 *
 * A cluster page answered "what runs here?" but never "what is it made of?" -
 * and the hypervisor sync can now fill those hosts in, so the answer is worth
 * showing beside the VMs. */
function ClusterDevicesPane({ clusterId }: { clusterId: string }) {
  const { humanIds } = useMe()
  const query = useQuery({
    queryKey: ["cluster-devices-list", clusterId],
    queryFn: () =>
      api<Paginated<Device>>(`/api/devices/?cluster=${clusterId}&page_size=200`),
  })
  const columns = useMemo(
    () =>
      buildDeviceColumns<Device>({
        humanIds,
        include: ["numid", "name", "status", "role", "type", "site",
                  "primary_ip"],
      }),
    [humanIds]
  )
  if (query.isError) return <QueryError error={query.error} />
  const rows = query.data?.results ?? []
  if (!query.isLoading && rows.length === 0)
    return (
      <EmptyState title="No hosts in this cluster.">
        Assign a device's <span className="font-medium">Cluster</span> field, or
        let a hypervisor sync create them.
      </EmptyState>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      tableId="cluster-devices"
      flexColumn="name"
      embedded
    />
  )
}
