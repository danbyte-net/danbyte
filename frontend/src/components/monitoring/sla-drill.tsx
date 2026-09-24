import { Link } from "@tanstack/react-router"
import { ArrowUpRight } from "lucide-react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SlaAnalysis } from "@/lib/api"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Section } from "@/components/ui/section"
import { StatusStrip, fmtSpan } from "@/components/monitoring/status-strip"
import { fmtSla } from "@/components/monitoring/sla-figure"
import { AvailabilityOverTime } from "./sla-analysis-charts"

export const MEMBER_ROUTE = {
  "api.device": "/devices/$id",
  "api.virtualmachine": "/virtual-machines/$id",
  "api.ipaddress": "/ips/$id",
  "api.prefix": "/prefixes/$id",
} as const

const MEMBER_NOUN = {
  "api.device": "Device",
  "api.virtualmachine": "Virtual machine",
  "api.ipaddress": "IP address",
  "api.prefix": "Prefix",
} as const

function IncidentList({ incidents }: { incidents: SlaAnalysis["incidents"] }) {
  if (!incidents.length)
    return <p className="text-[13px] text-muted-foreground">None.</p>
  return (
    <ul className="divide-y divide-border text-[13px]">
      {incidents.slice(0, 50).map((i) => (
        <li
          key={`${i.unit}-${i.start}`}
          className="flex items-center gap-2 py-1.5"
        >
          <TimeCell iso={i.start} />
          <span className="num text-muted-foreground">
            {fmtSpan(i.seconds * 1000)}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {i.members.join(", ") || i.label}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** One day of the window by the hour: who was down, and the incidents. */
export function DayDrill({
  agreementId,
  day,
  filterQuery,
  onClose,
  onMember,
}: {
  agreementId: string
  /** The bucket's start, ISO in the agreement's zone. */
  day: string | null
  filterQuery: string
  onClose: () => void
  onMember: (key: string) => void
}) {
  const date = day?.slice(0, 10)
  const q = useQuery({
    queryKey: ["sla-analysis-day", agreementId, date, filterQuery],
    queryFn: () =>
      api<SlaAnalysis>(
        `/api/monitoring/sla-agreements/${agreementId}/analysis/?since=${date}&until=${date}&bucket=hour${filterQuery ? `&${filterQuery}` : ""}`
      ),
    enabled: !!date,
  })
  const d = q.data
  const down = (d?.by_member ?? []).filter((m) => m.down_s > 0)
  return (
    <Dialog open={!!day} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {date}
            {d?.figures.availability != null &&
              ` · ${fmtSla(d.figures.availability)}`}
          </DialogTitle>
        </DialogHeader>
        {!d ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <div className="space-y-5">
            <AvailabilityOverTime data={d} />
            <div className="grid gap-5 md:grid-cols-2">
              <Section title="Down this day" count={down.length}>
                {down.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">Nobody.</p>
                ) : (
                  <ul className="divide-y divide-border text-[13px]">
                    {down.map((m) => (
                      <li
                        key={m.key}
                        className="flex items-center gap-2 py-1.5"
                      >
                        <button
                          type="button"
                          className="link min-w-0 flex-1 truncate text-left"
                          onClick={() => onMember(m.key)}
                        >
                          {m.name}
                        </button>
                        <span className="text-xs text-muted-foreground">
                          {m.worst_item}
                        </span>
                        <span className="num">{fmtSpan(m.down_s * 1000)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
              <Section title="Incidents" count={d.incidents.length}>
                <IncidentList incidents={d.incidents} />
              </Section>
            </div>
            {d.by_kind.some((k) => k.down_s > 0) && (
              <Section title="By check type">
                <div className="flex flex-wrap gap-2">
                  {d.by_kind.map((k) => (
                    <Badge key={k.name} variant="secondary" className="num">
                      <span className="font-mono text-[10px] uppercase">
                        {k.name}
                      </span>
                      {fmtSla(k.availability)} · {fmtSpan(k.down_s * 1000)}
                    </Badge>
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** One member in the window: its figure, each check, its strip, incidents. */
export function MemberPanel({
  data,
  memberKey,
  onClose,
}: {
  data: SlaAnalysis | undefined
  memberKey: string | null
  onClose: () => void
}) {
  const m = data?.by_member.find((x) => x.key === memberKey)
  const strip = data?.strips.find((s) => s.key === memberKey)
  // Several addresses (a prefix, a dual-homed device): say which one.
  const manyIps = new Set(m?.items.map((i) => i.ip_id)).size > 1
  const incidents = (data?.incidents ?? []).filter(
    (i) => m && i.members.includes(m.name)
  )
  return (
    <Sheet open={!!memberKey} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-x-hidden overflow-y-auto data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {m ? (
              <Link
                to={MEMBER_ROUTE[m.object_type]}
                params={{ id: m.object_id }}
                className="link inline-flex min-w-0 items-center gap-1.5"
              >
                <span className="truncate">{m.name}</span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
              </Link>
            ) : (
              "Member"
            )}
          </SheetTitle>
          {m && (
            <p className="text-[13px] text-muted-foreground">
              {MEMBER_NOUN[m.object_type]} · {m.group}
            </p>
          )}
        </SheetHeader>
        {m && data && (
          <div className="min-w-0 space-y-5 px-4 pb-6">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
              <span className="text-2xl font-semibold">
                {fmtSla(m.availability)}
              </span>
              <span className="text-muted-foreground">
                {m.coverage != null && `${Math.round(m.coverage)}% measured · `}
                {fmtSpan(m.down_s * 1000)} down · {m.incidents} incident
                {m.incidents === 1 ? "" : "s"}
              </span>
            </div>
            {strip && (
              <StatusStrip
                segments={strip.segments.map(([start, end, c]) => ({
                  start,
                  end,
                  status: c === "unmeasured" ? "unknown" : c,
                }))}
                since={data.since}
                until={data.until}
                height={12}
              />
            )}
            <Section title="Checks" count={m.items.length}>
              <ul className="divide-y divide-border text-[13px]">
                {m.items.map((it) => (
                  <li
                    key={`${it.ip_id}-${it.template_id}`}
                    className="flex items-center gap-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {manyIps && it.address && (
                        <span className="mr-2 font-mono text-[12px] text-muted-foreground">
                          {it.address}
                        </span>
                      )}
                      {it.state_id ? (
                        <Link
                          to="/monitoring/checks/$id"
                          params={{ id: it.state_id }}
                          className="link"
                        >
                          {it.name}
                        </Link>
                      ) : (
                        it.name
                      )}{" "}
                      <span className="font-mono text-[10px] text-muted-foreground uppercase">
                        {it.kind}
                      </span>
                    </span>
                    {!it.counts && (
                      <Badge variant="outline">Informational</Badge>
                    )}
                    <span className="num text-muted-foreground">
                      {it.down_s ? fmtSpan(it.down_s * 1000) : "-"}
                    </span>
                    <span className="num w-20 text-right">
                      {fmtSla(it.availability)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="Incidents" count={incidents.length}>
              <IncidentList incidents={incidents} />
            </Section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
