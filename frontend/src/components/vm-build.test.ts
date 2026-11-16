import { describe, expect, it } from "vitest"

import type { AutomationTarget } from "@/lib/api"
import { coversVms, driftRows } from "./vm-build"

describe("driftRows", () => {
  it("flattens spec and interface drift into intended vs hypervisor", () => {
    const rows = driftRows([
      {
        id: "c1",
        kind: "spec_change",
        detail: { memory_mb: { danbyte: 2048, hypervisor: 4096 } },
      },
      {
        id: "c2",
        kind: "iface_change",
        detail: {
          interfaces: {
            net0: { bridge: { danbyte: "vmbr0", hypervisor: "vmbr1" } },
          },
        },
      },
      { id: "c3", kind: "iface_extra", detail: { names: ["net2"] } },
      { id: "c4", kind: "new_guest", detail: {} },
    ])
    expect(rows.map((r) => [r.field, r.intended, r.observed])).toEqual([
      ["Memory MB", 2048, 4096],
      ["net0 Bridge", "vmbr0", "vmbr1"],
      ["net2", "present", "missing"],
    ])
    // Each review item's buttons sit on its first row.
    expect(rows.map((r) => [r.change, r.first])).toEqual([
      ["c1", true],
      ["c2", true],
      ["c3", true],
    ])
  })
})

describe("coversVms", () => {
  const t = (over: Partial<AutomationTarget>) =>
    ({ enabled: true, object_types: [], ...over }) as AutomationTarget
  it("takes enabled targets naming virtual machines or every type", () => {
    expect(coversVms(t({ object_types: ["virtualmachine"] }))).toBe(true)
    expect(coversVms(t({ object_types: ["*"] }))).toBe(true)
    expect(coversVms(t({ object_types: [] }))).toBe(false)
    expect(coversVms(t({ object_types: ["device"] }))).toBe(false)
    expect(
      coversVms(t({ enabled: false, object_types: ["virtualmachine"] }))
    ).toBe(false)
  })
})
