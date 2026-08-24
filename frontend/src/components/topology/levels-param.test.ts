import { describe, expect, it } from "vitest"

import {
  EMPTY_LEVELS,
  formatLevels,
  parseLevels,
  roleTiers,
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

  it("spells 'no tiers' explicitly, so a link can turn a view's tiers off", () => {
    expect(formatLevels(EMPTY_LEVELS)).toBe("none")
    expect(parseLevels("none")).toEqual(EMPTY_LEVELS)
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

describe("roleTiers", () => {
  const roles = ["Access", "Core", "Firewall", "Server", "Wireless"]

  it("keeps the organiser's order and bonded tiers", () => {
    const { rank } = roleTiers(roles, [["Firewall"], ["Core", "Router"]])
    expect(rank.get("Firewall")).toBe(0)
    expect(rank.get("Core")).toBe(1)
    expect(rank.get("Router")).toBe(1)
  })

  it("gives every unordered role its own tier instead of one heap", () => {
    const { rank, fallback } = roleTiers(roles, [["Firewall"], ["Core"]])
    // Access / Server / Wireless are unordered: three separate tiers, not one.
    const extras = [
      rank.get("Access"),
      rank.get("Server"),
      rank.get("Wireless"),
    ]
    expect(new Set(extras).size).toBe(3)
    expect(extras.every((t) => t !== undefined && t >= 2)).toBe(true)
    expect(fallback).toBe(5)
  })

  it("appends unordered roles the way the organiser lists them", () => {
    // The organiser shows the saved order first, then the rest in graph
    // order - the canvas must tier them the same way, or the panel and the
    // map disagree about which level a role sits on.
    const { rank } = roleTiers(["Server", "Access", "Server"], [["Core"]])
    expect(rank.get("Core")).toBe(0)
    expect(rank.get("Server")).toBe(1)
    expect(rank.get("Access")).toBe(2)
  })
})
