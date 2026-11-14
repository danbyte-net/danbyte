import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Container, Server, Snowflake, Zap } from "lucide-react"

import { api } from "@/lib/api"
import type { CoolingPath } from "@/lib/api"
import {
  AffectedHeader,
  AffectedRow as Row,
  AffectedSection as Section,
  affectedLinkCls as linkCls,
} from "@/components/affected-panel"
import { coolingPathText } from "@/components/cooling-path"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

/**
 * What a power panel / feed or cooling source / feed takes down with it
 * (#434): its feeds, the racks they deliver to and the devices in those racks,
 * each rack and device marked Outage or Reduced redundancy. "Plan maintenance"
 * opens a new event with exactly these impacts prefilled.
 */

export type AffectedKind =
  "coolingsource" | "coolingfeed" | "powerpanel" | "powerfeed"

export interface AffectedRef {
  id: string
  name: string
}

export interface AffectedImpact {
  object_type: string
  object_id: string
  level: string
}

export interface Affected {
  feeds: { id: string; name: string; type: string; rack: AffectedRef | null }[]
  racks: (AffectedRef & { level: string })[]
  devices: (AffectedRef & {
    level: string
    rack: AffectedRef | null
    /** Cooling only: the device's path from source, through any CDU. */
    path?: CoolingPath | null
  })[]
  impacts: AffectedImpact[]
}

export const AFFECTED_ENDPOINTS: Record<AffectedKind, string> = {
  coolingsource: "/api/cooling-sources/",
  coolingfeed: "/api/cooling-feeds/",
  powerpanel: "/api/power-panels/",
  powerfeed: "/api/power-feeds/",
}

export function affectedQueryOptions(kind: AffectedKind, id: string) {
  return {
    queryKey: ["affected", kind, id],
    queryFn: () => api<Affected>(`${AFFECTED_ENDPOINTS[kind]}${id}/affected/`),
  }
}

export function AffectedPanel({
  kind,
  id,
  name,
}: {
  kind: AffectedKind
  id: string
  name: string
}) {
  const nav = useNavigate()
  const q = useQuery(affectedQueryOptions(kind, id))
  const cooling = kind === "coolingsource" || kind === "coolingfeed"
  const FeedIcon = cooling ? Snowflake : Zap

  if (q.isLoading) return <Loading />
  if (q.error) return <QueryError error={q.error} />
  const data = q.data
  if (!data) return null

  const nothing =
    data.feeds.length === 0 &&
    data.racks.length === 0 &&
    data.devices.length === 0

  return (
    <div className="space-y-4">
      <AffectedHeader
        text={`Downstream of ${name}`}
        onPlan={() =>
          nav({
            to: "/maintenance/new",
            search: { affected_kind: kind, affected_id: id },
          })
        }
      />

      {nothing ? (
        <EmptyState title="Nothing downstream yet." />
      ) : (
        <>
          <Section title="Feeds" count={data.feeds.length}>
            {data.feeds.map((f) => (
              <Row
                key={f.id}
                icon={FeedIcon}
                name={f.name}
                link={
                  cooling ? (
                    <Link
                      to="/cooling-feeds/$id"
                      params={{ id: f.id }}
                      className={linkCls}
                    >
                      {f.name}
                    </Link>
                  ) : (
                    <Link
                      to="/power-feeds/$id"
                      params={{ id: f.id }}
                      className={linkCls}
                    >
                      {f.name}
                    </Link>
                  )
                }
                note={
                  [f.type && f.type[0].toUpperCase() + f.type.slice(1)]
                    .concat(f.rack ? [f.rack.name] : [])
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
              />
            ))}
          </Section>
          <Section title="Racks" count={data.racks.length}>
            {data.racks.map((r) => (
              <Row
                key={r.id}
                icon={Container}
                name={r.name}
                level={r.level}
                link={
                  <Link
                    to="/racks/$id"
                    params={{ id: r.id }}
                    className={linkCls}
                  >
                    {r.name}
                  </Link>
                }
              />
            ))}
          </Section>
          <Section title="Devices" count={data.devices.length}>
            {data.devices.map((d) => (
              <Row
                key={d.id}
                icon={Server}
                name={d.name}
                level={d.level}
                note={
                  d.path ? coolingPathText(d.path) : (d.rack?.name ?? undefined)
                }
                link={
                  <Link
                    to="/devices/$id"
                    params={{ id: d.id }}
                    className={linkCls}
                  >
                    {d.name}
                  </Link>
                }
              />
            ))}
          </Section>
        </>
      )}
    </div>
  )
}
