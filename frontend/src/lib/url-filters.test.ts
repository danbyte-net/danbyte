// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  SEARCH_DEBOUNCE_MS,
  decodeList,
  decodeRange,
  encodeList,
  encodeRange,
  pruneUnknown,
  useUrlSearch,
  useUrlSet,
} from "./url-filters"

// Stand-in router (the use-url-state.test.ts harness): `search` is what the
// URL carries; `navigate` records each call so a test can run its updater.
let search: Record<string, unknown> = {}
const navigate = vi.fn()

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => search,
  useNavigate: () => navigate,
}))

type Nav = {
  to: string
  replace: boolean
  search: (prev: Record<string, unknown>) => Record<string, unknown>
}
const lastNav = () => navigate.mock.calls.at(-1)?.[0] as Nav
const written = () => lastNav().search(search)
const flush = () => act(async () => await Promise.resolve())

beforeEach(() => {
  search = {}
  navigate.mockClear()
})

describe("the list codec", () => {
  it("round-trips values, commas and backslashes included", () => {
    const values = ["active", "a,b", "c\\d", "x\\,y"]
    expect(decodeList(encodeList(values))).toEqual(values)
    expect(encodeList(["active", "planned"])).toBe("active,planned")
  })

  it("writes nothing for an empty selection", () => {
    expect(encodeList([])).toBeUndefined()
    expect(encodeList([""])).toBeUndefined()
  })

  it("reads what the router hands over without throwing", () => {
    // The router JSON-parses the query string: ?family=4 is a number.
    expect(decodeList(4)).toEqual(["4"])
    expect(decodeList(true)).toEqual(["true"])
    expect(decodeList(["a", 1])).toEqual(["a", "1"])
    expect(decodeList({ a: 1 })).toEqual([])
    expect(decodeList(undefined)).toEqual([])
    expect(decodeList("a,,a,b")).toEqual(["a", "b"])
  })

  it("round-trips an open-ended range and ignores junk", () => {
    expect(encodeRange({ min: "50", max: "" })).toBe("50..")
    expect(decodeRange("50..")).toEqual({ min: "50", max: "" })
    expect(decodeRange("..9.5")).toEqual({ min: "", max: "9.5" })
    expect(encodeRange({ min: "", max: "" })).toBeUndefined()
    expect(decodeRange("abc")).toEqual({ min: "", max: "" })
    expect(decodeRange("x..y")).toEqual({ min: "", max: "" })
  })

  it("drops values the list does not have, keeps everything while loading", () => {
    const sel = new Set(["core", "gone"])
    expect([...pruneUnknown(sel, ["core", "edge"])]).toEqual(["core"])
    expect(pruneUnknown(sel, [])).toBe(sel)
    expect(pruneUnknown(sel, null)).toBe(sel)
    const known = new Set(["core"])
    expect(pruneUnknown(known, ["core"])).toBe(known)
  })
})

describe("useUrlSet", () => {
  it("reads the param and keeps its identity while other params change", () => {
    search = { tag: "core,edge" }
    const { result, rerender } = renderHook(() => useUrlSet("tag"))
    const first = result.current[0]
    expect([...first]).toEqual(["core", "edge"])
    search = { tag: "core,edge", q: "sw" }
    rerender()
    expect(result.current[0]).toBe(first)
  })

  it("replaces the history entry and drops the param when emptied", async () => {
    search = { tag: "core", q: "x" }
    const { result } = renderHook(() => useUrlSet("tag"))
    result.current[1](new Set())
    await flush()
    expect(lastNav()).toMatchObject({ to: ".", replace: true })
    expect(written()).toEqual({ tag: undefined, q: "x" })
  })

  it("lands two writes made in one tick in one navigation", async () => {
    search = { tag: "a,b" }
    const { result } = renderHook(() => useUrlSet("tag"))
    const toggle = (v: string) =>
      result.current[1]((s) => {
        const n = new Set(s)
        if (n.has(v)) n.delete(v)
        else n.add(v)
        return n
      })
    toggle("a")
    toggle("b")
    await flush()
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(written()).toEqual({ tag: undefined })
  })
})

describe("useUrlSearch", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("follows each keystroke and writes the URL once typing pauses", async () => {
    const { result } = renderHook(() => useUrlSearch())
    act(() => result.current[1]("s"))
    act(() => result.current[1]("sw"))
    expect(result.current[0]).toBe("sw")
    expect(navigate).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(lastNav().replace).toBe(true)
    expect(written()).toEqual({ q: "sw" })
  })

  it("starts from the URL and follows it when it changes elsewhere", () => {
    search = { q: "core" }
    const { result, rerender } = renderHook(() => useUrlSearch())
    expect(result.current[0]).toBe("core")
    search = {}
    rerender()
    expect(result.current[0]).toBe("")
  })

  it("never writes after the page is gone", async () => {
    const { result, unmount } = renderHook(() => useUrlSearch())
    act(() => result.current[1]("late"))
    unmount()
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
      await Promise.resolve()
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it("clears the param when the box is emptied", async () => {
    search = { q: "core" }
    const { result } = renderHook(() => useUrlSearch())
    act(() => result.current[1](""))
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
      await Promise.resolve()
    })
    expect(written()).toEqual({ q: undefined })
  })
})
