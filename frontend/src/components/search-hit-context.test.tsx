import { describe, expect, it } from "vitest"

import { hitPairs } from "./search-hit-context"

// A search hit's details read as labelled pairs, where it is first.

describe("hitPairs", () => {
  it("says where a device sits in a cabinet, after its site", () => {
    const hit = {
      context: {
        type: "PLC",
        cabinet: "K1 · R1 @ 120 mm",
        site: "Plant",
      },
    }
    expect(hitPairs(hit)).toEqual([
      ["Site", "Plant"],
      ["Cabinet", "K1 · R1 @ 120 mm"],
      ["Type", "PLC"],
    ])
  })
})
