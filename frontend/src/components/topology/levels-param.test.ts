import { describe, expect, it } from "vitest"

import {
  EMPTY_LEVELS,
  formatLevels,
  parseLevels,
  sameLevels,
} from "./levels-param"

describe("levels URL param", () => {
  it("round-trips order, bonds and distances", () => {
    const s = {
      order: ["Firewall", "Core switch", "Distribution", "Access"],
      bonds: ["Core switch"],
      distance: { Distribution: 2 },
    }
    const raw = formatLevels(s)
    expect(raw).toBe("Firewall|Core%20switch+|Distribution:2|Access")
    expect(parseLevels(raw)).toEqual(s)
  })

  it("survives a role name containing the separators", () => {
    // A role called "Core|Edge: A+B" must not break the split - the name is
    // percent-encoded, so | + and : only ever appear as markers.
    const s = {
      order: ["Core|Edge: A+B", "Access"],
      bonds: ["Access"],
      distance: { "Core|Edge: A+B": 3 },
    }
    const parsed = parseLevels(formatLevels(s))
    expect(parsed).toEqual(s)
  })

  it("reads back as no levels when the param is empty or junk", () => {
    expect(parseLevels("")).toBeUndefined()
    expect(parseLevels("|||")).toBeUndefined()
  })

  it("drops duplicates - a role sits on exactly one tier", () => {
    expect(parseLevels("Core|Core|Access")?.order).toEqual(["Core", "Access"])
  })

  it("tolerates a malformed escape instead of throwing", () => {
    expect(parseLevels("%E0%A4%A")?.order).toEqual(["%E0%A4%A"])
  })

  it("compares two setups for the no-param default check", () => {
    expect(
      sameLevels(EMPTY_LEVELS, { order: [], bonds: [], distance: {} })
    ).toBe(true)
    expect(
      sameLevels(EMPTY_LEVELS, { order: ["Core"], bonds: [], distance: {} })
    ).toBe(false)
  })
})
