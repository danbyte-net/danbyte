import { describe, expect, it } from "vitest"

import {
  isSiteWide,
  scopeKey,
  scopeLocationIds,
  scopeName,
  scopeRoomsUrl,
} from "./floor-plan-scope"

// A floor spans its location and the locations inside it, or - on a
// site-wide floor plan - its whole site.

const site = { id: "s1", name: "Campus" }
const located = { site, location: { id: "a", name: "Building A", slug: "a" } }
const siteWide = { site, location: null }

const ALL = [
  { id: "a", parent: null },
  { id: "a1", parent: { id: "a" } },
  { id: "a1x", parent: { id: "a1" } },
  { id: "b", parent: null },
]

describe("a floor's scope", () => {
  it("is its location and what is inside it", () => {
    expect(isSiteWide(located)).toBe(false)
    expect(scopeKey(located)).toBe("a")
    expect(scopeName(located)).toBe("Building A")
    expect(scopeRoomsUrl(located)).toBe(
      "/api/rooms/?picker=1&location=a&include_descendants=1"
    )
    expect([...scopeLocationIds(located, ALL)].sort()).toEqual([
      "a",
      "a1",
      "a1x",
    ])
  })

  it("is the whole site with no location", () => {
    expect(isSiteWide(siteWide)).toBe(true)
    expect(scopeKey(siteWide)).toBe("site:s1")
    expect(scopeName(siteWide)).toBe("Campus")
    expect(scopeRoomsUrl(siteWide)).toBe("/api/rooms/?picker=1&site=s1")
    expect(scopeLocationIds(siteWide, ALL).size).toBe(4)
  })
})
