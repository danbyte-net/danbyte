import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, ZabbixConnection, ZabbixMaintenance } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { TimeCell } from "@/components/cells/time-ago"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"

/**
 * Danbyte's windows as Zabbix sees them.
 *
 * A row is written by the reconcile pass, never by hand: the calendar is the
 * source, and this is the receipt. A failed write stays on the row with
 * Zabbix's own words, so a window that quietly did not land is not quiet.
 */
export function ZabbixMaintenanceList({
  connection,
  canManage,
}: {
  connection: ZabbixConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const rows_ = useQuery({
    queryKey: ["zabbix-maintenance", connection.id],
    queryFn: () =>
      api<Paginated<ZabbixMaintenance>>(
        `/api/zabbix/maintenance/?connection=${connection.id}`
      ),
  })
  const rows = rows_.data?.results ?? []

  const sync = useMutation({
    mutationFn: () =>
      api<{ created: number; updated: number; deleted: number; failed: number }>(
        `/api/zabbix/connections/${connection.id}/sync-maintenance/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      const parts = [
        r.created && `${r.created} created`,
        r.updated && `${r.updated} updated`,
        r.deleted && `${r.deleted} removed`,
        r.failed && `${r.failed} failed`,
      ].filter(Boolean)
      toast[r.failed ? "error" : "success"](
        parts.length ? parts.join(", ") : "Nothing to change"
      )
      void qc.invalidateQueries({ queryKey: ["zabbix-maintenance"] })
      void qc.invalidateQueries({ queryKey: ["zabbix-connections"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<ZabbixMaintenance>[]>(
    () => [
      {
        id: "event",
        accessorFn: (r) => r.event?.name ?? r.name,
        header: ({ column }) => <SortHeader column={column} label="Event" />,
        cell: ({ row }) =>
          row.original.event ? (
            <Link
              to="/maintenance/$id/edit"
              params={{ id: row.original.event.id }}
              className="link font-medium"
            >
              {row.original.event.name}
            </Link>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span className="text-muted-foreground">{row.original.name}</span>
              <Badge variant="secondary">Event deleted</Badge>
            </span>
          ),
      },
      {
        id: "kind",
        accessorFn: (r) => r.event?.kind ?? "",
        header: ({ column }) => <SortHeader column={column} label="Kind" />,
        cell: ({ row }) =>
          row.original.event ? (
            <Badge
              variant={row.original.event.kind === "outage" ? "warning" : "secondary"}
            >
              {row.original.event.kind === "outage" ? "Outage" : "Maintenance"}
            </Badge>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "starts",
        accessorKey: "starts_at",
        header: ({ column }) => <SortHeader column={column} label="From" />,
        cell: ({ row }) => <TimeCell iso={row.original.starts_at} />,
      },
      {
        id: "ends",
        accessorKey: "ends_at",
        header: ({ column }) => <SortHeader column={column} label="To" />,
        cell: ({ row }) => <TimeCell iso={row.original.ends_at} />,
      },
      {
        id: "hosts",
        accessorKey: "host_count",
        header: ({ column }) => <SortHeader column={column} label="Hosts" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.host_count}</span>
        ),
      },
      {
        id: "state",
        accessorFn: (r) => stateOf(r).label,
        header: ({ column }) => <SortHeader column={column} label="State" />,
        cell: ({ row }) => {
          const s = stateOf(row.original)
          const pill = <Badge variant={s.variant}>{s.label}</Badge>
          if (!row.original.last_error) return pill
          return (
            <HoverCard openDelay={150}>
              <HoverCardTrigger asChild>
                <span className="inline-flex cursor-default">{pill}</span>
              </HoverCardTrigger>
              <HoverCardContent className="w-80 text-xs">
                {row.original.last_error}
              </HoverCardContent>
            </HoverCard>
          )
        },
        meta: {
          facet: {
            kind: "enum",
            label: "State",
            get: (r: ZabbixMaintenance) => stateOf(r).label,
            formatValue: (v: string) => ({ label: v }),
          },
        },
      },
      {
        id: "synced",
        accessorKey: "synced_at",
        header: ({ column }) => <SortHeader column={column} label="Written" />,
        cell: ({ row }) =>
          row.original.synced_at ? (
            <TimeCell iso={row.original.synced_at} />
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
    ],
    []
  )

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="inline-flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          Maintenance windows
          <Badge variant="secondary" className="num">
            {rows.length}
          </Badge>
        </h2>
        {canManage && connection.sync_maintenance && (
          <Button
            size="sm"
            variant="outline"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {sync.isPending ? "Syncing…" : "Sync"}
          </Button>
        )}
      </div>

      {rows_.isLoading ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="No windows" className="m-4">
          {connection.sync_maintenance
            ? "A confirmed maintenance or outage with a linked device is written here."
            : "Maintenance sync is off."}
        </EmptyState>
      ) : (
        <DataTable
          tableId="zabbix-maintenance"
          data={rows}
          columns={columns}
          flexColumn="event"
        />
      )}
    </section>
  )
}

/** Where this window has got to in Zabbix, as one pill. */
function stateOf(row: ZabbixMaintenance): {
  label: string
  variant: "success" | "warning" | "destructive"
} {
  if (row.last_error) return { label: "Failed", variant: "destructive" }
  if (!row.maintenanceid) return { label: "Pending", variant: "warning" }
  return { label: "Written", variant: "success" }
}
