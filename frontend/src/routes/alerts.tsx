import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { useQuery, keepPreviousData } from "@tanstack/react-query"

import {
  api,
  type AlertLifecycle,
  type AlertSeverity,
  type AlertsResponse,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { DataTable } from "@/components/data-table"
import { FacetGroup, FilterRail } from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { buildAlertColumns } from "@/components/columns/alert-columns"
import { AlertRulesList } from "@/components/monitoring/alert-rules"
import { PortRulesList } from "@/components/monitoring/port-rules"
import { ChannelsList } from "@/components/monitoring/channels-list"
import { SilencesList } from "@/components/monitoring/silences-list"
import { RootCausesList } from "@/components/monitoring/root-causes-list"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"

type AlertsTab = "alerts" | "root-causes" | "rules" | "channels" | "silences"
type AckFilter = "all" | "acknowledged" | "unacknowledged"
interface AlertsSearch {
  tab: AlertsTab
  state: AlertLifecycle
  severity: AlertSeverity | "all"
  ack: AckFilter
  q: string
  site: string
  kind?: string
  /** Firing view: also list alerts a down upstream explains (#450). */
  explained?: boolean
  /** Root causes tab: open (default) or resolved. */
  rc?: "resolved"
}

export const Route = createFileRoute("/alerts")({
  component: AlertsPage,
  validateSearch: (s: Record<string, unknown>): AlertsSearch => ({
    tab: ["root-causes", "rules", "channels", "silences"].includes(
      s.tab as string
    )
      ? (s.tab as AlertsTab)
      : "alerts",
    state: s.state === "resolved" ? "resolved" : "firing",
    severity: ["critical", "warning", "info"].includes(s.severity as string)
      ? (s.severity as AlertSeverity)
      : "all",
    ack: ["acknowledged", "unacknowledged"].includes(s.ack as string)
      ? (s.ack as AckFilter)
      : "all",
    q: typeof s.q === "string" ? s.q : "",
    site: typeof s.site === "string" ? s.site : "all",
    kind: typeof s.kind === "string" ? s.kind : "",
    explained:
      s.explained === true || s.explained === "true" ? true : undefined,
    rc: s.rc === "resolved" ? "resolved" : undefined,
  }),
})

// Stable empty selection for the single-select rail facets.
const EMPTY_FACET: Set<string> = new Set()

function AlertsPage() {
  const {
    tab,
    state,
    severity,
    ack,
    q: search,
    site,
    kind,
    explained,
    rc,
  } = Route.useSearch()
  const nav = useNavigate()
  const go = (next: Partial<AlertsSearch>) =>
    nav({
      to: "/alerts",
      search: (prev): AlertsSearch => ({
        tab: next.tab ?? (prev.tab as AlertsTab) ?? "alerts",
        state: next.state ?? (prev.state as AlertLifecycle) ?? "firing",
        severity:
          next.severity ?? (prev.severity as AlertSeverity | "all") ?? "all",
        ack: next.ack ?? (prev.ack as AckFilter) ?? "all",
        q: next.q ?? (prev.q as string) ?? "",
        site: next.site ?? (prev.site as string) ?? "all",
        kind: next.kind ?? (prev.kind as string) ?? "",
        explained: "explained" in next ? next.explained : prev.explained,
        rc: "rc" in next ? next.rc : prev.rc,
      }),
      replace: next.q !== undefined, // typing shouldn't spam history
    })

  // Debounce the search box → URL, so each keystroke doesn't refetch.
  const [searchDraft, setSearchDraft] = useState(search)
  useEffect(() => setSearchDraft(search), [search])
  useEffect(() => {
    if (searchDraft === search) return
    const t = setTimeout(() => go({ q: searchDraft }), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft])

  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => apiAll<{ id: string; name: string }>("/api/sites/?picker=1"),
    staleTime: 10 * 60_000,
    enabled: tab === "alerts",
  })

  // The Firing view leaves out what a down upstream explains (#450) unless
  // asked: the root cause is the one problem to look at.
  const hideExplained = state === "firing" && !explained
  const q = useQuery({
    queryKey: ["alerts", state, severity, ack, search, site, kind, explained],
    queryFn: () => {
      const p = new URLSearchParams({ status: state })
      if (hideExplained) p.set("explained", "exclude")
      if (severity !== "all") p.set("severity", severity)
      if (ack !== "all") p.set("ack", ack)
      if (search) p.set("q", search)
      if (site !== "all") p.set("site", site)
      if (kind) p.set("kind", kind)
      return api<AlertsResponse>(`/api/monitoring/alerts/?${p}`)
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    enabled: tab === "alerts",
  })

  const counts = q.data?.counts ?? {}
  const rows = q.data?.results ?? []

  // Severity + ack are single-select and server-side; the rail's "clear" is
  // what widens each one back to "any". Counts are the server's own aggregates
  // (firing-scoped, exactly the numbers the old chips showed).
  const acked = counts.acknowledged ?? 0
  const firing = counts.firing ?? 0
  const rail = (
    <FilterRail>
      <FacetGroup
        label="Severity"
        options={(["critical", "warning", "info"] as const).map((sv) => ({
          value: sv,
          label: sv[0].toUpperCase() + sv.slice(1),
          count: counts[sv] ?? 0,
        }))}
        selected={severity === "all" ? EMPTY_FACET : new Set([severity])}
        onToggle={(v) =>
          go({ severity: v === severity ? "all" : (v as AlertSeverity) })
        }
      />
      <FacetGroup
        label="Acknowledged"
        options={[
          { value: "unacknowledged", label: "Unacked", count: firing - acked },
          { value: "acknowledged", label: "Acked", count: acked },
        ]}
        selected={ack === "all" ? EMPTY_FACET : new Set([ack])}
        onToggle={(v) => go({ ack: v === ack ? "all" : (v as AckFilter) })}
      />
    </FilterRail>
  )

  const columns = useMemo(() => buildAlertColumns(), [])
  const explainedCount = counts.explained ?? 0

  const secondaryTab =
    tab === "root-causes" ? (
      <RootCausesList
        view={rc ?? "open"}
        onView={(v) => go({ rc: v === "resolved" ? "resolved" : undefined })}
      />
    ) : tab === "rules" ? (
      <div className="space-y-8">
        <AlertRulesList />
        <PortRulesList />
      </div>
    ) : tab === "channels" ? (
      <ChannelsList />
    ) : tab === "silences" ? (
      <SilencesList />
    ) : null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-4 lg:px-6">
        <SegmentedTabs
          value={tab}
          onValueChange={(v) => go({ tab: v as AlertsTab })}
          items={[
            { value: "alerts", label: "Alerts" },
            { value: "root-causes", label: "Root causes" },
            { value: "rules", label: "Rules" },
            { value: "channels", label: "Channels" },
            { value: "silences", label: "Silences" },
          ]}
        />
      </div>

      {tab === "root-causes" ? (
        secondaryTab
      ) : secondaryTab ? (
        <ListPageShell title="Alerts">{secondaryTab}</ListPageShell>
      ) : (
        <ListPageShell
          title="Alerts"
          count={q.data ? rows.length : undefined}
          rail={rail}
          search={{
            value: searchDraft,
            onChange: setSearchDraft,
            placeholder: "IP, description, rule…",
          }}
          actions={
            <>
              {/* Lifecycle is an either/or split of the whole list (never
                  "any"), so it stays a segmented switch rather than a facet. */}
              <SegmentedTabs<AlertLifecycle>
                value={state}
                onValueChange={(v) => go({ state: v })}
                items={[
                  {
                    value: "firing",
                    label: "Firing",
                    count:
                      counts.firing === undefined
                        ? undefined
                        : hideExplained
                          ? counts.firing - explainedCount
                          : counts.firing,
                  },
                  {
                    value: "resolved",
                    label: "Resolved",
                    count: counts.resolved,
                  },
                ]}
              />
              <Select value={site} onValueChange={(v) => go({ site: v })}>
                <SelectTrigger
                  className="h-8 w-40 text-xs"
                  aria-label="Filter by site"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sites</SelectItem>
                  {(sites.data?.results ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {state === "firing" && (
                <span className="flex items-center gap-1.5">
                  <Checkbox
                    id="show-explained"
                    checked={!!explained}
                    onCheckedChange={(v) =>
                      go({ explained: v ? true : undefined })
                    }
                  />
                  <Label
                    htmlFor="show-explained"
                    className="text-xs whitespace-nowrap"
                  >
                    Show explained
                    {explainedCount > 0 && (
                      <span className="num text-muted-foreground">
                        {explainedCount}
                      </span>
                    )}
                  </Label>
                </span>
              )}
            </>
          }
          query={q}
        >
          <DataTable
            tableId="alerts"
            data={rows}
            columns={columns}
            flexColumn="check"
          />
        </ListPageShell>
      )}
    </div>
  )
}
