// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"

import {
  lastStockLocation,
  rememberStockLocation,
  stockPlaceText,
} from "@/components/stock-place"

describe("stock place", () => {
  afterEach(() => localStorage.clear())

  it("remembers the last location per site", () => {
    expect(lastStockLocation("s1")).toBeNull()
    rememberStockLocation("s1", "box")
    rememberStockLocation("s2", null)
    expect(lastStockLocation("s1")).toBe("box")
    expect(lastStockLocation("s2")).toBeNull()
    expect(lastStockLocation(null)).toBeNull()
  })

  it("survives junk in storage", () => {
    localStorage.setItem("danbyte.stock.last-location", "{not json")
    expect(lastStockLocation("s1")).toBeNull()
    rememberStockLocation("s1", "box")
  })

  it("words a place", () => {
    expect(
      stockPlaceText({
        site: { id: "1", name: "AMS" },
        location: { id: "2", name: "Box" },
      })
    ).toBe("AMS · Box")
    expect(stockPlaceText({ site: { id: "1", name: "AMS" } })).toBe("AMS")
  })
})
