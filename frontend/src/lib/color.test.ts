import { describe, expect, it } from "vitest"

import { readableText as fromBadge } from "@/components/cells/color-badge"
import { readableText } from "./color"

describe("readableText", () => {
  it("puts dark ink on light fills and white on dark ones", () => {
    expect(readableText("#ffffff")).toBe("#0a0a0a")
    expect(readableText("#facc15")).toBe("#0a0a0a")
    expect(readableText("#000000")).toBe("#fff")
    expect(readableText("#1d4ed8")).toBe("#fff")
  })

  it("accepts a bare hex and any case", () => {
    expect(readableText("FFFFFF")).toBe("#0a0a0a")
    expect(readableText("#FaCc15")).toBe("#0a0a0a")
  })

  it("falls back to white for anything that is not a 6-digit hex", () => {
    expect(readableText("")).toBe("#fff")
    expect(readableText("#fff")).toBe("#fff")
    expect(readableText("red")).toBe("#fff")
  })

  it("is the same function ColorBadge re-exports", () => {
    expect(fromBadge).toBe(readableText)
  })
})
