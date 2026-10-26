import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { ExternalLink } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { PrtgConnection, PrtgDeviceLink } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { Section } from "@/components/ui/section"
import { RowActions } from "@/components/row-actions"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"

/**
 * The pairings the status read has made between devices and PRTG devices,
 * with each one's roll-up. Removing a link says "that pairing is wrong"; the
 * next read matches the device again from scratch.
 */
export function PrtgLinks({
  connection,
  canManage,
}: {
  connection: PrtgConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [unlinking, setUnlinking] = useState<PrtgDeviceLink | null>(null)

  const links = useQuery({
    queryKey: ["prtg-links", connection.id],
    queryFn: () =>
      apiAll<PrtgDeviceLink>(`/api/prtg/links/?connection=${connection.id}`),
  })

  const unlink = useMutation({
    mutationFn: (id: string) =>
      api(`/api/prtg/links/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Unlinked - the next read matches it again")
      setUnlinking(null)
      void qc.invalidateQueries({ queryKey: ["prtg-links"] })
    },
    onError: apiErrorToast,
  })

  const rows = links.data?.results ?? []

  const columns = useMemo<ColumnDef<PrtgDeviceLink>[]>(
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
        id: "state",
        accessorKey: "state",
        header: ({ column }) => <SortHeader column={column} label="Status" />,
        cell: ({ row }) => (
          <PrtgRollup
            state={row.original.state}
            down={row.original.sensor_counts.down ?? 0}
            warning={row.original.sensor_counts.degraded ?? 0}
          />
        ),
      },
      {
        id: "prtg",
        accessorKey: "name",
        header: ({ column }) => (
          <SortHeader column={column} label="PRTG device" />
        ),
        cell: ({ row }) => (
          <a
            href={row.original.url}
            target="_blank"
            rel="noreferrer"
            className="link inline-flex items-center gap-1 font-mono text-xs"
          >
            {row.original.name || row.original.objid}
            <ExternalLink className="h-3 w-3" />
          </a>
        ),
      },
      {
        id: "host",
        accessorKey: "host",
        header: ({ column }) => <SortHeader column={column} label="Host" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.host || "-"}</span>
        ),
      },
      {
        id: "sensors",
        accessorFn: (r) => r.sensor_counts.total ?? 0,
        header: ({ column }) => <SortHeader column={column} label="Sensors" />,
        cell: ({ row }) => (
          <span className="num">{row.original.sensor_counts.total ?? 0}</span>
        ),
      },
      {
        id: "matched_by",
        accessorKey: "matched_by",
        header: ({ column }) => (
          <SortHeader column={column} label="Matched by" />
        ),
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.matched_by}</Badge>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Matched by",
            get: (r: PrtgDeviceLink) => r.matched_by,
            formatValue: (v: string) => ({ label: v }),
          },
        },
      },
      {
        id: "read",
        accessorKey: "status_read_at",
        header: ({ column }) => <SortHeader column={column} label="Read" />,
        cell: ({ row }) =>
          row.original.status_read_at ? (
            <TimeCell iso={row.original.status_read_at} />
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
            } as ColumnDef<PrtgDeviceLink>,
          ]
        : []),
    ],
    [canManage]
  )

  return (
    <Section title="Linked devices" count={rows.length}>
      {links.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing linked">
          Each status read pairs Danbyte devices with PRTG devices by tag,
          address, DNS name or name.
        </EmptyState>
      ) : (
        <DataTable
          tableId="prtg-links"
          data={rows}
          total={links.data?.count}
          columns={columns}
          flexColumn="prtg"
          searchable
          searchPlaceholder="Search devices…"
        />
      )}

      <ConfirmDialog
        open={!!unlinking}
        onOpenChange={(o) => !o && setUnlinking(null)}
        title={`Unlink ${unlinking?.device?.name ?? "this device"}?`}
        description="Nothing in PRTG is touched. The next read matches the device again from scratch."
        confirmLabel="Unlink"
        pendingLabel="Unlinking…"
        pending={unlink.isPending}
        onConfirm={() => unlinking && unlink.mutate(unlinking.id)}
      />
    </Section>
  )
}

/** A device's PRTG roll-up: its state pill, plus counts of down and warning
 * sensors. Shared by the links table and the device-list column. */
export function PrtgRollup({
  state,
  down,
  warning,
}: {
  state: PrtgDeviceLink["state"] | null
  down: number
  warning: number
}) {
  if (!state) return <span className="text-muted-foreground">-</span>
  return (
    <span className="inline-flex items-center gap-1">
      <CheckStatusBadge status={state} />
      {down > 0 && (
        <Badge variant="destructive" className="num">
          {down}
          <span className="sr-only"> down</span>
        </Badge>
      )}
      {warning > 0 && (
        <Badge variant="warning" className="num">
          {warning}
          <span className="sr-only"> warning</span>
        </Badge>
      )}
    </span>
  )
}
