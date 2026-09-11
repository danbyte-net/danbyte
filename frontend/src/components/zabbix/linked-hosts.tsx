import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { ExternalLink } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, ZabbixConnection, ZabbixHostLink } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { RowActions } from "@/components/row-actions"
import { zabbixHostUrl } from "@/components/monitoring/external-status"

/**
 * The pairings a sync pass has made between devices and Zabbix hosts.
 *
 * A link is made by matching, never by hand. Removing one is the exception -
 * it is how an operator says "that pairing is wrong", and the next pass then
 * re-matches from scratch.
 */
export function ZabbixLinkedHosts({
  connection,
  canManage,
}: {
  connection: ZabbixConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [unlinking, setUnlinking] = useState<ZabbixHostLink | null>(null)

  const links = useQuery({
    queryKey: ["zabbix-links", connection.id],
    queryFn: () =>
      api<Paginated<ZabbixHostLink>>(
        `/api/zabbix/links/?connection=${connection.id}`
      ),
  })

  const unlink = useMutation({
    mutationFn: (id: string) =>
      api(`/api/zabbix/links/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Unlinked - the next sync re-matches it")
      setUnlinking(null)
      void qc.invalidateQueries({ queryKey: ["zabbix-links"] })
      void qc.invalidateQueries({ queryKey: ["zabbix-scope"] })
    },
    onError: apiErrorToast,
  })

  const rows = links.data?.results ?? []

  const columns = useMemo<ColumnDef<ZabbixHostLink>[]>(
    () => [
      {
        id: "device",
        accessorFn: (r) => r.device?.name ?? "",
        header: ({ column }) => <SortHeader column={column} label="Device" />,
        cell: ({ row }) =>
          row.original.device ? (
            <Link
              to="/devices/$id"
              params={{ id: row.original.device.id }}
              className="link font-medium"
            >
              {row.original.device.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "host",
        accessorKey: "host_name",
        header: ({ column }) => <SortHeader column={column} label="Zabbix host" />,
        cell: ({ row }) => {
          const url = zabbixHostUrl(connection.url, row.original.hostid)
          return url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="link inline-flex items-center gap-1 font-mono text-xs"
            >
              {row.original.host_name}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <span className="font-mono text-xs">{row.original.host_name}</span>
          )
        },
      },
      {
        id: "matched_by",
        accessorKey: "matched_by",
        header: ({ column }) => <SortHeader column={column} label="Matched by" />,
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.matched_by}</Badge>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Matched by",
            get: (r: ZabbixHostLink) => r.matched_by,
            formatValue: (v: string) => ({ label: v }),
          },
        },
      },
      {
        id: "origin",
        accessorFn: (r) => (r.created_here ? "Danbyte" : "Zabbix"),
        header: ({ column }) => <SortHeader column={column} label="Created by" />,
        cell: ({ row }) =>
          row.original.created_here ? (
            <Badge variant="secondary">Danbyte</Badge>
          ) : (
            <span className="text-muted-foreground">Zabbix</span>
          ),
      },
      {
        id: "unwanted",
        accessorKey: "unwanted_since",
        header: ({ column }) => (
          <SortHeader column={column} label="Unwanted since" />
        ),
        cell: ({ row }) =>
          row.original.unwanted_since ? (
            <span className="inline-flex items-center gap-2">
              <Badge variant="warning">Unwanted</Badge>
              <TimeCell iso={row.original.unwanted_since} />
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      ...(canManage
        ? [
            {
              id: "actions",
              enableHiding: false,
              cell: ({ row }) => (
                <RowActions
                  onDelete={() => setUnlinking(row.original)}
                  deleteLabel="Unlink"
                />
              ),
            } as ColumnDef<ZabbixHostLink>,
          ]
        : []),
    ],
    [canManage, connection.url]
  )

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
          Linked hosts
          <Badge variant="secondary" className="num">
            {rows.length}
          </Badge>
        </h2>
      </div>

      {links.isLoading ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing linked" className="m-4">
          A sync pass pairs each device in scope with its Zabbix host.
        </EmptyState>
      ) : (
        <DataTable
          tableId="zabbix-links"
          data={rows}
          columns={columns}
          flexColumn="host"
        />
      )}

      <ConfirmDialog
        open={!!unlinking}
        onOpenChange={(o) => !o && setUnlinking(null)}
        title={`Unlink ${unlinking?.device?.name ?? "this device"}?`}
        description="The Zabbix host is untouched. The next sync pass matches it again from scratch."
        confirmLabel="Unlink"
        pendingLabel="Unlinking…"
        pending={unlink.isPending}
        onConfirm={() => unlinking && unlink.mutate(unlinking.id)}
      />
    </section>
  )
}
