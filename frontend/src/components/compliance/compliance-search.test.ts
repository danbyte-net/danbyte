import { describe, expect, it } from "vitest"

import type { ComplianceViolation } from "@/lib/api"

import {
  filterRules,
  groupRules,
  normalizeComplianceSearch,
  sortRulesWorstFirst,
} from "./compliance-search"
import { countOf } from "./compliance-shared"
import { localIsoDate, startOfDay } from "./triage-bar"
import { matchViolation, sortViolations } from "./violations-tab"

const rule = (
  name: string,
  severity: "critical" | "warning" | "info",
  violations: number,
  open = violations,
  object_type = "device"
) => ({
  id: name,
  name,
  severity,
  violations,
  open,
  object_type,
  object_type_label: object_type === "device" ? "Device" : "Prefix",
})

describe("the compliance URL", () => {
  it("opens on the overview and drops what it does not know", () => {
    expect(normalizeComplianceSearch({})).toMatchObject({ tab: "overview" })
    expect(
      normalizeComplianceSearch({ tab: "nope", group: "x", by: "colour" })
    ).toMatchObject({ tab: "overview", group: undefined, by: undefined })
  })

  it("keeps the violation facets and the overview's rule filters", () => {
    expect(
      normalizeComplianceSearch({
        tab: "violations",
        rule: "a,b",
        state: "open",
        site: "none",
        tag: "pci",
        group: "rule",
        failing: "1",
        by: "severity",
        rq: "serial",
      })
    ).toEqual({
      tab: "violations",
      q: undefined,
      severity: undefined,
      type: undefined,
      rule: "a,b",
      device: undefined,
      site: "none",
      tag: "pci",
      state: "open",
      group: "rule",
      rq: "serial",
      failing: "1",
      by: "severity",
    })
  })
})

describe("rule cards", () => {
  const rows = [
    rule("ok", "critical", 0),
    rule("info", "info", 9),
    rule("crit-triaged", "critical", 4, 0),
    rule("warn", "warning", 1),
    rule("crit", "critical", 2),
  ]

  it("sort worst first: open failures by severity, passing last", () => {
    expect(sortRulesWorstFirst(rows).map((r) => r.name)).toEqual([
      "crit",
      "warn",
      "info",
      "crit-triaged",
      "ok",
    ])
  })

  it("hide passing rules and match the name", () => {
    expect(
      filterRules(rows, { failingOnly: true }).map((r) => r.name)
    ).not.toContain("ok")
    expect(filterRules(rows, { q: "CRIT" }).map((r) => r.name)).toEqual([
      "crit-triaged",
      "crit",
    ])
  })

  it("group by severity, critical first, keeping the order inside", () => {
    const g = groupRules(sortRulesWorstFirst(rows), "severity")
    expect(g.map((x) => x.label)).toEqual(["Critical", "Warning", "Info"])
    expect(g[0].rows.map((r) => r.name)).toEqual(["crit", "crit-triaged", "ok"])
  })

  it("group by object type", () => {
    const g = groupRules(
      [rule("a", "info", 1, 1, "prefix"), rule("b", "info", 1)],
      "type"
    )
    expect(g.map((x) => x.label)).toEqual(["Prefix", "Device"])
  })

  it("count in the rule's object type", () => {
    expect(countOf("device", 3)).toBe("3 devices")
    expect(countOf("ipaddress", 1)).toBe("1 IP address")
    expect(countOf("prefix", 2)).toBe("2 prefixes")
  })
})

describe("the violation list", () => {
  const v = (over: Partial<ComplianceViolation> = {}): ComplianceViolation => ({
    rule_id: "r1",
    rule_name: "Serial",
    severity: "warning",
    object_type: "device",
    object_type_label: "Device",
    object_route: "devices",
    object_id: "d1",
    object_repr: "sw1",
    site_id: "s1",
    site_name: "AMS",
    tags: ["pci"],
    state: "open",
    ...over,
  })

  it("matches the URL facets like the API does", () => {
    expect(matchViolation(v(), { site: "s1,s2", tag: "pci,dmz" })).toBe(true)
    expect(matchViolation(v({ site_id: null }), { site: "none" })).toBe(true)
    expect(matchViolation(v(), { state: "acknowledged" })).toBe(false)
    expect(matchViolation(v(), { rule: "r2" })).toBe(false)
    expect(matchViolation(v(), { tag: "dmz" })).toBe(false)
    expect(matchViolation(v(), { q: "seri" })).toBe(true)
    expect(matchViolation(v(), { device: "d2" })).toBe(false)
  })

  it("sorts critical first and open before triaged", () => {
    const rows = [
      v({ object_repr: "a", state: "acknowledged", severity: "critical" }),
      v({ object_repr: "b" }),
      v({ object_repr: "c", severity: "critical" }),
    ]
    expect(sortViolations(rows).map((r) => r.object_repr)).toEqual([
      "c",
      "a",
      "b",
    ])
  })
})

describe("snooze dates", () => {
  it("snooze until the local start of the picked day", () => {
    const d = startOfDay("2026-11-03")
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([
      2026, 10, 3, 0,
    ])
    expect(localIsoDate(d)).toBe("2026-11-03")
  })
})
