import { ExternalLink } from "lucide-react"

import type { ExternalDetail } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SeverityPill, zabbixHostUrl } from "./external-status"

/**
 * What the external system that answered this check actually said.
 *
 * The chips on a list say *that* something is wrong; this says what. Its most
 * useful line is usually the reachability error - Zabbix reports the OID it
 * could not read and why, which is the whole diagnosis for a host whose
 * community string is missing.
 */
export function ExternalDetailPanel({ detail }: { detail?: ExternalDetail }) {
  const problems = detail?.problems ?? []
  const availability = detail?.availability ?? {}
  const host = detail?.zabbix_host
  const protocols = Object.entries(availability)
  if (!host && problems.length === 0 && protocols.length === 0) return null

  return (
    <div className="space-y-2 text-[11px]">
      {host && (
        <p className="flex items-center justify-between gap-3 text-muted-foreground">
          <span>
            Answered by <span className="font-mono">{host}</span>
          </span>
          {zabbixHostUrl(detail.zabbix_url ?? "", detail.hostid ?? "") && (
            <a
              href={zabbixHostUrl(detail.zabbix_url ?? "", detail.hostid ?? "")}
              target="_blank"
              rel="noreferrer"
              className="link inline-flex items-center gap-1"
            >
              Open in Zabbix
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </p>
      )}

      {protocols.length > 0 && <AvailabilityList availability={availability} />}

      {problems.length > 0 && (
        <ul className="space-y-1">
          {problems.map((p, i) => (
            <li key={`${p.name}-${i}`} className="flex items-start gap-2">
              <SeverityPill severity={p.severity ?? ""} />
              <span className="min-w-0 flex-1">{p.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Which protocols the external system cannot reach the host on, one line
 * each in its own words - and the ones it can, as a quiet "reachable".
 * An interface nobody has polled yet says nothing and is left out: a row
 * reading "not polled yet" is a row with no fact on it. Shared by the
 * check's detail and the host panel so the two never describe the same
 * interface differently. */
export function AvailabilityList({
  availability,
}: {
  availability: Record<string, { state: string; error?: string }>
}) {
  const protocols = Object.entries(availability).filter(
    ([, info]) => info.state === "down" || info.state === "up"
  )
  if (protocols.length === 0) return null
  return (
    <div className="space-y-1">
      {protocols.map(([proto, info]) => (
        <div key={proto} className="flex flex-wrap items-start gap-2">
          <Badge
            variant={
              info.state === "down"
                ? "destructive"
                : info.state === "up"
                  ? "success"
                  : "secondary"
            }
            className="uppercase"
          >
            {proto}
          </Badge>
          {info.error ? (
            // The remote system's own words. Paraphrasing them would only
            // lose the OID and the timeout that name the problem.
            <span className="min-w-0 flex-1 font-mono break-all text-muted-foreground">
              {info.error}
            </span>
          ) : (
            <span className="text-muted-foreground">reachable</span>
          )}
        </div>
      ))}
    </div>
  )
}
