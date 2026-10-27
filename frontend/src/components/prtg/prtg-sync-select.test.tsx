import { describe, expect, it } from "vitest"

import { prtgSaveToast } from "./prtg-sync-select"

describe("prtgSaveToast", () => {
  it("says what the save made of the PRTG setting", () => {
    expect(prtgSaveToast({ state: "planned", connections: ["a"] })).toBe(
      "Planned for PRTG"
    )
    expect(prtgSaveToast({ state: "applying", connections: ["a"] })).toBe(
      "Being added to PRTG"
    )
    expect(prtgSaveToast({ state: "none", connections: [] })).toBeNull()
    expect(prtgSaveToast(null)).toBeNull()
  })

  it("names the first issue when a row needs attention", () => {
    expect(
      prtgSaveToast({
        state: "attention",
        connections: ["a"],
        object: { kind: "device", id: "d1" },
        issue: {
          code: "no_address",
          text: "It has no address PRTG can poll.",
          object: { kind: "device", id: "d1" },
        },
      })
    ).toBe("PRTG needs attention: It has no address PRTG can poll.")
  })
})
