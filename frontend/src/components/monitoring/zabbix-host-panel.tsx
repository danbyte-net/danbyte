import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"

import { ApiError, api } from "@/lib/api"
import type { ZabbixHostStatus } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { InfoTip } from "@/components/ui/info-tip"
import { Section } from "@/components/ui/section"
import { TimeCell } from "@/components/cells/time-ago"
import { AvailabilityList } from "./external-detail"
import { SeverityPill, zabbixHostUrl } from "./external-status"
import { CheckStatusBadge } from "./status-badge"

/** The hosts Zabbix has for a device, if any. One fetch for every panel on
 * the page; an empty answer means "not in Zabbix" and the panel is absent. A
 * 404 means the integration is off, which is the same absence. */
export function useZabbixHostStatus(
  scope: { device: string } | { ip: string }
) {
  const key = "device" in scope ? `device=${scope.device}` : `ip=${scope.ip}`
  return useQuery({
    queryKey: ["zabbix-host-status", key],
    queryFn: async () => {
      try {
        return await api<ZabbixHostStatus[]>(`/api/zabbix/host-status/?${key}`)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return []
        throw e
      }
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  })
}

/**
 * What Zabbix reports about a host, beside Danbyte's own status - open
 * problems, protocols it cannot reach the host on, whether it is disabled or
 * in maintenance there. It never changes Danbyte's status: a host can be
 * green here and red in Zabbix, and both are worth seeing. `compact` is one
 * chip row for an Overview; the default is the card for a Monitoring tab.
 */
export function ZabbixHostPanel({
  scope,
  compact = false,
}: {
  scope: { device: string } | { ip: string }
  compact?: boolean
}) {
  const q = useZabbixHostStatus(scope)
  const rows = q.data ?? []
  if (rows.length === 0) return null
  if (compact) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {rows.map((r) => (
          <CompactRow key={r.connection.id + r.host.hostid} row={r} />
        ))}
      </span>
    )
  }
  return (
    <Section
      title="Zabbix"
      badge={
        <InfoTip>
          What Zabbix reports about this host. It does not change Danbyte&apos;s
          status.
        </InfoTip>
      }
    >
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {rows.map((r) => (
          <HostRow key={r.connection.id + r.host.hostid} row={r} />
        ))}
      </div>
    </Section>
  )
}

function CompactRow({ row }: { row: ZabbixHostStatus }) {
  const s = row.status
  const link = zabbixHostUrl(row.connection.url, row.host.hostid)
  const unreachable = Object.entries(s.availability)
    .filter(([, v]) => v.state === "down")
    .map(([k]) => k)
  return (
    <>
      <a
        href={link || undefined}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        Zabbix
        <ExternalLink className="h-3 w-3" />
      </a>
      {s.worst_status && <CheckStatusBadge status={s.worst_status} />}
      {s.problem_count > 0 && (
        <Badge variant="warning" className="num">
          {s.problem_count} problem{s.problem_count === 1 ? "" : "s"}
        </Badge>
      )}
      {unreachable.map((p) => (
        <Badge key={p} variant="destructive" className="uppercase">
          {p}
        </Badge>
      ))}
      {s.disabled && <Badge variant="secondary">Disabled</Badge>}
      {s.maintenance && <Badge variant="secondary">Maintenance</Badge>}
    </>
  )
}

function HostRow({ row }: { row: ZabbixHostStatus }) {
  const s = row.status
  const link = zabbixHostUrl(row.connection.url, row.host.hostid)
  const more = s.problem_count - s.problems.length
  return (
    <div className="space-y-2 px-3 py-2.5 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <CheckStatusBadge status={s.worst_status ?? "unknown"} />
        <span className="font-mono font-medium">{row.host.name}</span>
        <span className="text-muted-foreground">
          {row.connection.name}
          {s.disabled && " · disabled in Zabbix"}
          {s.maintenance && " · in maintenance"}
        </span>
        <span className="ml-auto inline-flex items-center gap-3 text-[11px] text-muted-foreground">
          {s.polled_at && (
            <span className="inline-flex items-center gap-1">
              read <TimeCell iso={s.polled_at} />
            </span>
          )}
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
        </span>
      </div>
      {!row.connection.read_host_status && (
        <p className="text-[11px] text-muted-foreground">
          Host status reading is off on this connection.
        </p>
      )}
      <AvailabilityList availability={s.availability} />
      {s.problems.length > 0 && (
        <ul className="space-y-1">
          {s.problems.map((p) => (
            <li key={p.eventid || p.name} className="flex items-start gap-2">
              <SeverityPill severity={p.severity} />
              <span className="min-w-0 flex-1">{p.name}</span>
              {p.since && (
                <span className="shrink-0">
                  <TimeCell iso={p.since} />
                </span>
              )}
            </li>
          ))}
          {more > 0 && (
            <li className="text-[11px] text-muted-foreground">
              and {more} more
            </li>
          )}
        </ul>
      )}
      {s.polled_at && s.problem_count === 0 && !s.disabled && (
        <p className="text-[11px] text-muted-foreground">No open problems.</p>
      )}
    </div>
  )
}
