// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { readStacksMode, setStacksMode, useStacksMode } from "./stacks-pref"

describe("stacks choice", () => {
  it("reads a stored mode, anything else as Show", () => {
    expect(readStacksMode("ghost")).toBe("ghost")
    expect(readStacksMode("hide")).toBe("hide")
    expect(readStacksMode(null)).toBe("show")
    expect(readStacksMode("solid")).toBe("show")
  })

  it("is kept in this browser and shared with every view", () => {
    const a = renderHook(() => useStacksMode())
    const b = renderHook(() => useStacksMode())
    act(() => setStacksMode("ghost"))
    expect(a.result.current).toBe("ghost")
    expect(b.result.current).toBe("ghost")
    expect(window.localStorage.getItem("danbyte.stacks.mode")).toBe("ghost")
    act(() => setStacksMode("show"))
    expect(a.result.current).toBe("show")
  })
})
