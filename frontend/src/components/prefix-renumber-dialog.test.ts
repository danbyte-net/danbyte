import { describe, expect, it } from "vitest"

import { renumberTargetError } from "@/components/prefix-renumber-dialog"

describe("renumberTargetError", () => {
  it("accepts a network of the same family and length", () => {
    expect(
      renumberTargetError("2001:db8:abc0::/60", "2001:db8:1230::/60")
    ).toBeNull()
    expect(renumberTargetError("10.20.0.0/24", "10.30.0.0/24")).toBeNull()
  })

  it("says nothing while empty", () => {
    expect(renumberTargetError("10.20.0.0/24", " ")).toBeNull()
  })

  it("refuses a different length or family", () => {
    expect(
      renumberTargetError("2001:db8:abc0::/60", "2001:db8:1200::/56")
    ).toBe("Must be a /60.")
    expect(renumberTargetError("2001:db8:abc0::/60", "10.0.0.0/24")).toBe(
      "Must be IPv6."
    )
  })

  it("refuses host bits, a missing length and the current network", () => {
    expect(renumberTargetError("10.20.0.0/24", "10.30.0.1/24")).toBe(
      "Host bits are set."
    )
    expect(renumberTargetError("10.20.0.0/24", "10.30.0.0")).toBe(
      "Include the length, e.g. /24."
    )
    expect(renumberTargetError("10.20.0.0/24", "10.20.0.0/24")).toBe(
      "That is the current network."
    )
    expect(renumberTargetError("10.20.0.0/24", "nope/24")).toBe(
      "Not a valid prefix."
    )
  })
})
