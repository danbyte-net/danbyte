// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  useUrlCsv,
  useUrlEnum,
  useUrlFlag,
  useUrlInt,
  useUrlText,
} from "./use-url-state"

// Stand-in router (same harness as use-url-tab.test.ts): `search` is what the
// URL carries, and `navigate` records the call so a test can run the setter's
// updater and assert exactly which params would be written.
let search: Record<string, unknown> = {}
const navigate = vi.fn()

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => search,
  useNavigate: () => navigate,
}))

/** The search object the last setter call would leave on the URL. */
function written(): Record<string, unknown> {
  const args = navigate.mock.calls.at(-1)?.[0] as {
    search: (prev: Record<string, unknown>) => Record<string, unknown>
  }
  return args.search(search)
}

const COLORS = ["cable", "type", "status", "speed", "none"] as const

beforeEach(() => {
  search = {}
  navigate.mockClear()
})

describe("useUrlEnum", () => {
  it("reads the param and falls back when it is absent", () => {
    expect(
      renderHook(() => useUrlEnum("color", "cable", COLORS)).result.current[0]
    ).toBe("cable")
    search = { color: "speed" }
    expect(
      renderHook(() => useUrlEnum("color", "cable", COLORS)).result.current[0]
    ).toBe("speed")
  })

  it("falls back for a value outside the allow-list instead of breaking", () => {
    search = { color: "purple" }
    expect(
      renderHook(() => useUrlEnum("color", "cable", COLORS)).result.current[0]
    ).toBe("cable")
  })

  it("honours a computed fallback - a saved view's setting, say", () => {
    expect(
      renderHook(() => useUrlEnum("color", "speed", COLORS)).result.current[0]
    ).toBe("speed")
  })

  it("writes the default as no param at all", () => {
    search = { color: "speed" }
    renderHook(() => useUrlEnum("color", "cable", COLORS)).result.current[1](
      "cable"
    )
    expect(written()).toEqual({ color: undefined })
  })

  it("keeps every other param when one setter runs", () => {
    search = { tab: "hierarchy", site: "s1" }
    renderHook(() => useUrlEnum("color", "cable", COLORS)).result.current[1](
      "speed"
    )
    expect(written()).toEqual({ tab: "hierarchy", site: "s1", color: "speed" })
  })

  it("pushes a history entry by default, replaces when asked", () => {
    renderHook(() => useUrlEnum("color", "cable", COLORS)).result.current[1](
      "type"
    )
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: ".", replace: false })
    )
    renderHook(() =>
      useUrlEnum("color", "cable", COLORS, { replace: true })
    ).result.current[1]("type")
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ replace: true })
    )
  })
})

describe("useUrlText", () => {
  it("round-trips text and drops the param when cleared", () => {
    search = { q: "core" }
    const { result } = renderHook(() => useUrlText("q"))
    expect(result.current[0]).toBe("core")
    result.current[1]("")
    expect(written()).toEqual({ q: undefined })
  })
})

describe("useUrlFlag", () => {
  it("reads 1/0 and writes only the non-default", () => {
    expect(
      renderHook(() => useUrlFlag("panels", false)).result.current[0]
    ).toBe(false)
    search = { panels: "1" }
    expect(
      renderHook(() => useUrlFlag("panels", false)).result.current[0]
    ).toBe(true)
    renderHook(() => useUrlFlag("panels", false)).result.current[1](true)
    expect(written()).toEqual({ panels: "1" })
    renderHook(() => useUrlFlag("panels", false)).result.current[1](false)
    expect(written()).toEqual({ panels: undefined })
  })
})

describe("useUrlInt", () => {
  it("clamps to the declared range, both reading and writing", () => {
    search = { depth: "99" }
    const { result } = renderHook(() =>
      useUrlInt("depth", 1, { min: 1, max: 6 })
    )
    expect(result.current[0]).toBe(6)
    result.current[1](0)
    expect(written()).toEqual({ depth: undefined }) // clamps to 1 = default
  })

  it("ignores a non-numeric value", () => {
    search = { depth: "deep" }
    expect(
      renderHook(() => useUrlInt("depth", 2, { min: 1, max: 6 })).result
        .current[0]
    ).toBe(2)
  })
})

describe("useUrlCsv", () => {
  it("keeps 'absent' and 'present but empty' apart", () => {
    // Absent - the page is in its normal mode.
    expect(renderHook(() => useUrlCsv("devices")).result.current[0]).toBe(null)
    // Present but empty - a deliberate empty set.
    search = { devices: "" }
    expect(renderHook(() => useUrlCsv("devices")).result.current[0]).toEqual([])
    search = { devices: "a,b" }
    expect(renderHook(() => useUrlCsv("devices")).result.current[0]).toEqual([
      "a",
      "b",
    ])
  })

  it("writes a list, an empty set, and clears back to absent", () => {
    const { result } = renderHook(() => useUrlCsv("devices"))
    result.current[1](["a", "b"])
    expect(written()).toEqual({ devices: "a,b" })
    result.current[1]([])
    expect(written()).toEqual({ devices: "" })
    result.current[1](null)
    expect(written()).toEqual({ devices: undefined })
  })
})
