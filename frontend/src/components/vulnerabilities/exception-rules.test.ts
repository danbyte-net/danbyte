import { describe, expect, it } from "vitest"

import type { VulnException, VulnMatch } from "@/lib/api"
import {
  addDays,
  analysisFor,
  createBodies,
  defaultAnalysis,
  defaultScope,
  editPatch,
  expiryError,
  expiryState,
  maxExpiry,
  scopeOptions,
  subjectOf,
} from "./exception-rules"

// The exception dialog's rules (#451): expiry as the API checks it, the
// CycloneDX defaults per status, the scopes a role may pick, and the bodies
// several selected matches turn into.

const TODAY = "2026-11-10"

function match(patch: Partial<VulnMatch> = {}): VulnMatch {
  return {
    id: "m1",
    cve: {
      vuln_id: "CVE-2023-20198",
      aliases: [],
      summary: "",
      published: null,
      cvss_version: "3.1",
      cvss_score: "10.0",
      cvss_severity: "critical",
      attack_vector: "network",
      kev: true,
      kev_added: "2023-10-16",
      kev_due: null,
      epss: null,
      epss_percentile: null,
      analysed: true,
    },
    priority: "fix_first",
    confidence: "range",
    via: "platform",
    version: "17.9.4",
    device: { id: "d1", name: "sw-01" },
    virtual_machine: null,
    installed_software: null,
    mapping: {
      id: "map1",
      identifier: "cpe:2.3:o:cisco:ios_xe",
      platform: { id: "p1", name: "IOS-XE" },
    },
    exception: null,
    first_seen_at: "2026-11-01T00:00:00Z",
    last_seen_at: "2026-11-10T00:00:00Z",
    resolved_at: null,
    ...patch,
  }
}

const appMatch = match({
  id: "m2",
  via: "application",
  device: null,
  virtual_machine: { id: "v1", name: "db1" },
  installed_software: {
    id: "i1",
    version: "16.4",
    application: { id: "a1", name: "PostgreSQL" },
  },
  mapping: { id: "map2", identifier: "cpe:2.3:a:postgresql:postgresql" },
  cve: { ...match().cve, vuln_id: "CVE-2024-0003" },
})

const ALL = [
  "device",
  "virtual_machine",
  "platform",
  "application",
  "tenant",
] as const

describe("expiry", () => {
  it("is required for a risk acceptance, at most 365 days ahead", () => {
    expect(expiryError("risk_accepted", "", TODAY)).toMatch(/needs an expiry/)
    expect(expiryError("risk_accepted", addDays(TODAY, 365), TODAY)).toBeNull()
    expect(expiryError("risk_accepted", addDays(TODAY, 366), TODAY)).toMatch(
      /365 days/
    )
    expect(maxExpiry("risk_accepted", TODAY)).toBe("2027-11-10")
  })

  it("is optional for not applicable, never in the past", () => {
    expect(expiryError("not_applicable", "", TODAY)).toBeNull()
    expect(expiryError("not_applicable", "2030-01-01", TODAY)).toBeNull()
    expect(expiryError("not_applicable", "2026-11-09", TODAY)).toMatch(/past/)
    expect(maxExpiry("not_applicable", TODAY)).toBeUndefined()
  })

  it("reads as expiring within 30 days and expired after", () => {
    expect(expiryState(null, TODAY)).toBe("none")
    expect(expiryState("2026-11-09", TODAY)).toBe("expired")
    expect(expiryState(TODAY, TODAY)).toBe("expiring")
    expect(expiryState(addDays(TODAY, 30), TODAY)).toBe("expiring")
    expect(expiryState(addDays(TODAY, 31), TODAY)).toBe("ok")
  })
})

describe("analysis", () => {
  it("defaults from the status", () => {
    expect(defaultAnalysis("not_applicable")).toEqual({
      state: "not_affected",
      justification: "",
      response: [],
    })
    expect(defaultAnalysis("risk_accepted")).toEqual({
      state: "exploitable",
      justification: "",
      response: ["will_not_fix"],
    })
  })

  it("falls back when the status cannot carry the state", () => {
    const na = {
      state: "not_affected" as const,
      justification: "code_not_reachable" as const,
      response: [],
    }
    expect(analysisFor("not_applicable", na)).toEqual(na)
    expect(analysisFor("risk_accepted", na).state).toBe("exploitable")
    expect(
      analysisFor("not_applicable", { ...na, state: "false_positive" })
        .justification
    ).toBe("")
  })
})

describe("scope options", () => {
  it("offers host, subject and tenant to an unlimited role", () => {
    const opts = scopeOptions([match()], ALL, "device")
    expect(opts.map((o) => [o.value, o.label])).toEqual([
      ["host", "This device"],
      ["subject", "Its platform or application"],
      ["tenant", "Whole tenant"],
    ])
    expect(defaultScope(opts, "device")).toBe("host")
  })

  it("gives a site-limited role the host scope only", () => {
    const opts = scopeOptions(
      [match(), appMatch],
      ["device", "virtual_machine"]
    )
    expect(opts.map((o) => o.value)).toEqual(["host"])
    expect(opts[0].covers).toBe(2)
  })

  it("leaves out a scope the role may not view or a match cannot take", () => {
    // Only device: the VM match is out of host, nothing has a subject.
    const opts = scopeOptions([match(), appMatch], ["device", "tenant"])
    expect(opts.map((o) => [o.value, o.covers])).toEqual([
      ["host", 1],
      ["tenant", 2],
    ])
    const noPlatform = match({
      mapping: { id: "m", identifier: "cpe:2.3:h:cisco:c9300", platform: null },
    })
    expect(subjectOf(noPlatform, "subject")).toBeNull()
    expect(scopeOptions([noPlatform], ALL).map((o) => o.value)).toEqual([
      "host",
      "tenant",
    ])
  })

  it("opens a platform page on its platform", () => {
    const opts = scopeOptions([match()], ALL, "platform")
    expect(opts[1].label).toBe("This platform")
    expect(defaultScope(opts, "platform")).toBe("subject")
  })
})

describe("bodies", () => {
  const draft = {
    status: "risk_accepted" as const,
    reason: "  Patch window in Q1 ",
    owner: 5,
    expires: "2027-01-31",
    analysis: defaultAnalysis("risk_accepted"),
  }

  it("writes one per record and subject", () => {
    const twin = match({ id: "m3", device: { id: "d2", name: "sw-02" } })
    const host = createBodies([match(), twin, appMatch], "host", draft)
    expect(
      host.map((b) => [b.vuln_id, b.device_id, b.virtual_machine_id])
    ).toEqual([
      ["CVE-2023-20198", "d1", undefined],
      ["CVE-2023-20198", "d2", undefined],
      ["CVE-2024-0003", undefined, "v1"],
    ])
    expect(host[0]).toMatchObject({
      status: "risk_accepted",
      reason: "Patch window in Q1",
      owner_id: 5,
      expires_on: "2027-01-31",
      analysis_state: "exploitable",
      analysis_response: ["will_not_fix"],
    })
    const subject = createBodies([match(), twin, appMatch], "subject", draft)
    expect(subject.map((b) => [b.platform_id, b.application_id])).toEqual([
      ["p1", undefined],
      [undefined, "a1"],
    ])
    const tenant = createBodies([match(), twin], "tenant", draft)
    expect(tenant).toHaveLength(1)
    expect(Object.keys(tenant[0])).not.toContain("device_id")
  })

  it("patches only what changed on an edit", () => {
    const ex = {
      status: "risk_accepted",
      reason: "Patch window in Q1",
      owner: { id: 5, username: "alice", display_name: "Alice" },
      expires_on: "2027-01-31",
      analysis_state: "exploitable",
      analysis_justification: "",
      analysis_response: ["will_not_fix"],
    } as unknown as VulnException
    expect(editPatch(ex, draft)).toEqual({})
    expect(
      editPatch(ex, { ...draft, expires: "2027-02-28", owner: 6 })
    ).toEqual({ expires_on: "2027-02-28", owner_id: 6 })
  })
})
