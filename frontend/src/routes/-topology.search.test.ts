import { describe, expect, it } from "vitest"

import { Route } from "./topology.index"
import type { TopologySearch } from "./topology.index"

// The topology map's address. Wiring and Flat are retired into the
// Diagram: a link that still names them opens the Diagram in the mode that
// tab drew, so old bookmarks and shared links keep working.

const validate = (s: Record<string, unknown>) =>
  (
    Route.options.validateSearch as (
      s: Record<string, unknown>
    ) => TopologySearch
  )(s)

describe("topology search params", () => {
  it("folds the Wiring tab into the Diagram's Detailed mode", () => {
    expect(validate({ tab: "wiring" })).toEqual({
      tab: "diagram",
      mode: "detailed",
      line: "elbow",
    })
    expect(validate({ tab: "stencil", site: "s1" })).toEqual({
      tab: "diagram",
      mode: "detailed",
      line: "elbow",
      site: "s1",
    })
  })

  it("folds the Flat tab into Simple, whatever mode rode beside it", () => {
    expect(validate({ tab: "flat" })).toEqual({
      tab: "diagram",
      mode: "simple",
      line: "bendy",
    })
    expect(validate({ tab: "flat", mode: "detailed" })).toEqual({
      tab: "diagram",
      mode: "simple",
      line: "bendy",
    })
  })

  it("draws a retired tab's cables as its routing did", () => {
    const line = (s: Record<string, unknown>) => validate(s).line
    expect(line({ tab: "wiring", cables: "routed" })).toBe("elbow")
    expect(line({ tab: "wiring", cables: "curved" })).toBe("bendy")
    expect(line({ tab: "stencil", cables: "straight" })).toBe("straight")
    expect(line({ tab: "flat", cables: "straight" })).toBe("straight")
    // A line the link names wins; the tabs that stay add none.
    expect(line({ tab: "wiring", line: "cyclical" })).toBe("cyclical")
    expect(line({ tab: "diagram", cables: "curved" })).toBeUndefined()
  })

  it("keeps the tabs that stay, and their mode", () => {
    expect(validate({ tab: "diagram", mode: "simple" })).toEqual({
      tab: "diagram",
      mode: "simple",
    })
    expect(validate({ tab: "hierarchy" })).toEqual({ tab: "hierarchy" })
    expect(validate({ tab: "logical", vms: "0" })).toEqual({
      tab: "logical",
      vms: false,
    })
  })

  it("leaves the tab to the default when none is named", () => {
    expect(validate({})).toEqual({})
    expect(validate({ tab: "faceplates" })).toEqual({})
    expect(validate({ mode: "bogus" })).toEqual({})
  })
})
