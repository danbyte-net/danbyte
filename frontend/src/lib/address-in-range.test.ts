import { describe, expect, it } from "vitest"

import { addressInRange } from "./prefix-tree"

describe("addressInRange", () => {
  it("is inclusive at both ends", () => {
    expect(addressInRange("192.173.199.61", "192.173.199.61", "192.173.199.67")).toBe(true)
    expect(addressInRange("192.173.199.67", "192.173.199.61", "192.173.199.67")).toBe(true)
    expect(addressInRange("192.173.199.60", "192.173.199.61", "192.173.199.67")).toBe(false)
    expect(addressInRange("192.173.199.68", "192.173.199.61", "192.173.199.67")).toBe(false)
  })
  it("rejects junk and mixed families", () => {
    expect(addressInRange("192.173.199.", "192.173.199.61", "192.173.199.67")).toBe(false)
    expect(addressInRange("192.173.199.", "192.173.199.0", "192.173.199.9")).toBe(false)
    expect(addressInRange("2001:db8::5", "192.173.199.61", "192.173.199.67")).toBe(false)
    expect(addressInRange("2001:db8::5", "2001:db8::1", "2001:db8::9")).toBe(true)
  })
})
