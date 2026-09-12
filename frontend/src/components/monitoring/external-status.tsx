import { ExternalLink } from "lucide-react"

import type { BulkStatusEntry, CheckStatus } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { statusLabel, useStatusLabels } from "./status-palette"

/**
 * One hover for a monitoring roll-up, everywhere a roll-up appears.
 *
 * The device, prefix, IP and VM tables all show the same badge and, before
 * this, each carried its own browser `title=` with a slightly different
 * sentence. This is the shared card: the breakdown by state, and - when an
 * external system answered - its open problems with their severity, the
 * protocols it cannot reach the host on with its own error text, and a link
 * straight to the host over there.
 */

/** Zabbix trigger severities, 0-5. Colour is for meaning only: two tints for
 * "worth a look", two for "worth a page", grey for the rest. */
const SEVERITY: Record<
  string,
  { label: string; variant: "secondary" | "info" | "warning" | "destructive" }
> = {
  "0": { label: "Not classified", variant: "secondary" },
  "1": { label: "Information", variant: "info" },
  "2": { label: "Warning", variant: "warning" },
  "3": { label: "Average", variant: "warning" },
  "4": { label: "High", variant: "destructive" },
  "5": { label: "Disaster", variant: "destructive" },
}

export function SeverityPill({ severity }: { severity: string }) {
  const s = SEVERITY[severity] ?? {
    label: `Severity ${severity}`,
    variant: "secondary" as const,
  }
  return <Badge variant={s.variant}>{s.label}</Badge>
}

/** The host's problems in Zabbix 7, filtered to that host. Not the host
 * dashboard: that view lists the dashboards the host's *templates* carry
 * and reads "No data found" for the many templates that have none, which
 * is a dead end from a status pill. Problems always renders and is what a
 * status sends you to look at. */
export function zabbixHostUrl(base: string, hostid: string): string {
  if (!base || !hostid) return ""
  return `${base.replace(/\/+$/, "")}/zabbix.php?action=problem.view&hostids%5B%5D=${encodeURIComponent(hostid)}`
}

/** The host's latest data - every item's last value. */
export function zabbixLatestUrl(base: string, hostid: string): string {
  if (!base || !hostid) return ""
  return `${base.replace(/\/+$/, "")}/zabbix.php?action=latest.view&hostids%5B%5D=${encodeURIComponent(hostid)}`
}

export function ExternalStatusHover({
  entry,
  children,
}: {
  entry: BulkStatusEntry
  children: React.ReactNode
}) {
  const labels = useStatusLabels()
  const counts = Object.entries(entry.counts ?? {}).filter(([, n]) => n > 0)
  const problems = entry.problem_names ?? []
  const unreachable = entry.unreachable ?? []
  const errors = entry.unreachable_errors ?? {}
  const ext = entry.external
  const link = ext ? zabbixHostUrl(ext.url, ext.hostid) : ""

  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <span
          className="inline-flex cursor-default items-center gap-1.5"
          tabIndex={0}
        >
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="max-w-sm space-y-2.5 text-[12px]"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">
            {entry.monitored_ips != null
              ? `${entry.monitored_ips} monitored ${entry.monitored_ips === 1 ? "address" : "addresses"}`
              : `${entry.checks ?? counts.reduce((a, [, n]) => a + n, 0)} checks`}
          </span>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="link inline-flex items-center gap-1"
            >
              Open in Zabbix
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        <div className="flex flex-wrap gap-1">
          {counts.map(([s, n]) => (
            <Badge key={s} variant="secondary" className="num">
              {n} {statusLabel(s as CheckStatus, labels)}
            </Badge>
          ))}
        </div>

        {(entry.flapping ?? 0) > 0 && (
          <p className="text-muted-foreground">
            <span className="num">{entry.flapping}</span>{" "}
            {entry.flapping === 1 ? "check" : "checks"} flapping - bouncing
            between states; stays flagged until confirmed.
          </p>
        )}

        {unreachable.length > 0 && (
          <div className="space-y-1">
            {unreachable.map((proto) => (
              <div key={proto} className="flex items-start gap-2">
                <Badge variant="destructive" className="uppercase">
                  {proto}
                </Badge>
                <span className="min-w-0 flex-1 font-mono text-[11px] break-all text-muted-foreground">
                  {errors[proto] || "not reachable"}
                </span>
              </div>
            ))}
          </div>
        )}

        {problems.length > 0 && (
          <ul className="space-y-1">
            {problems.map((p, i) => (
              <li key={`${p.name}-${i}`} className="flex items-start gap-2">
                <SeverityPill severity={p.severity} />
                <span className="min-w-0 flex-1">{p.name}</span>
              </li>
            ))}
            {(entry.problems ?? 0) > problems.length && (
              <li className="text-muted-foreground">
                and {(entry.problems ?? 0) - problems.length} more
              </li>
            )}
          </ul>
        )}

        {ext?.host && (
          <p className="text-muted-foreground">
            Answered by <span className="font-mono">{ext.host}</span>
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
