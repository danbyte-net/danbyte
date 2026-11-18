// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { readBlanksShown, setBlanksShown, useBlanksShown } from "./blanks-pref"

describe("blanks choice", () => {
  it("reads a stored choice, anything but off as on", () => {
    expect(readBlanksShown("off")).toBe(false)
    expect(readBlanksShown("on")).toBe(true)
    expect(readBlanksShown(null)).toBe(true)
  })

  it("is kept in this browser and shared with every view", () => {
    const a = renderHook(() => useBlanksShown())
    const b = renderHook(() => useBlanksShown())
    act(() => setBlanksShown(false))
    expect(a.result.current).toBe(false)
    expect(b.result.current).toBe(false)
    expect(window.localStorage.getItem("danbyte.blanks.shown")).toBe("off")
    act(() => setBlanksShown(true))
    expect(a.result.current).toBe(true)
  })
})
