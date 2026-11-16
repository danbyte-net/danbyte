import { Link } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { BellOff, Check } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { RootCauseIncident, RootCauseStatus } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { SortHeader } from "@/components/data-table"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import { humanDuration } from "@/components/columns/alert-columns"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

// The one source of truth for "a table of root causes" (#450).

export const ROOT_CAUSE_STATUS: Record<
  RootCauseStatus,
  { label: string; variant: "destructive" | "warning" | "success" }
> = {
  open: { label: "Open", variant: "destructive" },
  recovering: { label: "Recovering", variant: "warning" },
  resolved: { label: "Resolved", variant: "success" },
}

export function RootCauseStatusBadge({ status }: { status: RootCauseStatus }) {
  const s = ROOT_CAUSE_STATUS[status]
  return <Badge variant={s.variant}>{s.label}</Badge>
}

export function rootCauseDuration(r: RootCauseIncident): string {
  const end = r.resolved_at ? new Date(r.resolved_at) : new Date()
  return humanDuration(end.getTime() - new Date(r.opened_at).getTime())
}

/** Acknowledge an incident - and with it the root's own firing alerts. */
export function RootCauseAckButton({
  r,
  labeled = false,
}: {
  r: RootCauseIncident
  labeled?: boolean
}) {
  const qc = useQueryClient()
  const ack = useMutation({
    mutationFn: (unack: boolean) =>
      api<RootCauseIncident>(
        `/api/monitoring/root-causes/${r.id}/ack/${unack ? "?action=unack" : ""}`,
        { method: "POST", body: JSON.stringify({}) }
      ),
    onSuccess: (_d, unack) => {
      toast.success(
        unack ? "Acknowledgement cleared" : "Root cause acknowledged"
      )
      qc.invalidateQueries({ queryKey: ["root-causes"] })
      qc.invalidateQueries({ queryKey: ["root-cause", r.id] })
      qc.invalidateQueries({ queryKey: ["alerts"] })
    },
    onError: (err) => apiErrorToast(err),
  })
  const Icon = r.acknowledged ? BellOff : Check
  if (labeled)
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={ack.isPending}
        onClick={() => ack.mutate(r.acknowledged)}
      >
        <Icon className="h-3.5 w-3.5" />
        {ack.isPending
          ? r.acknowledged
            ? "Clearing…"
            : "Acknowledging…"
          : r.acknowledged
            ? "Clear acknowledgement"
            : "Acknowledge"}
      </Button>
    )
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      title={r.acknowledged ? "Clear acknowledgement" : "Acknowledge"}
      disabled={ack.isPending}
      onClick={() => ack.mutate(r.acknowledged)}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="sr-only">{r.acknowledged ? "Unack" : "Ack"}</span>
    </Button>
  )
}

export function buildRootCauseColumns(): ColumnDef<
  RootCauseIncident,
  unknown
>[] {
  return [
    {
      id: "device",
      accessorFn: (r) => r.device.name,
      header: ({ column }) => <SortHeader column={column} label="Root" />,
      cell: ({ row }) => (
        <Link
          to="/root-causes/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.device.name}
        </Link>
      ),
    },
    {
      id: "status",
      accessorFn: (r) => r.status,
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          <RootCauseStatusBadge status={row.original.status} />
          {row.original.acknowledged && (
            <Badge variant="outline" className="gap-1 text-[10px]">
              <Check className="h-3 w-3" /> ack
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "explained",
      accessorFn: (r) => r.explained_count + r.already_alerted_count,
      header: ({ column }) => (
        <div className="flex justify-end">
          <SortHeader column={column} label="Explained" />
        </div>
      ),
      cell: ({ row }) => (
        <div className="num text-right">
          {row.original.explained_count + row.original.already_alerted_count}
        </div>
      ),
    },
    {
      id: "reduced",
      accessorFn: (r) => r.reduced_count,
      header: ({ column }) => (
        <div className="flex justify-end">
          <SortHeader column={column} label="Reduced" />
        </div>
      ),
      cell: ({ row }) => (
        <div className="num text-right text-muted-foreground">
          {row.original.reduced_count}
        </div>
      ),
    },
    timeAgoColumn<RootCauseIncident>({
      id: "opened",
      header: "Opened",
      get: (r) => r.opened_at,
      align: "right",
    }),
    {
      id: "duration",
      enableSorting: false,
      header: () => <div className="text-right">Duration</div>,
      cell: ({ row }) => (
        <div className="num text-right text-muted-foreground">
          {rootCauseDuration(row.original)}
        </div>
      ),
    },
    actionsColumn<RootCauseIncident>({
      extra: (r) =>
        r.status !== "resolved" ? <RootCauseAckButton r={r} /> : null,
    }),
  ]
}
