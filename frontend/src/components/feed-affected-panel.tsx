import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { CalendarPlus, Container, Server, Snowflake, Zap } from "lucide-react"

import { api } from "@/lib/api"
import type { CoolingPath } from "@/lib/api"
import { coolingPathText } from "@/components/cooling-path"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { LEVELS, levelTone } from "@/components/monitoring/impact-levels"

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

function Level({ level }: { level: string }) {
  return (
    <span className={`shrink-0 text-[11px] ${levelTone[level] ?? ""}`}>
      {LEVELS.find((l) => l.value === level)?.label ?? level}
    </span>
  )
}

function Row({
  icon: Icon,
  name,
  link,
  note,
  level,
}: {
  icon: typeof Server
  name: string
  link: React.ReactNode
  note?: string
  level?: string
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2" data-row={name}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        {link}
        {note && (
          <span className="block truncate text-[11px] text-muted-foreground">
            {note}
          </span>
        )}
      </div>
      {level && <Level level={level} />}
    </div>
  )
}

const linkCls = "link block truncate text-[13px] font-medium"

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">
        {title}
        <span className="num ml-1.5 font-normal">{count}</span>
      </h3>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {children}
      </div>
    </section>
  )
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
  const { canDo } = useMe()
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
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-sm text-muted-foreground">
          Downstream of {name}
        </p>
        {canDo("maintenanceevent", "add") && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              nav({
                to: "/maintenance/new",
                search: { affected_kind: kind, affected_id: id },
              })
            }
          >
            <CalendarPlus className="h-3.5 w-3.5" /> Plan maintenance
          </Button>
        )}
      </div>

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
