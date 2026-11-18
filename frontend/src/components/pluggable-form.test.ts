import { describe, expect, it } from "vitest"

import { cablePayload, linesOf } from "@/components/pluggable-form"

describe("pluggable form", () => {
  it("reads one entry per line or comma, blanks dropped", () => {
    expect(linesOf(" SFP-10G-LR \n\nSFP-10G-LR-S, SFP-10G-LR-X\n")).toEqual([
      "SFP-10G-LR",
      "SFP-10G-LR-S",
      "SFP-10G-LR-X",
    ])
    expect(linesOf("")).toEqual([])
  })

  it("sends no cable without a profile, and a pitch only for a zip cord", () => {
    const blank = { jacket: "2", pitch: "3", bend: "" }
    expect(cablePayload({ profile: "", ...blank })).toBeNull()
    expect(cablePayload({ profile: "zipcord", ...blank })).toEqual({
      profile: "zipcord",
      jacket_mm: 2,
      pitch_mm: 3,
      min_bend_mm: null,
    })
    expect(cablePayload({ profile: "round", ...blank, bend: "30" })).toEqual({
      profile: "round",
      jacket_mm: 2,
      pitch_mm: null,
      min_bend_mm: 30,
    })
  })

  it("sends a ribbon's count and keeps the per-part bends", () => {
    const blank = { jacket: "6", pitch: "8", bend: "40" }
    expect(
      cablePayload({
        profile: "ribbon",
        ...blank,
        count: "3",
        byPart: { "X-3M": 80 },
      })
    ).toEqual({
      profile: "ribbon",
      jacket_mm: 6,
      pitch_mm: 8,
      min_bend_mm: 40,
      count: 3,
      min_bend_by_part: { "X-3M": 80 },
    })
    expect(
      cablePayload({ profile: "zipcord", ...blank, count: "3", byPart: {} })
    ).toEqual({
      profile: "zipcord",
      jacket_mm: 6,
      pitch_mm: 8,
      min_bend_mm: 40,
    })
  })
})
