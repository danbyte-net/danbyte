import type { ExternalDetail } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

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
        <p className="text-muted-foreground">
          Answered by <span className="font-mono">{host}</span>
        </p>
      )}

      {protocols.length > 0 && (
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
                <span className="text-muted-foreground">
                  {info.state === "up" ? "reachable" : "not polled yet"}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {problems.length > 0 && (
        <ul className="space-y-0.5">
          {problems.map((p, i) => (
            <li key={`${p.name}-${i}`} className="text-muted-foreground">
              {p.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
