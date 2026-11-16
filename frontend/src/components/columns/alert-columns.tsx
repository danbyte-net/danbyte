import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import {
  Activity,
  ArrowUpCircle,
  BellOff,
  Check,
  Hourglass,
  Network,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { AlertSeverity, MonitoringAlert } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { SortHeader } from "@/components/data-table"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// The one source of truth for "a table of alerts": the Alerts page and a
// root cause's explained alerts build here.

export type AlertColumnId =
  "severity" | "ip" | "check" | "state" | "opened" | "duration"

export const SEV_VARIANT: Record<
  AlertSeverity,
  "destructive" | "warning" | "secondary"
> = {
  critical: "destructive",
  warning: "warning",
  info: "secondary",
}

export function humanDuration(ms: number): string {
  const s = Math.max(Math.floor(ms / 1000), 0)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** Whether the acknowledgement was written back to Zabbix (#162): "ok",
 * "failed", or null when the alert was never Zabbix's to begin with. */
function zabbixAck(a: MonitoringAlert): "ok" | "failed" | null {
  const stamp = a.detail.zabbix_ack as
    { acknowledged?: boolean; error?: string } | undefined
  if (!stamp || !a.acknowledged) return null
  return stamp.error ? "failed" : stamp.acknowledged ? "ok" : null
}

function Chip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent variant="panel">{tip}</TooltipContent>
    </Tooltip>
  )
}

/** "m:ss" until a held alert is decided, ticking. */
function useCountdown(until: string | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!until) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [until])
  if (!until) return ""
  const left = Math.max(Math.ceil((new Date(until).getTime() - now) / 1000), 0)
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
}

/** "Held · 0:42" - waiting for its upstreams' checks (#450). */
export function HeldChip({ until }: { until: string | null }) {
  const left = useCountdown(until)
  return (
    <Chip tip="Waiting for its upstreams' checks before it is sent">
      <Badge variant="info" className="gap-1 text-[10px]">
        <Hourglass className="h-3 w-3" /> Held{left ? ` · ${left}` : ""}
      </Badge>
    </Chip>
  )
}

/** "Explained by core-1" - a down upstream accounts for it (#450). */
export function ExplainedChip({
  rootCause,
}: {
  rootCause: NonNullable<MonitoringAlert["root_cause"]>
}) {
  return (
    <Badge variant="secondary" className="gap-1 text-[10px]" asChild>
      <Link to="/root-causes/$id" params={{ id: rootCause.id }}>
        <Network className="h-3 w-3" /> Explained by {rootCause.device.name}
      </Link>
    </Badge>
  )
}

/** The alert's chips: escalated, flapping, silenced, held, explained, ack. */
export function AlertStateCell({ a }: { a: MonitoringAlert }) {
  return (
    <div className="flex items-center gap-1.5">
      <CheckStatusBadge status={a.check_status} />
      {a.escalated && (
        <Chip tip="Escalated to critical after firing unacknowledged">
          <Badge variant="destructive" className="gap-1 text-[10px]">
            <ArrowUpCircle className="h-3 w-3" /> escalated
          </Badge>
        </Chip>
      )}
      {a.flapping && (
        <Chip tip="Opening and clearing repeatedly - reminders paused">
          <Badge variant="warning" className="gap-1 text-[10px]">
            <Activity className="h-3 w-3" /> flapping
          </Badge>
        </Chip>
      )}
      {a.silenced && (
        <Chip tip="Muted by an active silence or maintenance window">
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <BellOff className="h-3 w-3" /> silenced
          </Badge>
        </Chip>
      )}
      {a.status === "firing" && a.notify_state === "held" && (
        <HeldChip until={a.notify_after} />
      )}
      {a.root_cause && <ExplainedChip rootCause={a.root_cause} />}
      {a.acknowledged && (
        <Chip
          tip={
            (a.acknowledged_by_name ? `by ${a.acknowledged_by_name}` : "Ack") +
            (a.ack_note ? ` - ${a.ack_note}` : "")
          }
        >
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Check className="h-3 w-3" /> ack
            {zabbixAck(a) === "ok" && (
              <span className="text-muted-foreground">· Zabbix</span>
            )}
            {zabbixAck(a) === "failed" && (
              <span className="text-destructive">· not in Zabbix</span>
            )}
          </Badge>
        </Chip>
      )}
    </div>
  )
}

/** Acknowledge / clear-acknowledgement toggle for one firing alert. */
export function AlertAckButton({ a }: { a: MonitoringAlert }) {
  const qc = useQueryClient()

  const ack = useMutation({
    mutationFn: (unack: boolean) =>
      api<MonitoringAlert>(
        `/api/monitoring/alerts/${a.id}/ack/${unack ? "?action=unack" : ""}`,
        { method: "POST", body: JSON.stringify({}) }
      ),
    onSuccess: (_d, unack) => {
      toast.success(unack ? "Acknowledgement cleared" : "Alert acknowledged")
      qc.invalidateQueries({ queryKey: ["alerts"] })
      qc.invalidateQueries({ queryKey: ["root-cause"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      title={a.acknowledged ? "Clear acknowledgement" : "Acknowledge"}
      disabled={ack.isPending}
      onClick={() => ack.mutate(a.acknowledged)}
    >
      {a.acknowledged ? (
        <BellOff className="h-3.5 w-3.5" />
      ) : (
        <Check className="h-3.5 w-3.5" />
      )}
      <span className="sr-only">{a.acknowledged ? "Unack" : "Ack"}</span>
    </Button>
  )
}

export function buildAlertColumns(
  opts: { omit?: AlertColumnId[] } = {}
): ColumnDef<MonitoringAlert, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const cols: [AlertColumnId | null, ColumnDef<MonitoringAlert, unknown>][] = [
    [
      "severity",
      {
        id: "severity",
        accessorFn: (a) => a.severity,
        header: ({ column }) => <SortHeader column={column} label="Severity" />,
        cell: ({ row }) => (
          <Badge
            variant={SEV_VARIANT[row.original.severity]}
            className="capitalize"
          >
            {row.original.severity}
          </Badge>
        ),
      },
    ],
    [
      "ip",
      {
        id: "ip",
        accessorFn: (a) => a.target_ip.ip_address,
        header: ({ column }) => (
          <SortHeader column={column} label="IP address" />
        ),
        cell: ({ row }) => (
          <Link
            to="/ips/$id"
            params={{ id: row.original.target_ip.id }}
            className="link font-mono font-medium"
          >
            {row.original.target_ip.ip_address}
          </Link>
        ),
      },
    ],
    [
      "check",
      {
        id: "check",
        accessorFn: (a) => a.template?.name ?? a.kind,
        header: "Check",
        cell: ({ row }) => (
          <>
            {row.original.template?.name ?? row.original.kind}{" "}
            <span className="font-mono text-[11px] text-muted-foreground uppercase">
              {row.original.kind}
            </span>
          </>
        ),
      },
    ],
    [
      "state",
      {
        id: "state",
        enableSorting: false,
        header: "State",
        cell: ({ row }) => <AlertStateCell a={row.original} />,
      },
    ],
    [
      "opened",
      timeAgoColumn<MonitoringAlert>({
        id: "opened",
        header: "Opened",
        get: (a) => a.opened_at,
        align: "right",
      }),
    ],
    [
      "duration",
      {
        id: "duration",
        enableSorting: false,
        header: () => <div className="text-right">Duration</div>,
        cell: ({ row }) => {
          const a = row.original
          const end = a.resolved_at ? new Date(a.resolved_at) : new Date()
          const ms = end.getTime() - new Date(a.opened_at).getTime()
          return (
            <div className="num text-right text-muted-foreground">
              {humanDuration(ms)}
            </div>
          )
        },
      },
    ],
    // Ack / unack is the only row action alerts have - it rides the shared
    // actions column's `extra` slot instead of a bespoke cell.
    [
      null,
      actionsColumn<MonitoringAlert>({
        extra: (a) => (a.status === "firing" ? <AlertAckButton a={a} /> : null),
      }),
    ],
  ]
  return cols.filter(([id]) => id === null || !omit.has(id)).map(([, c]) => c)
}
