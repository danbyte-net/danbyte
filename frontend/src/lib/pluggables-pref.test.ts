// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  effectivePluggables,
  readPluggablesMode,
  setPluggablesMode,
  usePluggablesMode,
} from "./pluggables-pref"

describe("pluggables choice", () => {
  it("reads a stored mode, anything else as Show", () => {
    expect(readPluggablesMode("ghost")).toBe("ghost")
    expect(readPluggablesMode("hide")).toBe("hide")
    expect(readPluggablesMode(null)).toBe("show")
    expect(readPluggablesMode("solid")).toBe("show")
  })

  it("ghosts while the port overlay is on, unless hidden", () => {
    expect(effectivePluggables("show", false)).toBe("show")
    expect(effectivePluggables("ghost", false)).toBe("ghost")
    expect(effectivePluggables("show", true)).toBe("ghost")
    expect(effectivePluggables("ghost", true)).toBe("ghost")
    expect(effectivePluggables("hide", true)).toBe("hide")
    expect(effectivePluggables("hide", false)).toBe("hide")
  })

  it("is kept in this browser and shared with every view", () => {
    const a = renderHook(() => usePluggablesMode())
    const b = renderHook(() => usePluggablesMode())
    act(() => setPluggablesMode("hide"))
    expect(a.result.current).toBe("hide")
    expect(b.result.current).toBe("hide")
    expect(window.localStorage.getItem("danbyte.pluggables.mode")).toBe("hide")
    act(() => setPluggablesMode("show"))
    expect(a.result.current).toBe("show")
  })
})
