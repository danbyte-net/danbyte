import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type VirtualMachine } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { CustomFieldValues } from "@/components/custom-field-display"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { QueryError } from "@/components/query-error"
import { VmDeleteDialog } from "@/components/vm-delete-dialog"
import { StatusBadge } from "@/components/status-badge"
import { useMe } from "@/lib/use-me"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { VMInterfacesPane } from "@/components/vm-interfaces-pane"
import { ConfigContextPanel } from "@/components/config-context-panel"
import { ServicesPane } from "@/components/services-pane"
import { IpMonitoring } from "@/components/monitoring/ip-monitoring"
import { KvCard, type KvRow, mono, dash } from "@/components/kv-card"

export const Route = createFileRoute("/virtual-machines/$id")({
  component: VmDetail,
})

/** Memory in MB → "x GB" when an even multiple of 1024, else "x MB". */
function formatMemory(mb: number): string {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`
  return `${mb} MB`
}

function VmDetail() {
  const { id } = Route.useParams()
  const vm = useQuery({
    queryKey: ["virtual-machine", id],
    queryFn: () => api<VirtualMachine>(`/api/virtual-machines/${id}/`),
  })
  if (vm.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (vm.isError)
    return (
      <div className="p-6">
        <QueryError error={vm.error} />
      </div>
    )
  if (!vm.data) return null
  return <VmDetailBody vm={vm.data} />
}

function VmDetailBody({ vm }: { vm: VirtualMachine }) {
  const { canDo } = useMe()
  const canEdit = canDo("virtualmachine", "change")
  const canDelete = canDo("virtualmachine", "delete")
  const [tab, setTab] = useUrlTab<
    | "overview"
    | "components"
    | "services"
    | "monitoring"
    | "config"
    | "journal"
    | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<VirtualMachine | null>(null)
  const openDelete = useCallback(() => setDeleting(vm), [vm])
  const goBack = useCallback(() => nav({ to: "/virtual-machines" }), [nav])

  return (
    <DetailShell
      backTo="/virtual-machines"
      backLabel="Virtual machines"
      title={vm.name}
      presence={{ type: "virtualmachine", id: vm.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/virtual-machines/$id/edit" params={{ id: vm.id }}>
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
            <div className="flex items-center gap-3">
              <div className="text-3xl font-semibold tracking-tight">
                {vm.name}
              </div>
              <StatusBadge status={vm.status} />
            </div>
            {vm.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={vm.tags} />
              </div>
            )}
            {vm.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {vm.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px] sm:grid-cols-3">
            <DetailStat
              label="Cluster"
              value={
                <Link
                  to="/clusters/$id"
                  params={{ id: vm.cluster.id }}
                  className="text-xs text-primary hover:underline"
                >
                  {vm.cluster.name}
                </Link>
              }
            />
            <DetailStat
              label="Primary IP"
              value={
                vm.primary_ip ? (
                  <Link
                    to="/ips/$id"
                    params={{ id: vm.primary_ip.id }}
                    className="font-mono text-[13px] text-primary hover:underline"
                  >
                    {vm.primary_ip.ip_address}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              }
            />
          </dl>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "components", label: "Components" },
        { value: "services", label: "Services" },
        { value: "monitoring", label: "Monitoring" },
        { value: "config", label: "Config" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <VmOverview vm={vm} />
      </DetailTab>
      <DetailTab value="components">
        <VMInterfacesPane vmId={vm.id} />
      </DetailTab>
      <DetailTab value="config">
        <ConfigContextPanel endpoint="virtual-machines" id={vm.id} />
      </DetailTab>
      <DetailTab value="services">
        <ServicesPane parent={{ kind: "vm", id: vm.id }} />
      </DetailTab>
      <DetailTab value="monitoring">
        {vm.primary_ip ? (
          <IpMonitoring
            ip={{
              id: vm.primary_ip.id,
              ip_address: vm.primary_ip.ip_address,
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Set a primary IP for this VM to monitor it.{" "}
            <Link
              to="/virtual-machines/$id/edit"
              params={{ id: vm.id }}
              className="text-primary hover:underline"
            >
              Edit VM
            </Link>
          </p>
        )}
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.virtualmachine" objectId={vm.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.virtualmachine" objectId={vm.id} />
      </DetailTab>

      <VmDeleteDialog
        vm={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

// The default "Overview" tab — VM facts in labelled cards with copy
// buttons on the technical strings, then custom fields.
function VmOverview({ vm }: { vm: VirtualMachine }) {
  const { humanIds } = useMe()
  const vmRows: KvRow[] = [
    ...(humanIds && vm.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{vm.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: mono(vm.name), copy: vm.name },
    {
      label: "Status",
      value: <StatusBadge status={vm.status} />,
    },
    { label: "Role", value: vm.role?.name ?? dash },
    { label: "Platform", value: vm.platform?.name ?? dash },
    { label: "Description", value: vm.description || dash },
  ]
  const resourceRows: KvRow[] = [
    {
      label: "vCPUs",
      value: vm.vcpus != null ? <span className="num">{vm.vcpus}</span> : dash,
    },
    {
      label: "Memory",
      value:
        vm.memory_mb != null ? (
          <span className="num">{formatMemory(vm.memory_mb)}</span>
        ) : (
          dash
        ),
    },
    {
      label: "Disk",
      value:
        vm.disk_gb != null ? (
          <span className="num">{vm.disk_gb} GB</span>
        ) : (
          dash
        ),
    },
  ]
  const placementRows: KvRow[] = [
    {
      label: "Cluster",
      value: (
        <Link
          to="/clusters/$id"
          params={{ id: vm.cluster.id }}
          className="text-primary hover:underline"
        >
          {vm.cluster.name}
        </Link>
      ),
    },
    {
      label: "Host device",
      value: vm.device ? (
        <Link
          to="/devices/$id"
          params={{ id: vm.device.id }}
          className="text-primary hover:underline"
        >
          {vm.device.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Site",
      value: vm.site ? (
        <Link
          to="/sites/$id"
          params={{ id: vm.site.id }}
          className="text-primary hover:underline"
        >
          {vm.site.name}
        </Link>
      ) : (
        dash
      ),
    },
  ]
  const managementRows: KvRow[] = [
    {
      label: "Primary IP",
      value: vm.primary_ip ? (
        <Link
          to="/ips/$id"
          params={{ id: vm.primary_ip.id }}
          className="font-mono text-[13px] text-primary hover:underline"
        >
          {vm.primary_ip.ip_address}
        </Link>
      ) : (
        dash
      ),
      copy: vm.primary_ip?.ip_address,
    },
    {
      label: "DNS name",
      value: mono(vm.primary_ip?.dns_name),
      copy: vm.primary_ip?.dns_name || undefined,
    },
  ]
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Virtual machine" rows={vmRows} />
        <KvCard title="Resources" rows={resourceRows} />
        <KvCard title="Placement" rows={placementRows} />
        <KvCard title="Management" rows={managementRows} />
      </div>
      <CustomFieldValues model="virtualmachine" values={vm.custom_fields} />
    </div>
  )
}
