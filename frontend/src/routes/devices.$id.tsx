import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ShowOnFloorPlan } from "@/components/show-on-floor-plan"
import { ShowOnSiteMap } from "@/components/show-on-site-map"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  CopyPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Cable as CableIcon,
} from "lucide-react"
import { useCallback, useContext, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import { api, DEFAULT_DEVICE_FIELD_VISIBILITY } from "@/lib/api"
import type {
  Device,
  DeviceChecksResponse,
  DeviceFieldVisibility,
  IPAddress,
  Interface,
  PrefixIpStatus,
  Rack,
  VirtualChassis,
} from "@/lib/api"
import { RackElevation } from "@/components/rack-elevation"
import { ObjectImages } from "@/components/object-images"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TagList } from "@/components/cells/tag-list"
import { SiteCell } from "@/components/cells/site-cell"
import {
  LifecycleBar,
  LifecycleFlag,
  lifecyclePct,
} from "@/components/cells/lifecycle-cell"
import { DataTable, selectionColumn } from "@/components/data-table"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import { KvCard, mono, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { Section } from "@/components/ui/section"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { CustomFieldValues } from "@/components/custom-field-display"
import { QueryError } from "@/components/query-error"
import { DeviceDeleteDialog } from "@/components/device-delete-dialog"
import { DeviceSyncTypeDialog } from "@/components/device-sync-type-dialog"
import { StatusBadge } from "@/components/status-badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { ContactsPanel } from "@/components/contacts-panel"
import { ConfigContextPanel } from "@/components/config-context-panel"
import { DeviceConfigRender } from "@/components/device-config-render"
import { DeviceDeployPanel } from "@/components/device-deploy-panel"
import { DeviceDriftPanel } from "@/components/device-drift-panel"
import { DeviceInventoryPanel } from "@/components/device-inventory-panel"
import {
  DeviceFaceplate,
  FaceplateLegend,
  useObservedPorts,
  useSavedFaceplate,
} from "@/components/device-faceplate"
import { DeviceBaysPane } from "@/components/device-bays-pane"
import { DeviceInventoryPane } from "@/components/device-inventory-pane"
import { DeviceModulesPane } from "@/components/device-modules-pane"
import { DevicePortsPane } from "@/components/device-ports-pane"
import {
  AddActionsContext,
  BarSlotContext,
  type AddAction,
} from "@/components/device-add-actions"
import {
  StackInterfacesTable,
  useStackInterfaces,
} from "@/components/vc-stack-interfaces"
import { DeviceConsolePane } from "@/components/device-console-pane"
import { DevicePowerPane } from "@/components/device-power-pane"
import { cableTint } from "@/components/cable-status-control"
import { buildIpColumns } from "@/components/columns/ip-columns"
import {
  buildInterfaceColumns,
  buildInterfaceActionsColumn,
  nestInterfaces,
  type NestedInterface,
} from "@/components/columns/interface-columns"
import { actionsColumn } from "@/components/columns/actions-column"
import { EmptyState } from "@/components/empty-state"
import { apiErrorToast } from "@/lib/api-toast"
import { DeviceMiniTopology } from "@/components/device-mini-topology"
import { MiniMap } from "@/components/site-map/mini-map"
import { DeviceTunnelsCard } from "@/components/device-tunnels-card"
import {
  InterfaceTraceDialog,
  type TraceTarget,
} from "@/components/interface-trace-dialog"
import { DeviceSnmpCard } from "@/components/device-snmp-card"
import { DeviceDriftCard } from "@/components/device-drift-card"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { ServicesPane } from "@/components/services-pane"
import {
  DeviceMonitoring,
  DeviceMonitoringBadge,
} from "@/components/monitoring/device-monitoring"
import { MixedStatusBadge } from "@/components/monitoring/mixed-status-badge"
import { AssignIpDialog } from "@/components/assign-ip-dialog"
import type { AssignIpTarget } from "@/components/assign-ip-dialog"
import { useMe, objCan } from "@/lib/use-me"

const DEVICE_TABS = [
  "overview",
  "ips",
  "components",
  "images",
  "snmp",
  "services",
  "contacts",
  "config",
  "journal",
  "history",
] as const
type DeviceTab = (typeof DEVICE_TABS)[number]

export const Route = createFileRoute("/devices/$id")({
  // `?tab=ports` deep-links a tab (e.g. a trace's front/rear port → Hardware).
  validateSearch: (s: Record<string, unknown>): { tab?: DeviceTab } =>
    typeof s.tab === "string" && DEVICE_TABS.includes(s.tab as DeviceTab)
      ? { tab: s.tab as DeviceTab }
      : {},
  component: DeviceDetail,
})

function DeviceDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["device", id],
    queryFn: () => api<Device>(`/api/devices/${id}/`),
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
  return <Body device={q.data} />
}

function Body({ device: d }: { device: Device }) {
  const nav = useNavigate()
  const { canDo } = useMe()
  // Prefer the object's constraint-aware per-object flag, fall back to type-level.
  const canEdit = objCan(d, "change", canDo("device", "change"))
  const canDelete = objCan(d, "delete", canDo("device", "delete"))
  const [deleting, setDeleting] = useState<Device | null>(null)
  const [syncingType, setSyncingType] = useState(false)
  const { tab: tabFromUrl } = Route.useSearch()
  const [tab, setTab] = useState<DeviceTab>(tabFromUrl ?? "overview")
  const goBack = useCallback(() => nav({ to: "/devices" }), [nav])

  return (
    <DetailShell
      backTo="/devices"
      backLabel="Devices"
      title={<span className="font-mono">{d.name}</span>}
      presence={{ type: "device", id: d.id }}
      actions={
        <>
          <ShowOnFloorPlan deviceId={d.id} rackId={d.rack?.id} />
          <ShowOnSiteMap
            deviceId={d.id}
            hasCoords={d.latitude != null && d.longitude != null}
          />
          {canEdit && d.device_type && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSyncingType(true)}
              title="Re-apply the device type's component templates to this device"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Sync from type
            </Button>
          )}
          {canDo("device", "add") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/devices/new" search={{ clone: d.id }}>
                <CopyPlus className="h-3.5 w-3.5" /> Clone
              </Link>
            </Button>
          )}
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/devices/$id/edit" params={{ id: d.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(d)}
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
              <div className="font-mono text-2xl font-semibold tracking-tight">
                {d.name}
              </div>
              <ViolationBadge objectId={d.id} prominent />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <StatusBadge status={d.status} />
              <DeviceMonitoringBadge deviceId={d.id} />
              {d.virtual_chassis && (
                <Badge variant="secondary" asChild>
                  <Link
                    to="/virtual-chassis/$id"
                    params={{ id: d.virtual_chassis.id }}
                  >
                    Stack: {d.virtual_chassis.name}
                    {d.vc_position != null && ` · pos ${d.vc_position}`}
                    {d.virtual_chassis.is_master && " · master"}
                  </Link>
                </Badge>
              )}
            </div>
            {d.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={d.tags} />
              </div>
            )}
            {d.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {d.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px] sm:grid-cols-3">
            <DetailStat label="Site" value={<SiteCell site={d.site} />} />
            <DetailStat
              label="Primary IP"
              value={
                d.primary_ip ? (
                  <Link
                    to="/ips/$id"
                    params={{ id: d.primary_ip.id }}
                    className="font-mono text-[13px] text-primary hover:underline"
                  >
                    {d.primary_ip.ip_address}
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
        { value: "ips", label: "IPs", count: d.ip_count },
        {
          value: "components",
          label: "Components",
          count:
            (d.interface_count || 0) +
              (d.hardware_count || 0) +
              (d.console_count || 0) +
              (d.power_count || 0) || undefined,
        },
        { value: "images", label: "Images" },
        { value: "snmp", label: "SNMP" },
        {
          value: "services",
          label: "Services",
          count: d.service_count || undefined,
        },
        { value: "contacts", label: "Contacts" },
        { value: "config", label: "Config" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as DeviceTab)}
    >
      <DetailTab value="overview">
        <DeviceOverview device={d} onTab={setTab} />
      </DetailTab>
      <DetailTab value="snmp">
        <div className="space-y-6">
          <DeviceDriftCard deviceId={d.id} />
          <DeviceSnmpCard deviceId={d.id} />
        </div>
      </DetailTab>
      <DetailTab value="config">
        <div className="space-y-6">
          <ConfigContextPanel endpoint="devices" id={d.id} />
          <DeviceInventoryPanel deviceId={d.id} />
          <DeviceConfigRender deviceId={d.id} bound={d.config_template} />
          <DeviceDeployPanel deviceId={d.id} />
          <DeviceDriftPanel deviceId={d.id} />
        </div>
      </DetailTab>
      <DetailTab value="ips">
        <DeviceIpsPane
          deviceId={d.id}
          deviceName={d.name}
          canAddIp={canDo("ipaddress", "add")}
          canAssignIp={canDo("ipaddress", "change")}
          canChangeDevice={canDo("device", "change")}
        />
      </DetailTab>
      <DetailTab value="components" bare>
        <DeviceComponents
          device={d}
          canSync={canEdit}
          canAddInterface={canDo("interface", "add")}
          canEditInterface={canDo("interface", "change")}
          canAddIp={canDo("ipaddress", "add")}
          canAssignIp={canDo("ipaddress", "change")}
        />
      </DetailTab>
      <DetailTab value="images">
        <ObjectImages apiBase={`/api/devices/${d.id}`} objectType="device" />
      </DetailTab>
      <DetailTab value="services">
        <ServicesPane
          parent={{ kind: "device", id: d.id }}
          parentHasPrimaryIp={!!d.primary_ip}
        />
      </DetailTab>
      <DetailTab value="contacts">
        <ContactsPanel objectType="api.device" objectId={d.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.device" objectId={d.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.device" objectId={d.id} />
      </DetailTab>

      <DeviceDeleteDialog
        device={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
      {d.device_type && (
        <DeviceSyncTypeDialog
          deviceId={d.id}
          deviceName={d.name}
          deviceTypeName={d.device_type.name}
          open={syncingType}
          onOpenChange={setSyncingType}
        />
      )}
    </DetailShell>
  )
}

// The default "Overview" tab — the device's facts laid out in labelled
// cards, then custom fields, then the monitoring summary.
// Consolidated "Components" tab: interfaces, console, power and hardware
// (bays/modules/inventory/ports) grouped under one compact sub-tab strip,
// mirroring the device-type page (minus the template helper text).
function DeviceComponents({
  device: d,
  canSync,
  canAddInterface,
  canEditInterface,
  canAddIp,
  canAssignIp,
}: {
  device: Device
  canSync: boolean
  canAddInterface: boolean
  canEditInterface: boolean
  canAddIp: boolean
  canAssignIp: boolean
}) {
  const [sub, setSub] = useState<
    "interfaces" | "console" | "power" | "hardware"
  >("interfaces")
  // Adds published by the mounted sub-pane(s), surfaced right-aligned in the bar.
  const [addMap, setAddMap] = useState<Record<string, AddAction[]>>({})
  const registerAdd = useCallback<(key: string, actions: AddAction[]) => void>(
    (key, actions) => {
      setAddMap((m) => {
        if (actions.length === 0) {
          if (!(key in m)) return m
          const next = { ...m }
          delete next[key]
          return next
        }
        return { ...m, [key]: actions }
      })
    },
    []
  )
  const barAdds = useMemo(() => Object.values(addMap).flat(), [addMap])
  // The bar's right-aligned action area — panes with a richer toolbar
  // (Interfaces) portal their buttons here so everything sits in one strip.
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null)
  return (
    <AddActionsContext.Provider value={registerAdd}>
      {/* Sub-tab bar as a flush full-width strip (matches the main tab strip),
          then the pane content padded below — the parent DetailTab is `bare` so
          there's no headroom above the bar. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-3 px-4 shadow-[inset_0_-1px_0_var(--border)] lg:px-6">
          <SegmentedTabs
            value={sub}
            onValueChange={(v) => setSub(v as typeof sub)}
            items={[
              {
                value: "interfaces",
                label: "Interfaces",
                count: d.interface_count,
              },
              {
                value: "console",
                label: "Console",
                count: d.console_count || undefined,
              },
              {
                value: "power",
                label: "Power",
                count: d.power_count || undefined,
              },
              {
                value: "hardware",
                label: "Hardware",
                count: d.hardware_count || undefined,
              },
            ]}
          />
          <div ref={setBarSlot} className="ml-auto flex items-center gap-2">
            {barAdds.length === 1 ? (
              <Button
                size="sm"
                disabled={barAdds[0].disabled}
                onClick={barAdds[0].onClick}
              >
                <Plus className="h-3.5 w-3.5" /> {barAdds[0].label}
              </Button>
            ) : barAdds.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm">
                    <Plus className="h-3.5 w-3.5" /> Add
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {barAdds.map((a, i) => (
                    <DropdownMenuItem
                      key={i}
                      disabled={a.disabled}
                      onSelect={a.onClick}
                    >
                      {a.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
        <BarSlotContext.Provider value={barSlot}>
          <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
            {sub === "interfaces" && (
              <DeviceInterfacesPane
                deviceId={d.id}
                virtualChassis={d.virtual_chassis}
                canAdd={canAddInterface}
                canEdit={canEditInterface}
                canSync={canSync}
                canAddIp={canAddIp}
                canAssignIp={canAssignIp}
              />
            )}
            {sub === "console" && <DeviceConsolePane deviceId={d.id} />}
            {sub === "power" && <DevicePowerPane deviceId={d.id} />}
            {sub === "hardware" && (
              <div className="space-y-8">
                <DeviceBaysPane deviceId={d.id} />
                <DeviceModulesPane deviceId={d.id} />
                <DeviceInventoryPane deviceId={d.id} />
                <DevicePortsPane deviceId={d.id} />
              </div>
            )}
          </div>
        </BarSlotContext.Provider>
      </div>
    </AddActionsContext.Provider>
  )
}

function DeviceOverview({
  device: d,
  onTab,
}: {
  device: Device
  onTab: (tab: "ips" | "components") => void
}) {
  const { humanIds } = useMe()
  // Admin-controlled field visibility — falls back to documented defaults if
  // the endpoint isn't up yet (404) or the request fails.
  const visibilityQuery = useQuery({
    queryKey: ["device-field-visibility"],
    queryFn: () => api<DeviceFieldVisibility>("/api/device-fields/"),
    staleTime: 10 * 60_000,
    retry: false,
  })
  const visibility = visibilityQuery.data ?? DEFAULT_DEVICE_FIELD_VISIBILITY

  const deviceRows: KvRow[] = [
    { label: "Name", value: mono(d.name), copy: d.name },
    {
      label: "Status",
      value: <StatusBadge status={d.status} />,
    },
    {
      label: "Role",
      value: d.role ? (
        <Link to="/device-roles/$id" params={{ id: d.role.id }}>
          <ColorBadge name={d.role.name} color={d.role.color || undefined} />
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Platform",
      value: d.platform ? (
        <span className="inline-flex items-center gap-2">
          {d.platform.name}
          <LifecycleFlag state={d.platform.lifecycle_state} />
        </span>
      ) : (
        dash
      ),
    },
    ...(d.platform && lifecyclePct(d.platform) !== null
      ? [
          {
            label: "OS support",
            value: <LifecycleBar item={d.platform} />,
          } satisfies KvRow,
        ]
      : []),
    { label: "Description", value: d.description || dash },
    ...(visibility.comments
      ? [
          {
            label: "Comments",
            value: d.comments ? (
              <span className="whitespace-pre-wrap">{d.comments}</span>
            ) : (
              dash
            ),
          } satisfies KvRow,
        ]
      : []),
  ]
  const hardwareRows: KvRow[] = [
    ...(humanIds && d.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{d.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Type",
      value: d.device_type ? (
        <span className="inline-flex items-center gap-2">
          <Link
            to="/device-types/$id"
            params={{ id: d.device_type.id }}
            className="text-primary hover:underline"
          >
            {d.device_type.name}
          </Link>
          <LifecycleFlag state={d.device_type.lifecycle_state} />
        </span>
      ) : (
        dash
      ),
    },
    ...(d.device_type && lifecyclePct(d.device_type) !== null
      ? [
          {
            label: "Hardware support",
            value: <LifecycleBar item={d.device_type} />,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Serial number",
      value: mono(d.serial_number),
      copy: d.serial_number || undefined,
    },
    {
      label: "Asset tag",
      value: mono(d.asset_tag),
      copy: d.asset_tag || undefined,
    },
    { label: "Height", value: <span className="num">{d.u_height} U</span> },
    ...(visibility.airflow
      ? [
          {
            label: "Airflow",
            value: d.airflow ? (
              <span className="capitalize">{d.airflow.replace(/-/g, " ")}</span>
            ) : (
              dash
            ),
          } satisfies KvRow,
        ]
      : []),
  ]
  const locationRows: KvRow[] = [
    { label: "Site", value: d.site?.name ?? dash },
    ...(visibility.location
      ? [
          {
            label: "Location",
            value: d.location ? (
              <Link
                to="/locations/$id"
                params={{ id: d.location.id }}
                className="text-primary hover:underline"
              >
                {d.location.name}
              </Link>
            ) : (
              dash
            ),
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Rack",
      value: d.rack ? (
        <Link
          to="/racks/$id"
          params={{ id: d.rack.id }}
          className="text-primary hover:underline"
        >
          {d.rack.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Position",
      value:
        d.position != null ? (
          <span className="num">
            U{d.position}
            {d.rack_width === "half" && (
              <span className="text-muted-foreground">
                {" "}
                · {d.rack_side || "left"} half
              </span>
            )}
          </span>
        ) : (
          dash
        ),
    },
    { label: "Face", value: d.face || dash },
    ...(visibility.latitude || visibility.longitude
      ? [
          {
            label: "Coordinates",
            value:
              (visibility.latitude && d.latitude) ||
              (visibility.longitude && d.longitude) ? (
                <span className="font-mono text-[13px]">
                  {visibility.latitude ? (d.latitude ?? "—") : "—"},{" "}
                  {visibility.longitude ? (d.longitude ?? "—") : "—"}
                </span>
              ) : (
                dash
              ),
          } satisfies KvRow,
        ]
      : []),
  ]
  const managementRows: KvRow[] = [
    ...(visibility.cluster
      ? [
          {
            label: "Cluster",
            value: d.cluster ? (
              <Link
                to="/clusters/$id"
                params={{ id: d.cluster.id }}
                className="text-primary hover:underline"
              >
                {d.cluster.name}
              </Link>
            ) : (
              dash
            ),
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Config template",
      value: d.config_template?.resolved ? (
        <span>
          {d.config_template.own?.name ?? d.config_template.resolved.name}
          {!d.config_template.own && (
            <span className="text-muted-foreground"> (from role/platform)</span>
          )}
        </span>
      ) : (
        dash
      ),
    },
    {
      label: "DNS name",
      value: mono(d.primary_ip?.dns_name),
      copy: d.primary_ip?.dns_name || undefined,
    },
    {
      label: "IP addresses",
      value: (
        <button
          type="button"
          onClick={() => onTab("ips")}
          className="num text-primary hover:underline"
        >
          {d.ip_count}
        </button>
      ),
    },
    {
      label: "Interfaces",
      value: (
        <button
          type="button"
          onClick={() => onTab("components")}
          className="num text-primary hover:underline"
        >
          {d.interface_count}
        </button>
      ),
    },
  ]
  return (
    <div className="space-y-6">
      {/* Monitoring roll-up first, mirroring the IP detail page. */}
      <DeviceMonitoring deviceId={d.id} />

      {/* Masonry: every card flows into two auto-balanced columns and packs
          tight against the card above it — no fixed grid rows, so a short card
          (Panel) is followed immediately by the next (the rack snaps up under it
          instead of leaving the void between them). Custom fields render as
          cards here too, alongside the other tables. */}
      <div className="columns-1 gap-6 lg:columns-2 [&>*]:mb-6 [&>*]:break-inside-avoid">
        <KvCard title="Device" rows={deviceRows} />
        <KvCard title="Management" rows={managementRows} />
        <KvCard title="Hardware" rows={hardwareRows} />
        <KvCard title="Location" rows={locationRows} />
        <CustomFieldValues
          model="device"
          values={d.custom_fields}
          layout="cards"
        />
        <DeviceFrontPanel device={d} />
        {d.latitude !== null && d.longitude !== null && (
          <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <h2 className="text-sm font-semibold">Location</h2>
              <div className="flex items-center gap-1.5">
                <ShowOnSiteMap deviceId={d.id} hasCoords />
                <ShowOnFloorPlan deviceId={d.id} rackId={d.rack?.id} />
              </div>
            </div>
            <div className="h-64 overflow-hidden rounded-b-lg">
              <MiniMap className="h-full w-full" focusDeviceId={d.id} />
            </div>
          </div>
        )}
        <DeviceMiniTopology deviceId={d.id} />
        <DeviceTunnelsCard deviceId={d.id} />
        <DeviceTypeFaces deviceType={d.device_type} />
        <DeviceRackCard device={d} />
      </div>
    </div>
  )
}

/** Where the device physically sits — its rack drawn with this device
 * highlighted, front and rear side by side (compact). Hidden for unracked
 * devices. */
function DeviceRackCard({ device }: { device: Device }) {
  const rackId = device.rack?.id
  const q = useQuery({
    queryKey: ["rack", rackId],
    queryFn: () => api<Rack>(`/api/racks/${rackId}/`),
    enabled: !!rackId,
    staleTime: 60_000,
  })
  if (!rackId || device.position == null) return null
  if (!q.data) return null
  return (
    <Section
      title={
        <span>
          Rack ·{" "}
          <Link
            to="/racks/$id"
            params={{ id: rackId }}
            className="text-primary hover:underline"
          >
            {device.rack!.name}
          </Link>
        </span>
      }
    >
      <div className="flex gap-6 overflow-x-auto pb-1">
        {(["front", "rear"] as const).map((face) => (
          <div key={face} className="flex flex-col items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              {face}
            </span>
            <RackElevation
              rack={q.data}
              face={face}
              mode="names"
              highlightDeviceId={device.id}
              showHeader={false}
              scale={0.42}
            />
          </div>
        ))}
      </div>
    </Section>
  )
}

/** The device drawn as hardware — its ports laid out at mm-true scale,
 * colored by state/speed. Uses the device type's saved faceplate layout when
 * one exists (with a Front/Rear toggle when the layout has a rear side);
 * hidden when the device has no physical interfaces. */
function DeviceFrontPanel({ device }: { device: Device }) {
  const deviceId = device.id
  const [side, setSide] = useState<"front" | "rear">("front")
  const q = useQuery({
    queryKey: ["device-interfaces", deviceId],
    queryFn: () =>
      api<ListResp<Interface>>(`/api/devices/${deviceId}/interfaces/`),
  })
  // Live SNMP overlay — read-only observed facts on top of the intent.
  const observed = useObservedPorts(deviceId)
  const savedDoc = useSavedFaceplate(device.device_type?.id)
  const hasRear = (savedDoc?.rear?.length ?? 0) > 0
  const physical = (q.data?.results ?? []).filter((i) => !i.virtual)
  if (physical.length === 0) return null
  const showRear = side === "rear"
  return (
    <Section
      title="Panel"
      actions={
        <SegmentedTabs
          value={side}
          onValueChange={setSide}
          items={[
            { value: "front", label: "Front" },
            { value: "rear", label: "Rear" },
          ]}
        />
      }
    >
      <div className="rounded-lg border border-border bg-card p-4 lg:p-5">
        {showRear && !hasRear ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No rear panel defined for this device type.
          </p>
        ) : (
          <>
            <DeviceFaceplate
              interfaces={physical}
              deviceId={deviceId}
              deviceTypeId={device.device_type?.id}
              vcPosition={device.vc_position}
              side={side}
              fit="container"
              observed={observed}
            />
            <FaceplateLegend className="mt-2" observed={!!observed} />
          </>
        )}
      </div>
    </Section>
  )
}

// Read-only rack-face images inherited from the device's type. Rendered only
// when the type carries at least one image; managing them lives on the device
// type page.
function DeviceTypeFaces({
  deviceType,
}: {
  deviceType: Device["device_type"]
}) {
  const [side, setSide] = useState<"front" | "rear">("front")
  const front = deviceType?.front_image ?? ""
  const rear = deviceType?.rear_image ?? ""
  if (!front && !rear) return null
  const hasBoth = !!front && !!rear
  // With both images, honour the toggle; with only one, always show it.
  const shownSide: "front" | "rear" = hasBoth ? side : front ? "front" : "rear"
  const src = shownSide === "rear" ? rear : front
  return (
    <Section
      title="Rack-face image"
      actions={
        hasBoth ? (
          <SegmentedTabs
            value={side}
            onValueChange={setSide}
            items={[
              { value: "front", label: "Front" },
              { value: "rear", label: "Rear" },
            ]}
          />
        ) : undefined
      }
    >
      <div className="p-4 lg:p-5">
        <div className="flex aspect-[6/1] w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
          <img
            src={src}
            alt={`${shownSide} of ${deviceType?.name ?? "device"}`}
            className="h-full w-full object-contain"
          />
        </div>
      </div>
    </Section>
  )
}

interface ListResp<T> {
  count: number
  results: T[]
}

function DeviceIpsPane({
  deviceId,
  deviceName,
  canAddIp,
  canAssignIp,
  canChangeDevice,
}: {
  deviceId: string
  deviceName: string
  canAddIp: boolean
  canAssignIp: boolean
  canChangeDevice: boolean
}) {
  const qc = useQueryClient()
  const [assignTarget, setAssignTarget] = useState<AssignIpTarget | null>(null)
  const q = useQuery({
    queryKey: ["device-ips", deviceId],
    queryFn: () => api<ListResp<IPAddress>>(`/api/devices/${deviceId}/ips/`),
  })
  const rows = q.data?.results ?? []

  // Per-IP monitoring status — shares the device-checks fetch with the header
  // badge and Overview summary (same query key). Keyed by IP id for the column.
  const checksQ = useQuery({
    queryKey: ["device-checks", deviceId],
    queryFn: () =>
      api<DeviceChecksResponse>(`/api/monitoring/devices/${deviceId}/checks/`),
  })
  const monByIp = useMemo(() => {
    const m: Record<string, PrefixIpStatus> = {}
    for (const ip of checksQ.data?.ips ?? []) m[ip.id] = ip
    return m
  }, [checksQ.data])

  // PATCH the device's primary/secondary/management slots, then refresh both
  // the IPs list (designation badges) and the device header.
  const patchDesignation = useCallback(
    async (body: Record<string, string | null>, successMsg: string) => {
      try {
        await api(`/api/devices/${deviceId}/`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["device-ips", deviceId] }),
          qc.invalidateQueries({ queryKey: ["device", deviceId] }),
        ])
        toast.success(successMsg)
      } catch (e) {
        apiErrorToast(e, "Couldn't update designation")
      }
    },
    [deviceId, qc]
  )

  const columns = useMemo<ColumnDef<IPAddress>[]>(() => {
    const cols = buildIpColumns<IPAddress>({
      include: ["ip", "status", "role", "description"],
      copyButton: true,
    })
    const insertAfter = (id: string, ...extra: ColumnDef<IPAddress>[]) => {
      const i = cols.findIndex((c) => c.id === id)
      cols.splice(i + 1, 0, ...extra)
    }
    insertAfter("ip", {
      id: "designation",
      header: "Designation",
      cell: ({ row }) => {
        const ip = row.original
        if (ip.is_primary_for_device)
          return <Badge variant="success">★ Primary</Badge>
        if (ip.is_oob_for_device) return <Badge variant="secondary">Mgmt</Badge>
        if (ip.is_secondary_for_device)
          return <Badge variant="secondary">2nd</Badge>
        return <span className="text-muted-foreground">—</span>
      },
    })
    insertAfter("status", {
      id: "monitoring",
      header: "Monitoring",
      cell: ({ row }) => {
        const e = monByIp[row.original.id]
        if (!e || !e.status)
          return <span className="text-muted-foreground">—</span>
        return (
          <span title={`${e.checks} check${e.checks === 1 ? "" : "s"}`}>
            <MixedStatusBadge counts={e.counts} status={e.status} />
          </span>
        )
      },
    })
    if (canChangeDevice) {
      cols.push(
        actionsColumn<IPAddress>({
          extra: (ip) => <DesignationMenu ip={ip} onPatch={patchDesignation} />,
        })
      )
    }
    return cols
  }, [canChangeDevice, patchDesignation, monByIp])
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  return (
    <div className="space-y-3">
      {(canAddIp || canAssignIp) && (
        <div className="flex justify-end gap-2">
          {canAssignIp && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAssignTarget({ deviceId, deviceName })}
            >
              Assign IP
            </Button>
          )}
          {canAddIp && (
            <Button size="sm" asChild>
              <Link to="/ips/new" search={{ device: deviceId }}>
                + Add IP
              </Link>
            </Button>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="No IPs yet.">
          No IPs assigned to this device.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="ip-embedded"
        />
      )}
      <AssignIpDialog
        target={assignTarget}
        onOpenChange={(o) => !o && setAssignTarget(null)}
      />
    </div>
  )
}

// Per-IP "…" menu for the device IPs pane — sets/clears the device's
// primary/secondary/management designation slots. Rendered in the
// RowActions extra slot.
function DesignationMenu({
  ip,
  onPatch,
}: {
  ip: IPAddress
  onPatch: (body: Record<string, string | null>, successMsg: string) => void
}) {
  const hasDesignation =
    ip.is_primary_for_device ||
    ip.is_secondary_for_device ||
    ip.is_oob_for_device
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7">
          <MoreHorizontal className="h-3.5 w-3.5" />
          <span className="sr-only">Open actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={ip.is_primary_for_device}
          onSelect={() =>
            onPatch(
              { primary_ip_id: ip.id },
              `${ip.ip_address} set as primary IP`
            )
          }
        >
          Set as primary
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={ip.is_secondary_for_device}
          onSelect={() =>
            onPatch(
              { secondary_ip_id: ip.id },
              `${ip.ip_address} set as secondary IP`
            )
          }
        >
          Set as secondary
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={ip.is_oob_for_device}
          onSelect={() =>
            onPatch(
              { oob_ip_id: ip.id },
              `${ip.ip_address} set as management IP`
            )
          }
        >
          Set as management
        </DropdownMenuItem>
        {hasDesignation && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                const body: Record<string, string | null> = {}
                if (ip.is_primary_for_device) body.primary_ip_id = null
                if (ip.is_secondary_for_device) body.secondary_ip_id = null
                if (ip.is_oob_for_device) body.oob_ip_id = null
                onPatch(body, `Cleared designation for ${ip.ip_address}`)
              }}
            >
              Clear designation
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DeviceInterfacesPane({
  deviceId,
  virtualChassis,
  canAdd,
  canEdit,
  canSync,
  canAddIp,
  canAssignIp,
}: {
  deviceId: string
  virtualChassis: Device["virtual_chassis"]
  canAdd: boolean
  canEdit: boolean
  canSync: boolean
  canAddIp: boolean
  canAssignIp: boolean
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canConnect = canDo("cable", "add")
  const canChangeCable = canDo("cable", "change")
  const barSlot = useContext(BarSlotContext)
  const [assignTarget, setAssignTarget] = useState<AssignIpTarget | null>(null)
  const [traceTarget, setTraceTarget] = useState<TraceTarget | null>(null)
  // Every device — master included — defaults to its OWN interface table (the
  // normal per-device table with add/edit/sync actions). The combined
  // whole-stack view (NetBox-style) stays one click away via the toggle.
  const [scope, setScope] = useState<"member" | "stack">("member")
  const vcQuery = useQuery({
    queryKey: ["virtual-chassis", virtualChassis?.id],
    queryFn: () =>
      api<VirtualChassis>(`/api/virtual-chassis/${virtualChassis!.id}/`),
    enabled: !!virtualChassis,
  })
  const stackMembers = useMemo(
    () =>
      [...(vcQuery.data?.members ?? [])].sort((a, b) => {
        const pa = a.vc_position ?? Number.MAX_SAFE_INTEGER
        const pb = b.vc_position ?? Number.MAX_SAFE_INTEGER
        return pa - pb || a.name.localeCompare(b.name)
      }),
    [vcQuery.data]
  )
  const stackIfaces = useStackInterfaces(
    virtualChassis && scope === "stack" ? stackMembers : []
  )
  const q = useQuery({
    queryKey: ["device-interfaces", deviceId],
    queryFn: () =>
      api<ListResp<Interface>>(`/api/devices/${deviceId}/interfaces/`),
  })

  // "Sync from SNMP": create observed interfaces, fix MAC/admin drift, and
  // assign observed IPs in one shot (the source-of-truth catch-up).
  const sync = useMutation({
    mutationFn: () =>
      api<{
        interfaces_created: number
        interfaces_updated: number
        ips_assigned: number
        ips_skipped: number
        vlans_assigned: number
      }>(`/api/monitoring/devices/${deviceId}/snmp/sync/`, { method: "POST" }),
    onSuccess: (r) => {
      const bits = [
        r.interfaces_created && `${r.interfaces_created} interface(s) added`,
        r.interfaces_updated && `${r.interfaces_updated} updated`,
        r.ips_assigned && `${r.ips_assigned} IP(s) assigned`,
        r.vlans_assigned && `${r.vlans_assigned} VLAN(s) set`,
      ].filter(Boolean)
      toast.success(
        bits.length
          ? `Synced — ${bits.join(", ")}`
          : "Already in sync with SNMP"
      )
      if (r.ips_skipped)
        toast.info(
          `${r.ips_skipped} IP(s) skipped — no containing prefix (add the prefix, then sync again).`
        )
      qc.invalidateQueries({ queryKey: ["device-interfaces", deviceId] })
      qc.invalidateQueries({ queryKey: ["device-ips", deviceId] })
      qc.invalidateQueries({ queryKey: ["device", deviceId] })
      qc.invalidateQueries({ queryKey: ["device-snmp-drift", deviceId] })
    },
    onError: (e) => apiErrorToast(e),
  })
  const rows = useMemo(() => nestInterfaces(q.data?.results ?? []), [q.data])
  const [selIfaces, setSelIfaces] = useState<NestedInterface[]>([])
  const columns = useMemo<ColumnDef<NestedInterface>[]>(() => {
    // Same columns + same row actions as the whole-stack table (shared builders)
    // — the two views must never drift apart.
    const actions = buildInterfaceActionsColumn<NestedInterface>({
      deviceIdFor: () => deviceId,
      canAddIp,
      canAssignIp,
      canEdit,
      canChangeCable,
      canConnect,
      onTrace: setTraceTarget,
      onAssignIp: setAssignTarget,
    })
    return [
      ...(canEdit ? [selectionColumn<NestedInterface>()] : []),
      ...buildInterfaceColumns(),
      ...(actions ? [actions] : []),
    ]
  }, [deviceId, canAddIp, canAssignIp, canEdit, canChangeCable, canConnect])
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  return (
    <div className="space-y-3">
      {barSlot &&
        (canAdd || canSync || virtualChassis) &&
        createPortal(
          <>
            {virtualChassis && (
              // The canonical segmented control (never hand-rolled), so this
              // scope switch looks identical to every other tab strip.
              <SegmentedTabs
                className="mr-auto"
                value={scope}
                onValueChange={setScope}
                items={[
                  {
                    value: "member",
                    label: "This member",
                    count: q.data?.results.length,
                  },
                  {
                    value: "stack",
                    label: `Whole stack (${virtualChassis.name})`,
                    count: stackIfaces.count,
                  },
                ]}
              />
            )}
            {canSync && (
              <Button
                size="sm"
                variant="outline"
                disabled={sync.isPending}
                onClick={() => sync.mutate()}
                title="Create observed interfaces, fix MAC/status, and assign discovered IPs"
              >
                <RefreshCw
                  className={
                    "h-3.5 w-3.5 " + (sync.isPending ? "animate-spin" : "")
                  }
                />
                Sync from SNMP
              </Button>
            )}
            {canConnect && (
              <Button size="sm" variant="outline" asChild>
                <Link to="/cables/new">
                  <CableIcon className="h-3.5 w-3.5" /> Connect cable
                </Link>
              </Button>
            )}
            {canAdd && (
              <>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/interfaces/bulk" search={{ device: deviceId }}>
                    Bulk add
                  </Link>
                </Button>
                <Button size="sm" asChild>
                  <Link to="/interfaces/new" search={{ device: deviceId }}>
                    Add interface
                  </Link>
                </Button>
              </>
            )}
          </>,
          barSlot
        )}
      {virtualChassis && scope === "stack" ? (
        <StackInterfacesTable
          rows={stackIfaces.rows}
          loading={stackIfaces.loading || vcQuery.isLoading}
          error={stackIfaces.error ?? (vcQuery.error as Error | null)}
          highlightMemberId={deviceId}
          // Same row actions as "This member" — the dialogs below serve both
          // (Assign IP carries the row's own member id).
          actions={{
            canAddIp,
            canAssignIp,
            canEdit,
            canChangeCable,
            canConnect,
            onTrace: setTraceTarget,
            onAssignIp: setAssignTarget,
          }}
        />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No interfaces on this device yet.
        </p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          rowStyle={(r) => cableTint(r.cable?.status)}
          embedded
          onSelectedRowsChange={setSelIfaces}
        />
      )}
      <ComponentBulkBar
        endpoint="/api/interfaces/"
        kindLabel="interface"
        selected={selIfaces}
        onCleared={() => setSelIfaces([])}
        invalidate={[["device-interfaces", deviceId]]}
        fields={[
          { key: "enabled", label: "Enabled", kind: "bool" },
          {
            key: "type",
            label: "Type",
            kind: "choice",
            choices: "interface_types",
          },
          {
            key: "mode",
            label: "802.1Q mode",
            kind: "choice",
            choices: "interface_modes",
          },
          { key: "vlan_id", label: "Untagged VLAN", kind: "vlan" },
          { key: "vrf_id", label: "VRF", kind: "vrf" },
          { key: "mtu", label: "MTU", kind: "int" },
          { key: "speed", label: "Speed", kind: "text", hint: "e.g. 10G" },
          {
            key: "duplex",
            label: "Duplex",
            kind: "choice",
            choices: "interface_duplex",
          },
          { key: "mgmt_only", label: "Management only", kind: "bool" },
        ]}
        tags
        canDelete={canEdit}
      />
      <AssignIpDialog
        target={assignTarget}
        onOpenChange={(o) => !o && setAssignTarget(null)}
      />
      <InterfaceTraceDialog
        target={traceTarget}
        onOpenChange={(o) => !o && setTraceTarget(null)}
      />
    </div>
  )
}
