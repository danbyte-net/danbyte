import type { CheckStatus } from "@/lib/api"
import { CONFIG_TABS } from "@/components/monitoring/configuration/tabs"
import type { ConfigTab } from "@/components/monitoring/configuration/tabs"

// Monitoring is a sidebar section of its own: Status, Checks, Performance,
// SLAs, Policies and Settings are routes under /monitoring, each with at most
// one row of tabs (`?view=`, or Policies' `?scope=`). Every page validates the
// same filter params, so the history and checks filters survive navigation: a
// param the route does not validate is dropped when the router rebuilds the
// location (#109).

export const MONITORING_FILTER_KEYS = [
  "to_status",
  "from_status",
  "kind",
  "source",
  "site",
  "device_type",
  "role",
  "platform",
  "template",
  "engine",
  "region",
  "device",
  "prefix",
  "vrf",
  "vlan",
  "tag",
  "port",
  "ip",
  "q",
  "page",
  "ordering",
  "days",
  "since",
  "until",
  "strip",
  "flapping",
  "excluded",
  "dow",
  "hour",
  "group_by",
] as const
export type MonitoringFilterKey = (typeof MONITORING_FILTER_KEYS)[number]

export interface MonitoringSearch<
  TView extends string = string,
> extends Partial<Record<MonitoringFilterKey, string>> {
  /** The page's tab; absent means its first one. */
  view?: TView
  status?: CheckStatus | "all"
  /** Policies: the scope tab; absent means the default. */
  scope?: ConfigTab
}

export const STATUS_VIEWS = ["overview", "flapping", "history"] as const
export const CHECKS_VIEWS = ["checks", "templates"] as const
export const PERFORMANCE_VIEWS = ["explore", "latency"] as const
export type StatusView = (typeof STATUS_VIEWS)[number]
export type ChecksView = (typeof CHECKS_VIEWS)[number]
export type PerformanceView = (typeof PERFORMANCE_VIEWS)[number]

/** A page's `validateSearch`: its own tabs (`tab` read as an alias of
 * `view`), the status filter, the policy scope and the shared filters. The
 * first tab is the default and never written. */
export function monitoringSearch<TView extends string>(
  views: readonly TView[]
) {
  return (s: Record<string, unknown>): MonitoringSearch<TView> => {
    const view = (s.view ?? s.tab) as TView
    return {
      ...(views.includes(view) && view !== views[0] ? { view } : {}),
      ...(typeof s.status === "string" && s.status !== "all"
        ? { status: s.status as CheckStatus }
        : {}),
      ...(CONFIG_TABS.includes(s.scope as ConfigTab)
        ? { scope: s.scope as ConfigTab }
        : {}),
      ...Object.fromEntries(
        MONITORING_FILTER_KEYS.filter(
          (k) => typeof s[k] === "string" && s[k] !== ""
        ).map((k) => [k, String(s[k])])
      ),
    }
  }
}

/** Where each tab of the old one-page Monitoring (`/monitoring?view=…`) lives
 * now: the route, and the tab on it (none for the route's first). */
export const LEGACY_VIEWS: Record<string, { to: string; view?: string }> = {
  overview: { to: "/monitoring" },
  flapping: { to: "/monitoring", view: "flapping" },
  history: { to: "/monitoring", view: "history" },
  checks: { to: "/monitoring/checks" },
  templates: { to: "/monitoring/checks", view: "templates" },
  explore: { to: "/monitoring/performance" },
  latency: { to: "/monitoring/performance", view: "latency" },
  sla: { to: "/monitoring/sla" },
  configuration: { to: "/monitoring/policies" },
  settings: { to: "/monitoring/settings" },
  discovery: { to: "/discovery" },
}

/** The redirect an old `/monitoring?view=<tab>` (or `?tab=<tab>`) link
 * needs, with every filter it carried; null when it already lands here. */
export function legacyMonitoringTarget(
  raw: Record<string, unknown>
): { to: string; search: Record<string, string> } | null {
  const old = raw.view ?? raw.tab
  if (typeof old !== "string") return null
  const target = Object.hasOwn(LEGACY_VIEWS, old) ? LEGACY_VIEWS[old] : null
  if (!target || target.to === "/monitoring") return null
  const search: Record<string, string> = {}
  if (target.to !== "/discovery") {
    const kept = monitoringSearch<string>([])({ ...raw, view: undefined })
    for (const [k, v] of Object.entries(kept))
      if (typeof v === "string") search[k] = v
    if (target.view) search.view = target.view
  }
  return { to: target.to, search }
}

/** The URL a legacy redirect goes to: the route, its search and the hash
 * (a settings card's anchor) the old link carried. */
export function legacyHref(
  target: { to: string; search: Record<string, string> },
  hash?: string
): string {
  const qs = new URLSearchParams(target.search).toString()
  return `${target.to}${qs ? `?${qs}` : ""}${hash ? `#${hash}` : ""}`
}
