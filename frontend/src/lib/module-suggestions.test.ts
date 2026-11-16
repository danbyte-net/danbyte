import { describe, expect, it } from "vitest"

import { moduleTypePicks } from "./module-suggestions"

const types = [
  { id: "a", name: "350W", part_number: "PWR-C1-350WAC-P" },
  { id: "b", name: "715W", part_number: "PWR-C1-715WAC-P" },
  { id: "c", name: "NM-8X", part_number: "C9300-NM-8X" },
  { id: "d", name: "Blank", part_number: "" },
]

describe("moduleTypePicks", () => {
  it("puts the bay's suggestions first, the rest after", () => {
    const picks = moduleTypePicks(types, [" pwr-c1-715wac-p "], [types[2]])
    expect(picks.map((p) => [p.value, p.group])).toEqual([
      ["b", "Suggested"],
      ["a", "All module types"],
      ["c", "All module types"],
      ["d", "All module types"],
    ])
    expect(picks[0].label).toBe("715W (PWR-C1-715WAC-P)")
  })

  it("falls back to the chassis manufacturer first", () => {
    const picks = moduleTypePicks(types, [], [types[2]], "Cisco")
    expect(picks.map((p) => [p.value, p.group])).toEqual([
      ["c", "Cisco"],
      ["a", "All module types"],
      ["b", "All module types"],
      ["d", "All module types"],
    ])
  })

  it("suggestions the tenant lacks fall back as if there were none", () => {
    const picks = moduleTypePicks(types, ["NOT-HERE"], [types[0]])
    expect(picks[0]).toMatchObject({
      value: "a",
      group: "Chassis manufacturer",
    })
  })

  it("one plain list without either", () => {
    const picks = moduleTypePicks(types, undefined, null)
    expect(picks.map((p) => p.value)).toEqual(["a", "b", "c", "d"])
    expect(picks.every((p) => p.group === undefined)).toBe(true)
  })
})
