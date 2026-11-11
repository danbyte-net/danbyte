import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ShieldCheck } from "lucide-react"

import { api } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { InfoTip } from "@/components/ui/info-tip"

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

/** One bucket: its name, then its count - coloured only when there is
 * something in it - opening the matching list. */
function Row({
  label,
  value,
  tone,
  to,
  search,
}: {
  label: string
  value: number
  tone: keyof typeof TONE
  to: string
  search?: Record<string, string>
}) {
  return (
    <li>
      <Link
        to={to}
        search={search}
        className="flex items-center gap-3 px-4 py-1.5 text-[13px] transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      >
        <span className="whitespace-nowrap text-muted-foreground">{label}</span>
        <span
          className={`num ml-auto font-medium ${
            value > 0 ? TONE[tone] : "text-muted-foreground"
          }`}
        >
          {value.toLocaleString()}
        </span>
      </Link>
    </li>
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
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Certificates &amp; keys
          <InfoTip>
            Expiry against this tenant&apos;s thresholds (critical ≤{" "}
            {d.critical_days}d, warning ≤ {d.warning_days}d), plus SSH host-key
            drift and firing alerts.
          </InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <ul className="divide-y divide-border border-t border-border">
          <Row
            label="Expired"
            value={d.expired}
            tone="expired"
            to="/certificates"
            search={{ expiry: "expired" }}
          />
          <Row
            label={`Expiring ≤ ${d.critical_days}d`}
            value={d.expiring_critical}
            tone="critical"
            to="/certificates"
            search={{ expiry: "critical" }}
          />
          <Row
            label={`Expiring ≤ ${d.warning_days}d`}
            value={d.expiring_warning}
            tone="warning"
            to="/certificates"
            search={{ expiry: "warning" }}
          />
          <Row
            label="Healthy"
            value={d.healthy}
            tone="healthy"
            to="/certificates"
            search={{ expiry: "healthy" }}
          />
          <Row
            label="Self-signed"
            value={d.self_signed}
            tone="muted"
            to="/certificates"
            search={{ self_signed: "self" }}
          />
          <Row
            label="SSH key drift"
            value={d.ssh_host_key_drift}
            tone="critical"
            to="/alerts"
            search={{ state: "firing", kind: "ssh" }}
          />
          <Row
            label="Firing alerts"
            value={d.firing_alerts}
            tone="expired"
            to="/alerts"
            search={{ state: "firing" }}
          />
        </ul>
      </CardContent>
    </Card>
  )
}
