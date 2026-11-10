import { describe, expect, it } from "vitest"

import {
  bulkPayload,
  chosenCandidate,
  coverage,
  nextStep,
  preselect,
  rowErrors,
} from "@/lib/vuln-suggestions"
import type {
  MappingSuggestion,
  SuggestionCandidate,
  SuggestionConfidence,
  SuggestionSource,
} from "@/lib/vuln-suggestions"

function cand(
  identifier: string,
  confidence: SuggestionConfidence,
  source: SuggestionSource = "known"
): SuggestionCandidate {
  const [, , part, vendor, product] = identifier.split(":")
  return {
    kind: "cpe",
    part: part as "o",
    vendor,
    product,
    identifier,
    source,
    confidence,
    title: "",
    version_scheme: "auto",
    scheme: "generic",
  }
}

function row(
  id: string,
  candidates: SuggestionCandidate[],
  patch: Partial<MappingSuggestion> = {}
): MappingSuggestion {
  return {
    subject_type: "platform",
    id,
    name: id,
    manufacturer: "",
    purl_template: "",
    cpe_template: "",
    in_use: 4,
    without_version: 1,
    candidates,
    ...patch,
  }
}

const ROWS = [
  row("xe", [
    cand("cpe:2.3:o:cisco:ios_xe", "high", "sbom"),
    cand("cpe:2.3:o:cisco:ios", "low", "local"),
  ]),
  row("ios", [cand("cpe:2.3:o:cisco:ios", "medium")]),
  row("odd", []),
  row("c9300", [cand("cpe:2.3:h:cisco:catalyst_9300", "high", "local")], {
    subject_type: "device_type",
    without_version: 0,
  }),
]

describe("preselect", () => {
  it("ticks only rows whose best candidate is high confidence", () => {
    expect([...preselect(ROWS)].sort()).toEqual(["c9300", "xe"])
  })
})

describe("bulkPayload", () => {
  it("sends the ticked rows with their pick and a non-automatic scheme", () => {
    const { body, ids } = bulkPayload(
      ROWS,
      new Set(["xe", "ios", "odd", "c9300"]),
      { xe: "cpe:2.3:o:cisco:ios" },
      { xe: "cisco_ios", ios: "auto", c9300: "semver" }
    )
    expect(ids).toEqual(["xe", "ios", "c9300"])
    expect(body).toEqual([
      {
        platform: "xe",
        identifier: "cpe:2.3:o:cisco:ios",
        version_scheme: "cisco_ios",
      },
      { platform: "ios", identifier: "cpe:2.3:o:cisco:ios" },
      { device_type: "c9300", identifier: "cpe:2.3:h:cisco:catalyst_9300" },
    ])
  })

  it("falls back to the best candidate for an unknown pick", () => {
    expect(chosenCandidate(ROWS[0], { xe: "gone" })?.identifier).toBe(
      "cpe:2.3:o:cisco:ios_xe"
    )
  })
})

describe("rowErrors", () => {
  it("moves index keys onto subject ids", () => {
    expect(
      rowErrors({ "1": { identifier: ["Already mapped."] }, "7": "x" }, [
        "a",
        "b",
      ])
    ).toEqual({ b: "Already mapped." })
  })
})

describe("coverage and next step", () => {
  it("counts what the ticked rows cover and what lacks a version", () => {
    expect(coverage(ROWS, new Set(["xe", "ios", "odd"]))).toEqual({
      covered: 8,
      blank: 2,
    })
  })

  it("says what happens per update source", () => {
    expect(nextStep("server", ["a"])).toMatch(/Fetching/)
    expect(nextStep("browser", ["a"])).toMatch(/Sync now/)
    expect(nextStep("upload", ["a", "b", "c", "d"])).toBe(
      "Import NVD or OSV records for a, b, c +1."
    )
  })
})
