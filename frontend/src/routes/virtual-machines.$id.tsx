import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { PlatformCell } from "@/components/cells/platform-cell"
import { LifecycleBar, hasLifetime } from "@/components/cells/lifecycle-cell"
import {
  SoftwareVersionSourceText,
  SoftwareVersionText,
} from "@/components/cells/software-version-cell"
import { CatalogCell } from "@/components/cells/catalog-cell"
import { SpecSheetButton } from "@/components/spec-sheet-button"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { GitCompareArrows, Pencil, RefreshCw, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type VirtualDisk, type VirtualMachine } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { CustomFieldValues } from "@/components/custom-field-display"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { DnsNameLink } from "@/components/cells/dns-name-link"
import { QueryError } from "@/components/query-error"
import { VmDeleteDialog } from "@/components/vm-delete-dialog"
import { Badge } from "@/components/ui/badge"
import { DriftDot } from "@/components/monitoring/device-drift-badge"
import { StatusBadge } from "@/components/status-badge"
import { PowerBadge } from "@/components/cells/power-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { useMe } from "@/lib/use-me"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { VMInterfacesPane } from "@/components/vm-interfaces-pane"
import { VmSnmpCard } from "@/components/vm-snmp-card"
import { VmTopologyCard } from "@/components/vm-topology-card"
import { CertificatesPanel } from "@/components/monitoring/certificates-panel"
import { ConfigContextPanel } from "@/components/config-context-panel"
import { VmConfigBackups } from "@/components/oxidized/device-config-backups"
import { ServicesPane } from "@/components/services-pane"
import { InstalledSoftwarePane } from "@/components/installed-software-pane"
import { ApplicationFlowPane } from "@/components/application-flow-pane"
import { IpMonitoring } from "@/components/monitoring/ip-monitoring"
import {
  MonitoringBar,
  MonitoringHeaderBadge,
} from "@/components/monitoring/monitoring-bar"
import { KvCard, type KvRow, mono, dash } from "@/components/kv-card"
import { OverviewTable } from "@/components/overview-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import {
  SoftwareSummaryCard,
  useSoftwareSummary,
} from "@/components/software-summary-card"
import { ObjectSlaPanel } from "@/components/monitoring/sla-add"
import { PrtgMonitoringRow } from "@/components/prtg/monitoring-row"
import {
  PrtgSensorsTab,
  linkedSensorCount,
  usePrtgLinks,
} from "@/components/prtg/sensors-tab"
import { RoutingPanel } from "@/components/routing/device-routing-panel"
import { PinnedSensorsCard } from "@/components/prtg/sensor-pins"

export const Route = createFileRoute("/virtual-machines/$id")({
  component: VmDetail,
  // Typed so other pages can deep-link a tab (the MAC pages point at
  // Components); useUrlTab validates the value itself.
  // `?sensor=` opens that PRTG sensor's panel on the Sensors tab.
  validateSearch: (
    s: Record<string, unknown>
  ): { tab?: string; sensor?: string; state?: string } => ({
    ...(typeof s.tab === "string" ? { tab: s.tab } : {}),
    ...(typeof s.sensor === "string" ? { sensor: s.sensor } : {}),
    // The monitoring bar's filter, on the Monitoring and Sensors tabs.
    ...(typeof s.state === "string" && s.state ? { state: s.state } : {}),
  }),
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
  const software = useSoftwareSummary({ kind: "vm", id: vm.id })
  const [tab, setTab] = useUrlTab<
    | "overview"
    | "components"
    | "services"
    | "software"
    | "flows"
    | "routing"
    | "monitoring"
    | "sensors"
    | "snmp"
    | "certificates"
    | "config"
    | "journal"
    | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<VirtualMachine | null>(null)
  const openDelete = useCallback(() => setDeleting(vm), [vm])
  // PRTG's sensors get a tab once PRTG has a device for this VM; the links
  // come back empty while the integration is off.
  const prtgLinks = usePrtgLinks({ virtual_machine: vm.id })
  const hasPrtg = (prtgLinks.data ?? []).length > 0
  const search = Route.useSearch()
  const openSensor = search.sensor
  const selectSensor = useCallback(
    (sensor: string | null) =>
      nav({
        to: "/virtual-machines/$id",
        params: { id: vm.id },
        search: { ...search, sensor: sensor ?? undefined },
        replace: true,
      }),
    [nav, search, vm.id]
  )
  const setStateFilter = useCallback(
    (state: string | null) =>
      nav({
        to: "/virtual-machines/$id",
        params: { id: vm.id },
        search: { ...search, state: state ?? undefined },
        replace: true,
      }),
    [nav, search, vm.id]
  )
  const goBack = useCallback(
    () => nav({ to: "/virtual-machines", search: { device: undefined } }),
    [nav]
  )

  return (
    <DetailShell
      backTo="/virtual-machines"
      backLabel="Virtual machines"
      title={vm.name}
      presence={{ type: "virtualmachine", id: vm.id }}
      actions={
        <>
          <SpecSheetButton kind="vm" id={vm.id} />
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
        <DetailHero
          title={vm.name}
          badges={
            <>
              <StatusBadge status={vm.status} />
              <PowerBadge state={vm.power_state} />
              <MonitoringHeaderBadge target={{ virtual_machine: vm.id }} />
              {vm.synced_from && (
                <Link
                  to="/virtualization-sources/$id"
                  params={{ id: vm.synced_from_id! }}
                >
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <RefreshCw className="h-3 w-3" />
                    {vm.synced_from}
                  </Badge>
                </Link>
              )}
              {vm.drift_count > 0 && (
                <Badge variant="warning" className="gap-1 text-[10px]">
                  <GitCompareArrows className="h-3 w-3" />
                  {vm.drift_count} drift
                </Badge>
              )}
            </>
          }
          tags={
            vm.tags.length > 0 && (
              <TagList tags={vm.tags} listTo="/virtual-machines" />
            )
          }
          description={vm.description}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "components",
          // Same amber dot devices use for component drift - this is the same
          // question ("does what we hold match the real thing?"), so it should
          // look the same.
          label: (
            <>
              Components
              {vm.drift_count > 0 && <DriftDot />}
            </>
          ),
          count: vm.interface_count,
        },
        { value: "services", label: "Services", count: vm.service_count },
        {
          value: "software",
          label: "Software",
          // The Overview card's query is live after an edit on the tab; the
          // payload's figure stands in until it lands.
          count: software.data?.count ?? vm.install_count,
        },
        ...(canDo("applicationflow", "view")
          ? [{ value: "flows", label: "Flows" }]
          : []),
        {
          value: "routing",
          label: "Routing",
          count: vm.routing_count || undefined,
        },
        { value: "monitoring", label: "Monitoring" },
        ...(hasPrtg
          ? [
              {
                value: "sensors",
                label: "Sensors",
                count: linkedSensorCount(prtgLinks.data) || undefined,
              },
            ]
          : []),
        { value: "snmp", label: "SNMP" },
        {
          value: "certificates",
          label: "Certificates",
          count: vm.certificate_count,
        },
        { value: "config", label: "Config" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <VmOverview vm={vm} />
      </DetailTab>
      <DetailTab value="components">
        <VMInterfacesPane vmId={vm.id} vmName={vm.name} />
      </DetailTab>
      <DetailTab value="routing">
        <RoutingPanel owner={{ kind: "vm", id: vm.id, name: vm.name }} />
      </DetailTab>
      <DetailTab value="config">
        <div className="space-y-6">
          <VmConfigBackups vmId={vm.id} />
          <ConfigContextPanel endpoint="virtual-machines" id={vm.id} />
        </div>
      </DetailTab>
      <DetailTab value="services">
        <ServicesPane parent={{ kind: "vm", id: vm.id }} />
      </DetailTab>
      <DetailTab value="software">
        <InstalledSoftwarePane parent={{ kind: "vm", id: vm.id }} />
      </DetailTab>
      <DetailTab value="flows">
        <ApplicationFlowPane scope={{ kind: "vm", id: vm.id }} />
      </DetailTab>
      <DetailTab value="monitoring">
        <div className="mb-6">
          <ObjectSlaPanel objectType="api.virtualmachine" objectId={vm.id} />
        </div>
        {vm.primary_ip ? (
          <IpMonitoring
            ip={{
              id: vm.primary_ip.id,
              ip_address: vm.primary_ip.ip_address,
            }}
            state={search.state}
            onState={setStateFilter}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Set a primary IP for this VM to monitor it.{" "}
            <Link
              to="/virtual-machines/$id/edit"
              params={{ id: vm.id }}
              className="link"
            >
              Edit VM
            </Link>
          </p>
        )}
        <div className="mt-6 empty:hidden">
          <PrtgMonitoringRow
            parent={{ virtual_machine: vm.id }}
            prtgSync={vm.prtg_sync}
            sensorsLink={(children, state) => (
              <Link
                to="/virtual-machines/$id"
                params={{ id: vm.id }}
                search={{ tab: "sensors", state }}
                className="inline-flex"
              >
                {children}
              </Link>
            )}
          />
        </div>
      </DetailTab>
      <DetailTab value="sensors">
        <PrtgSensorsTab
          parent={{ virtual_machine: vm.id }}
          selected={openSensor}
          onSelect={selectSensor}
          state={search.state}
          onState={setStateFilter}
        />
      </DetailTab>
      <DetailTab value="snmp">
        <VmSnmpCard vmId={vm.id} />
      </DetailTab>
      <DetailTab value="certificates">
        <CertificatesPanel objectType="api.virtualmachine" objectId={vm.id} />
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

// The default "Overview" tab - VM facts in labelled cards with copy
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
    ...(vm.power_state
      ? [
          {
            label: "Power",
            value: (
              <span className="flex items-center gap-2">
                <PowerBadge state={vm.power_state} />
                {vm.power_state_at && (
                  <span className="text-xs text-muted-foreground">
                    as of <TimeCell iso={vm.power_state_at} />
                  </span>
                )}
              </span>
            ),
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Synced from",
      value: vm.synced_from ? (
        <Link
          to="/virtualization-sources/$id"
          params={{ id: vm.synced_from_id! }}
          className="link"
        >
          {vm.synced_from}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Role",
      value: (
        <CatalogCell
          value={vm.role}
          to="/device-roles/$id"
          params={vm.role ? { id: vm.role.id } : undefined}
        />
      ),
    },
    {
      label: "Platform",
      value: (
        <span className="inline-flex items-center gap-2">
          <PlatformCell platform={vm.platform} />
          <SoftwareVersionText
            version={vm.software_version}
            target={vm.platform?.target_version}
          />
          <SoftwareVersionSourceText
            source={vm.software_version_source}
            seenAt={vm.software_version_seen_at}
          />
        </span>
      ),
    },
    // The platform's effective dates: entered, else its end-of-life mapping.
    ...(hasLifetime(vm.platform)
      ? [
          {
            label: "OS support",
            value: <LifecycleBar item={vm.platform} />,
          } satisfies KvRow,
        ]
      : []),
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
          className="link"
        >
          {vm.cluster.name}
        </Link>
      ),
    },
    // The hypervisor's own grouping - a vApp, a pool, a folder. Only shown
    // when there is one; most estates do not group their VMs at all.
    ...(vm.group
      ? [
          {
            label: "Group",
            value: (
              <Link
                to="/vm-groups/$id"
                params={{ id: vm.group.id }}
                className="link"
              >
                {vm.group.name}
              </Link>
            ),
          },
        ]
      : []),
    {
      label: "Host device",
      value: vm.device ? (
        <Link to="/devices/$id" params={{ id: vm.device.id }} className="link">
          {vm.device.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Site",
      value: vm.site ? (
        <Link to="/sites/$id" params={{ id: vm.site.id }} className="link">
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
          className="link font-mono text-[13px]"
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
      value: <DnsNameLink name={vm.primary_ip?.dns_name} />,
      copy: vm.primary_ip?.dns_name || undefined,
    },
  ]
  return (
    <div className="space-y-6">
      <MonitoringBar
        target={{ virtual_machine: vm.id }}
        notify={vm.primary_ip ? { ip: vm.primary_ip.id } : undefined}
      />
      <PinnedSensorsCard
        parent={{ virtual_machine: vm.id }}
        sensorLink={(sensor, children) => (
          <Link
            to="/virtual-machines/$id"
            params={{ id: vm.id }}
            search={{ tab: "sensors", sensor }}
            className="block h-full"
          >
            {children}
          </Link>
        )}
      />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-6">
          <KvCard title="Virtual machine" rows={vmRows} />
          <KvCard title="Placement" rows={placementRows} />
        </div>
        <div className="min-w-0 space-y-6">
          <KvCard title="Resources" rows={resourceRows} />
          <SoftwareSummaryCard parent={{ kind: "vm", id: vm.id }} />
          <KvCard title="Management" rows={managementRows} />
        </div>
      </div>
      {vm.disks.length > 0 && <VmDisks disks={vm.disks} />}
      <VmTopologyCard
        vmId={vm.id}
        vmName={vm.name}
        syncedFromId={vm.synced_from_id}
      />
      <CustomFieldValues model="virtualmachine" values={vm.custom_fields} />
    </div>
  )
}

/** The VM's virtual disks (synced or operator-added), in the Overview's
 * table chrome. */
const DISK_COLUMNS: SimpleColumn<VirtualDisk>[] = [
  {
    id: "name",
    header: "Disk",
    cell: (d) => <span className="font-mono text-xs">{d.name || d.key}</span>,
  },
  {
    id: "size",
    header: "Size",
    cell: (d) =>
      d.size_gb != null ? <span className="num">{d.size_gb} GB</span> : dash,
  },
  {
    id: "storage",
    header: "Storage",
    cell: (d) => d.storage || dash,
  },
  {
    id: "controller",
    header: "Controller",
    cell: (d) =>
      d.controller ? <span className="uppercase">{d.controller}</span> : dash,
  },
]

function VmDisks({ disks }: { disks: VirtualDisk[] }) {
  return (
    <OverviewTable
      title="Disks"
      count={disks.length}
      columns={DISK_COLUMNS}
      data={disks}
      getRowKey={(d) => d.id}
    />
  )
}
