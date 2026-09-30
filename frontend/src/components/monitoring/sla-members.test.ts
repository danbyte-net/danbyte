import { describe, expect, it } from "vitest"

import type { SlaMemberFigure } from "@/lib/api"
import {
  exclusionMembers,
  memberRowIds,
  selectorFieldsSet,
  selectorSummary,
  viaText,
} from "./sla-members"

const row = (over: Partial<SlaMemberFigure>): SlaMemberFigure =>
  ({
    member: true,
    member_id: null,
    key: "k",
    object_type: "api.device",
    object_id: "o",
    name: "x",
    ...over,
  }) as SlaMemberFigure

const group = {
  use_selector: true,
  match_sites: [] as string[],
  match_roles: [] as string[],
  match_device_types: [] as string[],
  match_platforms: [] as string[],
  match_tags: [] as string[],
  match_name: "",
}

describe("viaText", () => {
  it("names three devices, then counts the rest", () => {
    const via = ["a", "b", "c", "d", "e"].map((n) => ({ id: n, name: n }))
    expect(viaText(via.slice(0, 2))).toBe("via a, b")
    expect(viaText(via)).toBe("via a, b, c +2")
    expect(viaText(undefined)).toBeNull()
  })
})

describe("memberRowIds", () => {
  it("reads a folded stack's rows, and an older row's own id", () => {
    expect(memberRowIds({ member_id: "m1", member_ids: ["m1", "m2"] })).toEqual(
      ["m1", "m2"]
    )
    expect(memberRowIds({ member_id: "m1" })).toEqual(["m1"])
    expect(memberRowIds({ member_id: null })).toEqual([])
  })
})

describe("exclusionMembers", () => {
  it("names every folded row but offers the stack once", () => {
    const { table, options } = exclusionMembers([
      row({ member_id: "m1", member_ids: ["m1", "m2", "m3"], name: "sw1" }),
      row({ member_id: "m4", name: "leaf1" }),
      row({ member_id: null, name: "by-selector" }),
    ])
    expect([...table]).toEqual([
      ["m1", "sw1"],
      ["m2", "sw1"],
      ["m3", "sw1"],
      ["m4", "leaf1"],
    ])
    expect(options).toEqual([
      { id: "m1", name: "sw1" },
      { id: "m4", name: "leaf1" },
    ])
  })
})

describe("selectorSummary", () => {
  it("counts what is set", () => {
    expect(
      selectorSummary({
        ...group,
        match_roles: ["r1", "r2"],
        match_device_types: ["t1"],
      })
    ).toBe("2 roles · 1 type")
    expect(selectorSummary(group)).toBe("Matches nothing")
    expect(selectorSummary({ ...group, use_selector: false })).toBe("Off")
    expect(selectorSummary({ ...group, match_name: "leaf-*" })).toBe("leaf-*")
  })

  it("lists the fields that narrow a new role or type", () => {
    const g = { ...group, match_roles: ["r"], match_sites: ["s"] }
    expect(selectorFieldsSet(g, "roles")).toEqual(["Sites"])
    expect(selectorFieldsSet(g, "types")).toEqual(["Sites", "Roles"])
  })
})
