// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useStableSize } from "./viewer-stage"

describe("useStableSize", () => {
  it("keeps the same array while the numbers stay the same", () => {
    const first: [number, number, number] = [0.44, 0.13, 0.45]
    const { result, rerender } = renderHook(({ s }) => useStableSize(s), {
      initialProps: { s: first },
    })
    // A payload refresh rebuilds the box with the same values.
    rerender({ s: [0.44, 0.13, 0.45] })
    expect(result.current).toBe(first)
  })

  it("follows a real change of size", () => {
    const { result, rerender } = renderHook(({ s }) => useStableSize(s), {
      initialProps: { s: [0.44, 0.13, 0.45] as [number, number, number] },
    })
    const taller: [number, number, number] = [0.44, 0.18, 0.45]
    rerender({ s: taller })
    expect(result.current).toBe(taller)
  })
})
