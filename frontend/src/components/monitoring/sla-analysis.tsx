import { useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"

import { api } from "@/lib/api"
import type { SlaAgreement, SlaAnalysis, SlaPeriodSummary } from "@/lib/api"
import { QueryError } from "@/components/query-error"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DatePicker } from "@/components/ui/date-picker"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  SLA_STATE_LABEL,
  SlaFigureBadge,
  fmtBudget,
  fmtSla,
} from "@/components/monitoring/sla-figure"
import { fmtSpan } from "@/components/monitoring/status-strip"
import {
  AvailabilityOverTime,
  BurnDown,
  Delta,
  DowntimeBreakdown,
  DowntimeHeatmap,
  IncidentLengths,
  LatencyAgainstObjective,
  MemberStrips,
} from "./sla-analysis-charts"
import type { BreakdownKind } from "./sla-analysis-charts"
import { DayDrill, MemberPanel } from "./sla-drill"
import { BurnNow } from "./sla-burn-rules"
import { fmtCredit } from "./sla-credit-tiers"
import { ObjectiveCards } from "./sla-objectives"

type FilterKey = "group" | "site" | "member" | "kind" | "redundancy"
type Filters = Record<FilterKey, string[]>
const NO_FILTERS: Filters = {
  group: [],
  site: [],
  member: [],
  kind: [],
  redundancy: [],
}

function filterQuery(f: Filters): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v.length) p.set(k, v.join(","))
  return p.toString()
}

function RailList({
  title,
  options,
  value,
  onChange,
  mono,
}: {
  title: string
  options: { value: string; label: string; count?: number }[]
  value: string[]
  onChange: (next: string[]) => void
  mono?: boolean
}) {
  const [all, setAll] = useState(false)
  if (!options.length) return null
  const shown = all ? options : options.slice(0, 8)
  const set = new Set(value)
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {title}
      </div>
      {shown.map((o) => (
        <label
          key={o.value}
          className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-muted/50"
        >
          <Checkbox
            checked={set.has(o.value)}
            onCheckedChange={() => {
              const next = new Set(set)
              if (next.has(o.value)) next.delete(o.value)
              else next.add(o.value)
              onChange([...next])
            }}
          />
          <span
            className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[11px] uppercase" : ""}`}
          >
            {o.label}
          </span>
          {o.count != null && (
            <span className="num text-[11px] text-muted-foreground">
              {o.count}
            </span>
          )}
        </label>
      ))}
      {options.length > 8 && (
        <button
          type="button"
          className="link px-1 text-xs"
          onClick={() => setAll((v) => !v)}
        >
          {all ? "Fewer" : `All ${options.length}`}
        </button>
      )}
    </div>
  )
}

/** The last twelve finished periods as pills, oldest first; a pill opens
 * that period. */
function HistoryStrip({
  periods,
  active,
  onPick,
}: {
  periods: SlaPeriodSummary[]
  active: string | null
  onPick: (key: string) => void
}) {
  const done = periods
    .filter((p) => p.state === "closed" || p.state === "frozen")
    .slice(0, 12)
    .reverse()
  const counted = done.filter((p) => p.figures.state !== "no_data")
  if (!counted.length) return null
  const met = counted.filter(
    (p) => p.figures.state === "ok" || p.figures.state === "at_risk"
  ).length
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <span className="mr-1 text-muted-foreground">
        Met <span className="num text-foreground">{met}</span> of{" "}
        <span className="num">{counted.length}</span>
      </span>
      {done.map((p) => (
        <Tooltip key={p.period_key}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onPick(p.period_key)}
              className={cn(
                "rounded-md",
                active === p.period_key && "ring-2 ring-ring ring-offset-1"
              )}
            >
              <Badge
                variant={HISTORY_VARIANT[p.figures.state]}
                className="num cursor-pointer"
              >
                {p.period_key}
              </Badge>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="num">
              {fmtSla(p.figures.availability)} ·{" "}
              {SLA_STATE_LABEL[p.figures.state]}
              {p.state === "closed" ? " · not final yet" : ""}
            </span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

const HISTORY_VARIANT = {
  ok: "success",
  at_risk: "warning",
  breached: "destructive",
  no_data: "secondary",
  not_started: "secondary",
} as const

/** A chart in its own card: title and description inside the border. */
function AnalysisCard({
  title,
  description,
  count,
  children,
}: {
  title: string
  description?: string
  count?: number
  children: React.ReactNode
}) {
  return (
    <Card className="min-w-0 gap-3">
      <CardHeader>
        <CardTitle className="text-sm">
          {title}
          {count != null && (
            <span className="num ml-1.5 font-normal text-muted-foreground">
              {count}
            </span>
          )}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Figure({
  label,
  children,
  delta,
}: {
  label: string
  children: React.ReactNode
  delta?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {label}
      </div>
      <div className="num mt-1 text-xl font-semibold tracking-tight">
        {children}
      </div>
      <div className="mt-0.5 h-4">{delta}</div>
    </div>
  )
}

/**
 * The agreement's analysis: a filter rail (period or range, bucket, and the
 * group / site / member / check type / redundancy slices) and every chart
 * computed live for that slice. Clicking a day drills into it by the hour;
 * clicking a breakdown row filters the page; a member opens its panel.
 */
export function SlaAnalysisView({
  agreement: a,
  periods,
}: {
  agreement: SlaAgreement
  periods: SlaPeriodSummary[]
}) {
  const [period, setPeriod] = useState("current")
  const [range, setRange] = useState<{ since: string; until: string }>({
    since: "",
    until: "",
  })
  const [useRange, setUseRange] = useState(false)
  const [bucket, setBucket] = useState<"day" | "hour">("day")
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [day, setDay] = useState<string | null>(null)
  const [member, setMember] = useState<string | null>(null)

  const fq = filterQuery(filters)
  const windowQuery =
    useRange && range.since
      ? `since=${range.since}&until=${range.until || range.since}`
      : `period=${period}`
  const q = useQuery({
    queryKey: ["sla-analysis", a.id, windowQuery, bucket, fq],
    queryFn: () =>
      api<SlaAnalysis>(
        `/api/monitoring/sla-agreements/${a.id}/analysis/?${windowQuery}&bucket=${bucket}${fq ? `&${fq}` : ""}`
      ),
    placeholderData: keepPreviousData,
  })
  const d = q.data
  const opts = d?.options

  const periodItems = useMemo(() => {
    const seen = new Set<string>()
    const out = [{ value: "current", label: "This period" }]
    for (const p of periods) {
      if (p.state === "open" || p.state === "rolling" || seen.has(p.period_key))
        continue
      seen.add(p.period_key)
      out.push({ value: p.period_key, label: p.period_key })
    }
    return out.slice(0, 13)
  }, [periods])

  const setFilter = (k: FilterKey, v: string[]) =>
    setFilters((f) => ({ ...f, [k]: v }))
  const active = Object.values(filters).reduce((n, v) => n + v.length, 0)
  const pick = (kind: BreakdownKind, key: string) =>
    setFilter(kind, filters[kind].includes(key) ? filters[kind] : [key])

  const f = d?.figures
  const prev = d?.previous

  return (
    <div className="flex min-h-0 gap-6">
      {/* ── the rail ── */}
      <aside className="hidden w-60 shrink-0 space-y-5 self-start rounded-lg border border-border bg-card p-4 lg:block">
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Window
          </div>
          <div className="flex flex-col gap-0.5">
            {periodItems.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  setUseRange(false)
                  setPeriod(p.value)
                }}
                className={`rounded-md px-2 py-1 text-left text-[13px] ${
                  !useRange && period === p.value
                    ? "bg-muted font-medium"
                    : "text-muted-foreground hover:bg-muted/60"
                }`}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setUseRange(true)}
              className={`rounded-md px-2 py-1 text-left text-[13px] ${
                useRange
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:bg-muted/60"
              }`}
            >
              Custom range
            </button>
          </div>
          {useRange && (
            <div className="grid gap-1.5">
              <DatePicker
                value={range.since}
                onChange={(v) => setRange((r) => ({ ...r, since: v }))}
                placeholder="From"
              />
              <DatePicker
                value={range.until}
                onChange={(v) => setRange((r) => ({ ...r, until: v }))}
                placeholder="To"
              />
            </div>
          )}
        </div>
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Per
          </div>
          <SegmentedTabs
            value={bucket}
            onValueChange={(v) => setBucket(v)}
            items={[
              { value: "day", label: "Day" },
              { value: "hour", label: "Hour" },
            ]}
          />
        </div>
        {active > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => setFilters(NO_FILTERS)}
          >
            <X className="h-3.5 w-3.5" /> Clear {active} filter
            {active === 1 ? "" : "s"}
          </Button>
        )}
        {opts && (
          <>
            <RailList
              title="Check groups"
              options={opts.groups.map((g) => ({
                value: g.id,
                label: g.name,
                count: g.count,
              }))}
              value={filters.group}
              onChange={(v) => setFilter("group", v)}
            />
            <RailList
              title="Sites"
              options={opts.sites.map((s) => ({
                value: s.id,
                label: s.name,
                count: s.count,
              }))}
              value={filters.site}
              onChange={(v) => setFilter("site", v)}
            />
            <RailList
              title="Check types"
              options={opts.kinds.map((k) => ({ value: k, label: k }))}
              value={filters.kind}
              onChange={(v) => setFilter("kind", v)}
              mono
            />
            <RailList
              title="Redundancy groups"
              options={opts.redundancy.map((r) => ({
                value: r.name,
                label: r.name,
                count: r.count,
              }))}
              value={filters.redundancy}
              onChange={(v) => setFilter("redundancy", v)}
            />
            <RailList
              title="Members"
              options={opts.members.map((m) => ({
                value: m.id,
                label: m.name,
              }))}
              value={filters.member}
              onChange={(v) => setFilter("member", v)}
            />
          </>
        )}
      </aside>

      {/* ── the figures ── */}
      <div className="min-w-0 flex-1 space-y-6">
        {q.isError && <QueryError error={q.error} />}
        {!d || !f ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            {d.limited && (
              <p className="text-[13px] text-muted-foreground">
                Limited view: members outside what you can see are left out.
              </p>
            )}
            <HistoryStrip
              periods={periods}
              active={useRange ? null : period}
              onPick={(key) => {
                setUseRange(false)
                setPeriod(key)
              }}
            />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Figure
                label="Availability"
                delta={
                  <Delta
                    now={f.availability}
                    before={prev?.availability}
                    kind="pct"
                  />
                }
              >
                <SlaFigureBadge figures={f} />
              </Figure>
              <Figure label="State">
                <span className="text-base">{SLA_STATE_LABEL[f.state]}</span>
              </Figure>
              <Figure
                label="Coverage"
                delta={
                  <Delta now={f.coverage} before={prev?.coverage} kind="pct" />
                }
              >
                {f.coverage == null ? "-" : `${f.coverage}%`}
              </Figure>
              <Figure
                label="Down"
                delta={
                  <Delta now={f.down_s} before={prev?.down_s} kind="seconds" />
                }
              >
                {fmtSpan(f.down_s * 1000)}
              </Figure>
              <Figure label="Budget left">
                <span className={f.budget_left_s < 0 ? "text-destructive" : ""}>
                  {fmtBudget(f.budget_left_s)}
                </span>
              </Figure>
              <Figure
                label="Incidents"
                delta={
                  <Delta
                    now={f.incidents}
                    before={prev?.incidents}
                    kind="count"
                  />
                }
              >
                {f.incidents}
              </Figure>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
                Target {fmtSla(f.target)}
                {prev?.availability != null &&
                  ` · the window before: ${fmtSla(prev.availability)}`}
                {fmtCredit(f.credit) && (
                  <span className="text-destructive">
                    · credit {fmtCredit(f.credit)}
                  </span>
                )}
                {d.forecast && (
                  <>
                    <span>· forecast</span>
                    <SlaFigureBadge
                      figures={{
                        availability: d.forecast.availability,
                        state: d.forecast.state,
                        coverage: null,
                      }}
                    />
                  </>
                )}
              </div>
              {!useRange && period === "current" && (
                <BurnNow burn={a.current?.burn} />
              )}
            </div>

            <ObjectiveCards objectives={d.objectives} />

            <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
              <AnalysisCard
                title="Availability over time"
                description={
                  [
                    d.bucket === "day" && "Click a day to see it by the hour",
                    d.period_end > d.until &&
                      (d.bucket === "day"
                        ? "today in progress"
                        : "this hour in progress"),
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
              >
                <AvailabilityOverTime
                  data={d}
                  onPick={d.bucket === "day" ? (p) => setDay(p.t) : undefined}
                />
              </AnalysisCard>
              <AnalysisCard
                title="Error budget"
                description="Spent against the pace that would spend it exactly"
              >
                <BurnDown data={d} />
              </AnalysisCard>
              <AnalysisCard
                title="Where the down time went"
                description="Click a row to filter the page to it"
              >
                <DowntimeBreakdown data={d} onPick={pick} />
              </AnalysisCard>
              <AnalysisCard
                title="When outages happen"
                description="Down time by weekday and hour"
              >
                <DowntimeHeatmap data={d} />
              </AnalysisCard>
              <AnalysisCard title="Incident lengths">
                <IncidentLengths data={d} />
              </AnalysisCard>
              <AnalysisCard title="Latency against objectives">
                <LatencyAgainstObjective data={d} />
              </AnalysisCard>
            </div>
            <AnalysisCard title="Members over time" count={d.strips.length}>
              <MemberStrips data={d} onPick={setMember} />
            </AnalysisCard>
          </>
        )}
      </div>

      <DayDrill
        agreementId={a.id}
        day={day}
        filterQuery={fq}
        onClose={() => setDay(null)}
        onMember={(k) => {
          setDay(null)
          setMember(k)
        }}
      />
      <MemberPanel
        data={d}
        memberKey={member}
        onClose={() => setMember(null)}
      />
    </div>
  )
}
