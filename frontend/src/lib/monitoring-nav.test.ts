import { describe, expect, it } from "vitest"

import {
  CHECKS_VIEWS,
  legacyHref,
  legacyMonitoringTarget,
  LEGACY_VIEWS,
  monitoringSearch,
  STATUS_VIEWS,
} from "./monitoring-nav"

const href = (raw: Record<string, unknown>, hash?: string) => {
  const t = legacyMonitoringTarget(raw)
  return t ? legacyHref(t, hash) : null
}

describe("old /monitoring?view= links", () => {
  it("land on the page each tab moved to", () => {
    expect(href({ view: "checks", status: "all" })).toBe("/monitoring/checks")
    expect(href({ view: "templates" })).toBe(
      "/monitoring/checks?view=templates"
    )
    expect(href({ view: "explore" })).toBe("/monitoring/performance")
    expect(href({ view: "latency" })).toBe(
      "/monitoring/performance?view=latency"
    )
    expect(href({ view: "sla", status: "all" })).toBe("/monitoring/sla")
    expect(href({ view: "configuration" })).toBe("/monitoring/policies")
    expect(href({ view: "settings" })).toBe("/monitoring/settings")
    expect(href({ view: "discovery" })).toBe("/discovery")
  })

  it("stay put for the tabs that are still on /monitoring", () => {
    for (const view of ["overview", "history", "flapping"])
      expect(legacyMonitoringTarget({ view })).toBeNull()
    expect(legacyMonitoringTarget({})).toBeNull()
    expect(legacyMonitoringTarget({ view: "nonsense" })).toBeNull()
    expect(legacyMonitoringTarget({ view: "toString" })).toBeNull()
  })

  it("read `tab` as an alias of `view`", () => {
    expect(href({ tab: "discovery" })).toBe("/discovery")
    expect(href({ tab: "checks" })).toBe("/monitoring/checks")
  })

  it("keep their filters, scope and anchor", () => {
    expect(
      href({ view: "checks", status: "down", site: "abc", q: "10.0" })
    ).toBe("/monitoring/checks?status=down&site=abc&q=10.0")
    expect(href({ view: "configuration", scope: "platforms" })).toBe(
      "/monitoring/policies?scope=platforms"
    )
    expect(href({ view: "settings" }, "host-discovery")).toBe(
      "/monitoring/settings#host-discovery"
    )
    expect(href({ view: "explore", group_by: "role", days: "7" })).toBe(
      "/monitoring/performance?days=7&group_by=role"
    )
    // A bad scope and an unknown param are dropped, as the page would.
    expect(href({ view: "configuration", scope: "nope", foo: "1" })).toBe(
      "/monitoring/policies"
    )
  })

  it("cover every tab the one-page Monitoring had", () => {
    expect(Object.keys(LEGACY_VIEWS).sort()).toEqual(
      [
        "overview",
        "history",
        "checks",
        "explore",
        "latency",
        "sla",
        "flapping",
        "templates",
        "configuration",
        "discovery",
        "settings",
      ].sort()
    )
  })
})

describe("monitoringSearch", () => {
  it("keeps a page's own tab and drops its default", () => {
    const status = monitoringSearch(STATUS_VIEWS)
    expect(status({ view: "history" })).toEqual({ view: "history" })
    expect(status({ view: "overview" })).toEqual({})
    expect(status({ view: "checks" })).toEqual({})
    expect(status({ tab: "flapping" })).toEqual({ view: "flapping" })
    expect(monitoringSearch(CHECKS_VIEWS)({ view: "templates" })).toEqual({
      view: "templates",
    })
  })

  it("keeps the shared filters and drops the rest", () => {
    expect(
      monitoringSearch(STATUS_VIEWS)({
        view: "history",
        status: "all",
        to_status: "down",
        page: "2",
        empty: "",
        site: "",
        nope: "x",
      })
    ).toEqual({ view: "history", to_status: "down", page: "2" })
  })
})
