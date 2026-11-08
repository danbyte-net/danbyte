import { Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { MoreHorizontal } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DeviceChecksResponse, IPAddress, PrefixIpStatus } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useCurrentHref } from "@/lib/return-to"
import { AssignIpDialog } from "@/components/assign-ip-dialog"
import type { AssignIpTarget } from "@/components/assign-ip-dialog"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { actionsColumn } from "@/components/columns/actions-column"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { MixedStatusBadge } from "@/components/monitoring/mixed-status-badge"
import { ExternalStatusHover } from "@/components/monitoring/external-status"
import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// The IPs tab of a device, a VM or one of a device's interfaces: the shared
// IP table (buildIpColumns) plus the columns only this list has -
// Designation (the object's primary / secondary / management slot), Assigned
// to (device and VM) and Monitoring (device) - and the Assign IP / + Add IP
// buttons.

/** The object's address slots, by IP id. */
export interface IpSlots {
  primary?: string | null
  secondary?: string | null
  oob?: string | null
}

/** Whose IPs the pane lists. A device or VM lists every address it uses
 * (`?device=` / `?virtual_machine=`: assigned to it, to one of its
 * interfaces, or in one of its slots). An interface's IPs always sit on its
 * device, so the interface scope carries the device - designation and
 * monitoring are the device's. */
export type AssignedIpsScope =
  | { kind: "device"; deviceId: string; deviceName: string; slots?: IpSlots }
  | {
      kind: "interface"
      deviceId: string
      interfaceId: string
      interfaceName: string
    }
  | { kind: "vm"; vmId: string; vmName: string; slots?: IpSlots }

type OwnerScope = Extract<AssignedIpsScope, { kind: "device" | "vm" }>

interface ListResp<T> {
  count: number
  results: T[]
}

// One page holds every address an object uses.
const PAGE = 1000

/** The pane's rows query. A page that shows the count in its tab strip runs
 * the same query, so the two share one request. */
export function assignedIpsQuery(scope: AssignedIpsScope) {
  // ["device-ips", id], ["vm-ips", id] and ["interface-ips", id] are the
  // keys AssignIpDialog and the IP form refresh.
  if (scope.kind === "device")
    return {
      queryKey: ["device-ips", scope.deviceId],
      queryFn: () =>
        api<ListResp<IPAddress>>(
          `/api/ips/?device=${scope.deviceId}&page_size=${PAGE}`
        ),
    }
  if (scope.kind === "vm")
    return {
      queryKey: ["vm-ips", scope.vmId, "used"],
      queryFn: () =>
        api<ListResp<IPAddress>>(
          `/api/ips/?virtual_machine=${scope.vmId}&page_size=${PAGE}`
        ),
    }
  return {
    queryKey: ["interface-ips", scope.interfaceId],
    queryFn: () =>
      api<ListResp<IPAddress>>(`/api/interfaces/${scope.interfaceId}/ips/`),
  }
}

const SPEC = {
  device: { tableId: "device-ips", empty: "No IPs on this device." },
  vm: { tableId: "vm-ips", empty: "No IPs on this VM." },
  interface: {
    tableId: "interface-ips",
    empty: "No IPs assigned to this interface.",
  },
} as const

type Slot = "primary" | "oob" | "secondary"

const SLOT_LABEL: Record<Slot, string> = {
  primary: "primary",
  oob: "management",
  secondary: "secondary",
}

// Designation sorts primary first, unslotted last.
const SLOT_ORDER: Record<Slot | "none", number> = {
  primary: 0,
  oob: 1,
  secondary: 2,
  none: 3,
}

/** Which of the object's slots holds `ip`. A device or VM reads its own
 * slots - the address may be assigned elsewhere; an interface's rows carry
 * their device's flags. */
function slotOf(ip: IPAddress, scope: AssignedIpsScope): Slot | null {
  if (scope.kind === "interface") {
    if (ip.is_primary_for_device) return "primary"
    if (ip.is_oob_for_device) return "oob"
    if (ip.is_secondary_for_device) return "secondary"
    return null
  }
  const s = scope.slots ?? {}
  if (s.primary === ip.id) return "primary"
  if (s.oob === ip.id) return "oob"
  if (s.secondary === ip.id) return "secondary"
  return null
}

/** The row's assignment as this object sees it: on the object, on one of its
 * interfaces (a link to Components), or elsewhere - then the row is here
 * through one of the object's slots, and a hover says so. */
function AssignedTo({ ip, scope }: { ip: IPAddress; scope: OwnerScope }) {
  if (scope.kind === "device") {
    const iface = ip.assigned_interface
    if (iface && iface.device.id === scope.deviceId)
      return (
        <Link
          to="/devices/$id"
          params={{ id: scope.deviceId }}
          search={{ tab: "components" }}
          className="link text-xs"
        >
          {iface.name}
        </Link>
      )
    if (ip.assigned_device?.id === scope.deviceId)
      return <span className="text-xs">This device</span>
  } else {
    const iface = ip.assigned_vm_interface
    if (iface && iface.vm.id === scope.vmId)
      return (
        <Link
          to="/virtual-machines/$id"
          params={{ id: scope.vmId }}
          search={{ tab: "components" }}
          className="link text-xs"
        >
          {iface.name}
        </Link>
      )
    if (ip.assigned_vm?.id === scope.vmId)
      return <span className="text-xs">This VM</span>
  }
  const owner = ip.assigned_device ?? ip.assigned_vm ?? null
  const elsewhere = ip.assigned_device ? (
    <Link
      to="/devices/$id"
      params={{ id: ip.assigned_device.id }}
      className="link text-xs"
    >
      {ip.assigned_device.name}
    </Link>
  ) : ip.assigned_vm ? (
    <Link
      to="/virtual-machines/$id"
      params={{ id: ip.assigned_vm.id }}
      className="link text-xs"
    >
      {ip.assigned_vm.name}
    </Link>
  ) : null
  const slot = slotOf(ip, scope)
  if (!slot)
    return elsewhere ?? <span className="text-muted-foreground">-</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-xs text-muted-foreground">
          {elsewhere ?? "Unassigned"}
        </span>
      </TooltipTrigger>
      <TooltipContent variant="default">
        {owner
          ? `Used as ${SLOT_LABEL[slot]} address here, assigned to ${owner.name}`
          : `Used as ${SLOT_LABEL[slot]} address here, not assigned`}
      </TooltipContent>
    </Tooltip>
  )
}

export function AssignedIpsPane({
  scope,
  canAddIp,
  canAssignIp,
  canChangeDevice,
}: {
  scope: AssignedIpsScope
  canAddIp: boolean
  canAssignIp: boolean
  canChangeDevice: boolean
}) {
  // Monitoring and the designation menu are a device's.
  const deviceId = scope.kind === "vm" ? null : scope.deviceId
  const spec = SPEC[scope.kind]
  const qc = useQueryClient()
  const here = useCurrentHref()
  const [assignTarget, setAssignTarget] = useState<AssignIpTarget | null>(null)
  const q = useQuery(assignedIpsQuery(scope))
  const rows = q.data?.results ?? []

  // Per-IP monitoring status - shares the device-checks fetch with the header
  // badge and Overview summary (same query key). Keyed by IP id for the column.
  const checksQ = useQuery({
    queryKey: ["device-checks", deviceId],
    queryFn: () =>
      api<DeviceChecksResponse>(`/api/monitoring/devices/${deviceId}/checks/`),
    enabled: deviceId != null,
  })
  const monByIp = useMemo(() => {
    const m: Record<string, PrefixIpStatus | undefined> = {}
    for (const ip of checksQ.data?.ips ?? []) m[ip.id] = ip
    return m
  }, [checksQ.data])

  // PATCH the device's primary/secondary/management slots, then refresh the
  // IP lists (designation badges) and the device header.
  const patchDesignation = useCallback(
    async (body: Record<string, string | null>, successMsg: string) => {
      if (deviceId == null) return
      try {
        await api(`/api/devices/${deviceId}/`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["device-ips", deviceId] }),
          qc.invalidateQueries({ queryKey: ["interface-ips"] }),
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
      include: [
        "ip",
        "status",
        "dhcp",
        "role",
        "vlan",
        "zone",
        "scope",
        "dns",
        "switch",
        "switch_interface",
        "description",
        "tags",
        "updated",
      ],
      copyButton: true,
    })
    const insertAfter = (id: string, ...extra: ColumnDef<IPAddress>[]) => {
      const i = cols.findIndex((c) => c.id === id)
      cols.splice(i + 1, 0, ...extra)
    }
    insertAfter("ip", {
      id: "designation",
      header: "Designation",
      accessorFn: (ip) => SLOT_ORDER[slotOf(ip, scope) ?? "none"],
      cell: ({ row }) => {
        const slot = slotOf(row.original, scope)
        if (slot === "primary")
          return <Badge variant="success">★ Primary</Badge>
        if (slot === "oob") return <Badge variant="secondary">Mgmt</Badge>
        if (slot === "secondary") return <Badge variant="secondary">2nd</Badge>
        return <span className="text-muted-foreground">-</span>
      },
    })
    if (scope.kind !== "interface") {
      insertAfter("designation", {
        id: "assigned_to",
        header: "Assigned to",
        accessorFn: (ip) =>
          ip.assigned_interface?.name ??
          ip.assigned_vm_interface?.name ??
          ip.assigned_device?.name ??
          ip.assigned_vm?.name ??
          "",
        cell: ({ row }) => <AssignedTo ip={row.original} scope={scope} />,
      })
    }
    if (deviceId == null) return cols
    insertAfter("status", {
      id: "monitoring",
      header: "Monitoring",
      cell: ({ row }) => {
        const e = monByIp[row.original.id]
        if (!e || !e.status)
          return <span className="text-muted-foreground">-</span>
        return (
          <ExternalStatusHover entry={e}>
            <MixedStatusBadge counts={e.counts} status={e.status} />
          </ExternalStatusHover>
        )
      },
    })
    if (canChangeDevice) {
      cols.push(
        actionsColumn<IPAddress>({
          extra: (ip) => (
            <DesignationMenu
              ip={ip}
              slot={slotOf(ip, scope)}
              onPatch={patchDesignation}
            />
          ),
        })
      )
    }
    return cols
  }, [scope, deviceId, canChangeDevice, patchDesignation, monByIp])

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  return (
    <div className="space-y-3">
      {(canAddIp || canAssignIp) && (
        <div className="flex justify-end gap-2">
          {canAssignIp && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setAssignTarget(
                  scope.kind === "device"
                    ? { deviceId: scope.deviceId, deviceName: scope.deviceName }
                    : scope.kind === "vm"
                      ? { vmId: scope.vmId, vmName: scope.vmName }
                      : {
                          deviceId: scope.deviceId,
                          interfaceId: scope.interfaceId,
                          interfaceName: scope.interfaceName,
                        }
                )
              }
            >
              Assign IP
            </Button>
          )}
          {canAddIp && (
            <Button size="sm" asChild>
              <Link
                to="/ips/new"
                search={
                  scope.kind === "device"
                    ? { device: scope.deviceId }
                    : // Save and Cancel come back to this tab.
                      scope.kind === "vm"
                      ? { vm: scope.vmId, from: here }
                      : {
                          device: scope.deviceId,
                          interface: scope.interfaceId,
                          from: here,
                        }
                }
              >
                + Add IP
              </Link>
            </Button>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="No IPs yet.">{spec.empty}</EmptyState>
      ) : (
        <DataTable
          data={rows}
          total={q.data?.count}
          columns={columns}
          flexColumn="description"
          tableId={spec.tableId}
          // The wide set is available in the Columns menu; only the columns an
          // assigned-IPs list needs at a glance are on by default.
          initialColumnVisibility={{
            scope: false,
            dns: false,
            switch: false,
            switch_interface: false,
            tags: false,
            updated: false,
          }}
        />
      )}
      <AssignIpDialog
        target={assignTarget}
        onOpenChange={(o) => !o && setAssignTarget(null)}
      />
    </div>
  )
}

// Per-IP "…" menu - sets/clears the device's primary/secondary/management
// designation slots. Rendered in the RowActions extra slot.
function DesignationMenu({
  ip,
  slot,
  onPatch,
}: {
  ip: IPAddress
  slot: Slot | null
  onPatch: (body: Record<string, string | null>, successMsg: string) => void
}) {
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
          disabled={slot === "primary"}
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
          disabled={slot === "secondary"}
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
          disabled={slot === "oob"}
          onSelect={() =>
            onPatch(
              { oob_ip_id: ip.id },
              `${ip.ip_address} set as management IP`
            )
          }
        >
          Set as management
        </DropdownMenuItem>
        {slot != null && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                const body: Record<string, string | null> = {}
                if (slot === "primary") body.primary_ip_id = null
                if (slot === "secondary") body.secondary_ip_id = null
                if (slot === "oob") body.oob_ip_id = null
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
