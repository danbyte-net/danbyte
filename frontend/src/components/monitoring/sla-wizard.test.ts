import { describe, expect, it } from "vitest"

import type { Picked } from "./sla-wizard"
import { suggestQueries, wizardPayload } from "./sla-wizard"

const pick = (type: Picked["type"], id: string): Picked => ({
  type,
  id,
  label: id,
})

describe("wizardPayload", () => {
  it("puts roles and types on the selector, not in bulk-add", () => {
    const out = wizardPayload([
      pick("api.device", "d1"),
      pick("role", "r1"),
      pick("role", "r2"),
      pick("type", "t1"),
    ])
    expect(out.objects).toEqual([
      { object_type: "api.device", object_id: "d1" },
    ])
    expect(out.selector).toEqual({
      use_selector: true,
      match_roles: ["r1", "r2"],
      match_device_types: ["t1"],
    })
  })

  it("leaves the selector off when no role or type is picked", () => {
    expect(wizardPayload([pick("api.prefix", "p1")]).selector).toEqual({
      use_selector: false,
      match_roles: [],
      match_device_types: [],
    })
  })

  it("adds a stack through bulk-add", () => {
    expect(wizardPayload([pick("api.virtualchassis", "vc1")]).objects).toEqual([
      { object_type: "api.virtualchassis", object_id: "vc1" },
    ])
  })
})

describe("suggestQueries", () => {
  it("asks each kind apart, a stack through its measured member", () => {
    const qs = suggestQueries(
      [
        pick("api.device", "d1"),
        pick("api.virtualchassis", "vc1"),
        pick("api.prefix", "p1"),
        pick("role", "r1"),
        pick("type", "t1"),
      ],
      ["m1"]
    ).map((q) => Object.fromEntries(new URLSearchParams(q)))
    expect(qs).toEqual([
      { device: "d1,m1", page_size: "500" },
      { prefix: "p1", page_size: "500" },
      { role: "r1", device_type: "t1", page_size: "500" },
    ])
  })

  it("never sends a role with a device", () => {
    const qs = suggestQueries([pick("role", "r1")], [])
    expect(qs).toEqual(["role=r1&page_size=500"])
  })

  it("asks nothing for kinds with no checks list filter", () => {
    expect(suggestQueries([pick("api.circuit", "c1")], [])).toEqual([])
  })
})
