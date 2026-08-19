import { describe, expect, it } from "vitest"

import { applyManageableOrder } from "@/components/data-table"

// A saved column layout predates newly shipped columns. Regression for the
// DHCP column landing off-screen: ids the saved order has never seen must
// slot in at their designed (definition-order) position, not at the far end.
describe("applyManageableOrder", () => {
  const allIds = ["select", "ip", "status", "dhcp", "role", "updated"]
  const manageable = ["ip", "status", "dhcp", "role", "updated"]

  it("keeps the saved order for known columns", () => {
    const saved = ["status", "ip", "dhcp", "role", "updated"]
    expect(applyManageableOrder(allIds, manageable, saved)).toEqual([
      "select",
      "status",
      "ip",
      "dhcp",
      "role",
      "updated",
    ])
  })

  it("inserts a column the saved order predates at its designed position", () => {
    // Saved before "dhcp" existed - it must appear after "status" (its
    // definition-order neighbour), not after "updated".
    const saved = ["ip", "status", "role", "updated"]
    expect(applyManageableOrder(allIds, manageable, saved)).toEqual([
      "select",
      "ip",
      "status",
      "dhcp",
      "role",
      "updated",
    ])
  })

  it("respects a user having moved the designed neighbour", () => {
    // "status" moved to the end - the unseen "dhcp" follows its neighbour.
    const saved = ["ip", "role", "updated", "status"]
    expect(applyManageableOrder(allIds, manageable, saved)).toEqual([
      "select",
      "ip",
      "role",
      "updated",
      "status",
      "dhcp",
    ])
  })

  it("drops saved ids that no longer exist", () => {
    const saved = ["ip", "ghost", "status", "dhcp", "role", "updated"]
    expect(applyManageableOrder(allIds, manageable, saved)).toEqual([
      "select",
      "ip",
      "status",
      "dhcp",
      "role",
      "updated",
    ])
  })
})
