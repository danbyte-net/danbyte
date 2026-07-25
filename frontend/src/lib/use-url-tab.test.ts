// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { useUrlSubTab, useUrlTab } from "./use-url-tab"

// Stand-in router: `search` is what the URL currently carries, and `navigate`
// records the call so a test can run the setter's updater and assert exactly
// which search params would be written. No router, no DOM navigation.
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

const TABS = ["overview", "components", "history"] as const
const SUBS = ["interfaces", "console", "power", "hardware"] as const

beforeEach(() => {
  search = {}
  navigate.mockClear()
})

describe("useUrlTab", () => {
  it("falls back to the default with no param, and reads the param when set", () => {
    expect(renderHook(() => useUrlTab("overview")).result.current[0]).toBe(
      "overview"
    )
    search = { tab: "history" }
    expect(renderHook(() => useUrlTab("overview")).result.current[0]).toBe(
      "history"
    )
  })

  it("takes any string when no allow-list is given (unchanged behaviour)", () => {
    search = { tab: "nonsense" }
    expect(renderHook(() => useUrlTab("overview")).result.current[0]).toBe(
      "nonsense"
    )
  })

  it("falls back to the default for a value outside the allow-list", () => {
    search = { tab: "nonsense" }
    const { result } = renderHook(() => useUrlTab("overview", "tab", TABS))
    expect(result.current[0]).toBe("overview")
  })

  it("writes the default as no param at all", () => {
    search = { tab: "history" }
    renderHook(() => useUrlTab("overview", "tab", TABS)).result.current[1](
      "overview"
    )
    expect(written()).toEqual({ tab: undefined })
  })
})

describe("useUrlSubTab", () => {
  it("reads ?sub= and falls back to the default for a junk value", () => {
    search = { tab: "components", sub: "power" }
    expect(
      renderHook(() => useUrlSubTab("interfaces", SUBS)).result.current[0]
    ).toBe("power")
    search = { tab: "components", sub: "nonsense" }
    expect(
      renderHook(() => useUrlSubTab("interfaces", SUBS)).result.current[0]
    ).toBe("interfaces")
  })

  it("is independent of ?tab= — each setter keeps the other's param", () => {
    search = { tab: "components" }
    renderHook(() => useUrlSubTab("interfaces", SUBS)).result.current[1](
      "power"
    )
    expect(written()).toEqual({ tab: "components", sub: "power" })

    // …and the top-level tab moves without dropping the sub-tab, so leaving
    // Components and coming back lands back on the same sub-tab.
    search = { tab: "components", sub: "power" }
    renderHook(() => useUrlTab("overview", "tab", TABS)).result.current[1](
      "history"
    )
    expect(written()).toEqual({ tab: "history", sub: "power" })
  })

  it("pushes a history entry so back/forward walks sub-tabs", () => {
    renderHook(() => useUrlSubTab("interfaces", SUBS)).result.current[1](
      "hardware"
    )
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: ".", replace: false })
    )
  })
})
