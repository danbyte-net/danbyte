import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import {
  api,
  type DnsDrift,
  type DnsZone,
  type Paginated,
  type WindowsConnection,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { InfoTip } from "@/components/ui/info-tip"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"

/** The DNS side of a Windows server: zones (with per-zone reconcile opt-in),
 * drift review, and a live record viewer. */
export function DnsPanel({ conn }: { conn: WindowsConnection }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canZone = canDo("dnszone", "change")
  const canResolve = canDo("dnsdrift", "change")

  const zonesQ = useQuery({
    queryKey: ["dns-zones", conn.id],
    queryFn: () =>
      api<Paginated<DnsZone>>(
        `/api/dns-zones/?connection=${conn.id}&page_size=200`
      ),
  })
  const zones = zonesQ.data?.results ?? []

  const driftQ = useQuery({
    queryKey: ["dns-drifts", conn.id],
    queryFn: () =>
      api<Paginated<DnsDrift>>(
        `/api/dns-drifts/?connection=${conn.id}&page_size=500`
      ),
  })
  const drifts = driftQ.data?.results ?? []

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["dns-zones"] })
    qc.invalidateQueries({ queryKey: ["dns-drifts"] })
  }

  const setSync = useMutation({
    mutationFn: ({ zone, on }: { zone: DnsZone; on: boolean }) =>
      api<DnsZone>(`/api/dns-zones/${zone.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ sync: on }),
      }),
    onSuccess: (_, { on }) => {
      toast.success(
        on
          ? "Zone reconciliation on - records compare on the next sync"
          : "Zone reconciliation off"
      )
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const resolve = useMutation({
    mutationFn: ({
      d,
      strategy,
    }: {
      d: DnsDrift
      strategy: "accept" | "push"
    }) =>
      api(`/api/dns-drifts/${d.id}/resolve/`, {
        method: "POST",
        body: JSON.stringify({ strategy }),
      }),
    onSuccess: (_, { strategy }) => {
      toast.success(
        strategy === "accept"
          ? "Server's name accepted"
          : "Record rewritten on the server"
      )
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const zoneColumns = useMemo<ColumnDef<DnsZone>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Zone",
        cell: ({ row }) => (
          <Link
            to="/dns-zones/$id"
            params={{ id: row.original.id }}
            className="link font-mono text-xs font-medium"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "type",
        accessorKey: "zone_type",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.zone_type}
            {row.original.is_reverse ? " · reverse" : ""}
          </span>
        ),
      },
      {
        id: "records",
        accessorKey: "record_count",
        header: "Records",
        cell: ({ row }) => (
          <span className="num">
            {row.original.sync ? row.original.record_count : "-"}
          </span>
        ),
      },
      {
        id: "drift",
        header: "Drift",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.drift_count > 0 ? (
            <Badge variant="destructive" className="text-[10px]">
              {row.original.drift_count}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">-</span>
          ),
      },
      {
        id: "sync",
        header: "Reconcile",
        enableSorting: false,
        cell: ({ row }) => (
          <Switch
            checked={row.original.sync}
            disabled={!canZone || setSync.isPending}
            onCheckedChange={(on) => setSync.mutate({ zone: row.original, on })}
            aria-label="Reconcile zone"
          />
        ),
      },
    ],
    [canZone, setSync]
  )

  const driftColumns = useMemo<ColumnDef<DnsDrift>[]>(
    () => [
      {
        id: "ip",
        accessorKey: "ip",
        header: "IP",
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.ip}</span>
        ),
      },
      {
        id: "kind",
        header: "Problem",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant="destructive" className="text-[10px]">
            {row.original.kind_display}
            {row.original.record_type && ` (${row.original.record_type})`}
          </Badge>
        ),
      },
      {
        id: "names",
        header: "Danbyte vs server",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-[11px]">
            {row.original.danbyte_name || "-"}{" "}
            <span className="text-muted-foreground">vs</span>{" "}
            {row.original.server_name || "(no record)"}
          </span>
        ),
      },
      {
        id: "zone",
        accessorKey: "zone_name",
        header: "Zone",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.zone_name}
          </span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) =>
          canResolve ? (
            <span className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                disabled={resolve.isPending}
                onClick={() =>
                  resolve.mutate({ d: row.original, strategy: "accept" })
                }
              >
                Accept
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                disabled={resolve.isPending}
                onClick={() =>
                  resolve.mutate({ d: row.original, strategy: "push" })
                }
              >
                Push ours
              </Button>
            </span>
          ) : null,
      },
    ],
    [canResolve, resolve]
  )

  if (!conn.dns_enabled)
    return (
      <EmptyState title="DNS is not enabled on this connection.">
        Edit the server and tick <span className="font-medium">Sync DNS</span>{" "}
        to list its zones here.
      </EmptyState>
    )

  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          Zones
          <InfoTip>
            Reconciliation compares A/AAAA/PTR records against IP DNS names -
            opt in per zone. Open a zone for its records and IP links.
          </InfoTip>
        </h3>
        {zonesQ.data && zones.length === 0 ? (
          <EmptyState title="No zones synced yet.">
            Run a sync to list this server's DNS zones.
          </EmptyState>
        ) : (
          <DataTable
            data={zones}
            columns={zoneColumns}
            tableId="dns-zones"
            flexColumn="type"
          />
        )}
      </div>
      {drifts.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Drift</h3>
          <DataTable
            data={drifts}
            columns={driftColumns}
            tableId="dns-drifts"
            flexColumn="names"
          />
        </div>
      )}
    </div>
  )
}
