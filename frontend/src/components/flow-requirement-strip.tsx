import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { apiAll } from "@/lib/api-all"
import type { FlowRequirement } from "@/lib/api"
import { flowServiceLabel } from "@/lib/flows"
import { REQUIREMENTS_ENDPOINT } from "@/lib/flow-requirements"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"

// The device and VM Flows tab's strip: the requirements that apply to this
// host through its installs, each with what it documents here or why it
// can't ("no primary address", "Broker is not installed anywhere"). Where
// "add an address and its port requirements appear" shows.

/** An end as the strip names it: an application for a host end, else the
 * address, range or prefix ("Hidden" when the caller can't view it). */
export function endName(
  r: FlowRequirement,
  side: "source" | "destination"
): string {
  const e = r[side]
  if (e.hidden) return "Hidden"
  if (e.kind === "self") return r.application.name
  if (e.kind === "app") return e.application?.name ?? e.label
  return e.label
}

export function FlowRequirementStrip({
  host,
}: {
  host: { kind: "device" | "vm"; id: string }
}) {
  const { canDo } = useMe()
  const allowed = canDo("applicationflowrequirement", "view")
  const q = useQuery({
    queryKey: ["flow-requirements", host.kind, host.id],
    queryFn: () =>
      apiAll<FlowRequirement>(
        `${REQUIREMENTS_ENDPOINT}?${host.kind}=${host.id}`
      ),
    enabled: allowed,
  })
  const rows = q.data?.results ?? []
  if (!allowed || rows.length === 0) return null
  return (
    <ul
      className="grid gap-1 rounded-md border px-3 py-2 text-sm"
      aria-label="Requirements"
    >
      {rows.map((r) => {
        const here = r.host
        const n = here?.flows ?? 0
        return (
          <li key={r.id} className="flex flex-wrap items-center gap-2">
            <Link
              to="/applications/$id"
              params={{ id: r.application.id }}
              search={{ tab: "requirements" } as never}
              className="link font-medium"
            >
              {r.name}
            </Link>
            <span className="text-muted-foreground">·</span>
            <span>
              {endName(r, "source")} → {endName(r, "destination")}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono text-xs">{flowServiceLabel(r)}</span>
            <span className="text-muted-foreground">·</span>
            <span className="num">
              {n} flow{n === 1 ? "" : "s"}
            </span>
            {here?.reason ? (
              <Badge variant="warning">{here.reason}</Badge>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
