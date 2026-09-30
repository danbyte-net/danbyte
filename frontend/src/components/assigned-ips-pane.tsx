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

// The IPs tab of a device or of one of its interfaces: the shared IP table
// (buildIpColumns) plus the two columns only an assigned-IPs list has -
// Designation (the device's primary / secondary / management slot) and
// Monitoring - and the Assign IP / + Add IP buttons.

/** Whose IPs the pane lists. An interface's IPs always sit on its device, so
 * both scopes carry the device - designation and monitoring are the
 * device's. */
export type AssignedIpsScope =
  | { kind: "device"; deviceId: string; deviceName: string }
  | {
      kind: "interface"
      deviceId: string
      interfaceId: string
      interfaceName: string
    }

interface ListResp<T> {
  count: number
  results: T[]
}

/** The pane's rows query. A page that shows the count in its tab strip runs
 * the same query, so the two share one request. */
export function assignedIpsQuery(scope: AssignedIpsScope) {
  const url =
    scope.kind === "device"
      ? `/api/devices/${scope.deviceId}/ips/`
      : `/api/interfaces/${scope.interfaceId}/ips/`
  return {
    // ["interface-ips", id] is the key AssignIpDialog refreshes.
    queryKey:
      scope.kind === "device"
        ? ["device-ips", scope.deviceId]
        : ["interface-ips", scope.interfaceId],
    queryFn: () => api<ListResp<IPAddress>>(url),
  }
}

const SPEC = {
  device: { tableId: "device-ips", empty: "No IPs assigned to this device." },
  interface: {
    tableId: "interface-ips",
    empty: "No IPs assigned to this interface.",
  },
} as const

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
  const { deviceId } = scope
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
      cell: ({ row }) => {
        const ip = row.original
        if (ip.is_primary_for_device)
          return <Badge variant="success">★ Primary</Badge>
        if (ip.is_oob_for_device) return <Badge variant="secondary">Mgmt</Badge>
        if (ip.is_secondary_for_device)
          return <Badge variant="secondary">2nd</Badge>
        return <span className="text-muted-foreground">-</span>
      },
    })
    insertAfter("status", {
      id: "monitoring",
      header: "Monitoring",
      cell: ({ row }) => {
        const e = monByIp[row.original.id]
        if (!e || !e.status)
          return <span className="text-muted-foreground">-</span>
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <MixedStatusBadge counts={e.counts} status={e.status} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {e.checks} check{e.checks === 1 ? "" : "s"}
            </TooltipContent>
          </Tooltip>
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
                    ? { deviceId, deviceName: scope.deviceName }
                    : {
                        deviceId,
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
                    ? { device: deviceId }
                    : // Save and Cancel come back to this tab.
                      {
                        device: deviceId,
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
