import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api } from "@/lib/api"
import type { ZabbixConnection, ZabbixScope } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

/**
 * Which devices this connection should be keeping hosts for.
 *
 * Scope is derived - a `zabbix` check on one of this connection's engines *is*
 * the statement "I want Zabbix watching this" - and derived state that nothing
 * renders is state nobody can trust. Two devices left scope during a
 * reconciliation pass and no page would have shown it.
 */
export function ZabbixScopeList({
  connection,
}: {
  connection: ZabbixConnection
}) {
  const scope = useQuery({
    queryKey: ["zabbix-scope", connection.id],
    queryFn: () =>
      api<ZabbixScope>(`/api/zabbix/connections/${connection.id}/scope/`),
  })
  const rows = scope.data?.devices ?? []

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">
          In scope{" "}
          <span className="num text-xs font-normal text-muted-foreground">
            {rows.length}
          </span>
        </h2>
      </div>

      {scope.isLoading ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">
          Nothing yet. A device enters scope when one of its addresses carries a
          Zabbix check on an engine this connection reads through.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((r) => (
            <div
              key={r.device.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px]"
            >
              <Link
                to="/devices/$id"
                params={{ id: r.device.id }}
                className="link min-w-0 flex-1"
              >
                {r.device.name}
              </Link>
              <span className="num text-xs text-muted-foreground">
                {r.address || "-"}
              </span>
              <span className="text-xs text-muted-foreground">
                {r.site || "-"}
              </span>
              <span className="flex flex-wrap gap-1">
                {r.templates.map((t) => (
                  <span
                    key={t}
                    className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px]"
                  >
                    {t}
                  </span>
                ))}
                {r.groups.map((g) => (
                  <span
                    key={g}
                    className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {g}
                  </span>
                ))}
              </span>
              <ScopeState row={r} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Where this device has got to, in one badge. */
function ScopeState({ row }: { row: ZabbixScope["devices"][number] }) {
  if (row.pending.length > 0)
    return <Badge variant="warning">To review</Badge>
  if (row.hostid) return <Badge variant="success">Linked</Badge>
  return <Badge variant="destructive">No host</Badge>
}
