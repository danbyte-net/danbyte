import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ShieldCheck } from "lucide-react"

import { api } from "@/lib/api"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

// One tenant-scoped read (`/certificates/health/`) buckets the whole inventory;
// the client never re-counts. Buckets use the tenant's own expiry thresholds,
// which the endpoint echoes back so the labels stay honest per deployment.
interface CertHealth {
  total: number
  expired: number
  expiring_critical: number
  expiring_warning: number
  healthy: number
  self_signed: number
  warning_days: number
  critical_days: number
  ssh_host_key_drift: number
  firing_alerts: number
}

// Reuse the app's severity vocabulary rather than a new palette: expired = the
// down/destructive tone, critical = amber, warning = caution, healthy = up.
const TONE: Record<string, string> = {
  expired: "text-red-600 dark:text-red-400",
  critical: "text-amber-600 dark:text-amber-400",
  warning: "text-yellow-700 dark:text-yellow-500",
  healthy: "text-emerald-600 dark:text-emerald-400",
  muted: "text-muted-foreground",
}

function Tile({
  label,
  value,
  tone,
  to,
  emphasize,
}: {
  label: string
  value: number
  tone: keyof typeof TONE
  to: string
  emphasize?: boolean
}) {
  return (
    <Link
      to={to}
      className={`flex flex-col rounded-lg border p-3 transition-colors hover:bg-muted/50 ${
        emphasize && value > 0
          ? "border-red-300 bg-red-50/40 dark:border-red-900/60 dark:bg-red-950/20"
          : "border-border"
      }`}
    >
      <span
        className={`text-2xl font-semibold tabular-nums ${
          value > 0 ? TONE[tone] : "text-muted-foreground"
        }`}
      >
        {value.toLocaleString()}
      </span>
      <span className="mt-0.5 text-xs text-muted-foreground">{label}</span>
    </Link>
  )
}

export function CertKeyHealthCard() {
  const q = useQuery({
    queryKey: ["cert-key-health"],
    queryFn: () => api<CertHealth>("/api/monitoring/certificates/health/"),
    refetchInterval: 60_000,
  })
  const d = q.data
  // Nothing to show on a deployment with no certificates and no key drift.
  if (!d || (d.total === 0 && d.ssh_host_key_drift === 0)) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Certificate &amp; key health
        </CardTitle>
        <CardDescription>
          Expiry against this tenant&apos;s thresholds (critical ≤{" "}
          {d.critical_days}d, warning ≤ {d.warning_days}d), plus SSH host-key
          drift and firing alerts. Each tile opens the matching list.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
          <Tile
            label="Expired"
            value={d.expired}
            tone="expired"
            to="/certificates"
            emphasize
          />
          <Tile
            label={`Expiring ≤ ${d.critical_days}d`}
            value={d.expiring_critical}
            tone="critical"
            to="/certificates"
            emphasize
          />
          <Tile
            label={`Expiring ≤ ${d.warning_days}d`}
            value={d.expiring_warning}
            tone="warning"
            to="/certificates"
          />
          <Tile
            label="Healthy"
            value={d.healthy}
            tone="healthy"
            to="/certificates"
          />
          <Tile
            label="Self-signed"
            value={d.self_signed}
            tone="muted"
            to="/certificates"
          />
          <Tile
            label="SSH key drift"
            value={d.ssh_host_key_drift}
            tone="critical"
            to="/alerts"
            emphasize
          />
          <Tile
            label="Firing alerts"
            value={d.firing_alerts}
            tone="expired"
            to="/alerts"
            emphasize
          />
        </div>
      </CardContent>
    </Card>
  )
}
