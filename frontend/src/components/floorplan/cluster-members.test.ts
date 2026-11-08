import { describe, expect, it } from "vitest"

import {
  CLUSTER_LIST_CAP,
  clusterMembersOf,
  filterClusterMembers,
  groupClusterMembers,
} from "./cluster-members"
import type { ClusterMember } from "./cluster-members"

// What a cluster lists - the 2D icon clusters' and the 3D summary plates'
// hover and panel.

const m = (id: string, kind: string, name = id): ClusterMember => ({
  id,
  name,
  kind,
  icon: kind === "rack" ? "container" : "server",
})

describe("groupClusterMembers", () => {
  it("lists one kind as one unlabelled group in natural order", () => {
    const { groups, more } = groupClusterMembers([
      m("a", "rack", "R-10"),
      m("b", "rack", "R-2"),
      m("c", "rack", "R-1"),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe("")
    expect(groups[0].members.map((x) => x.name)).toEqual(["R-1", "R-2", "R-10"])
    expect(more).toBe(0)
  })

  it("groups a mixed cluster by kind: racks, cabinets, devices, other", () => {
    const { groups } = groupClusterMembers([
      m("d1", "device"),
      m("o1", "other"),
      m("r1", "rack"),
      m("c1", "cabinet"),
      m("x1", "camera"),
    ])
    expect(groups.map((g) => g.label)).toEqual([
      "Racks",
      "Cabinets",
      "Devices",
      "Other",
    ])
    expect(groups[3].members.map((x) => x.id)).toEqual(["o1", "x1"])
  })

  it("caps the list across groups and counts the rest", () => {
    const members = [
      ...Array.from({ length: 10 }, (_, i) => m(`r${i}`, "rack", `R-${i}`)),
      ...Array.from({ length: 5 }, (_, i) => m(`d${i}`, "device", `D-${i}`)),
    ]
    const { groups, more } = groupClusterMembers(members, CLUSTER_LIST_CAP)
    expect(groups.reduce((n, g) => n + g.members.length, 0)).toBe(12)
    expect(groups[1].members.map((x) => x.name)).toEqual(["D-0", "D-1"])
    expect(more).toBe(3)
  })
})

describe("clusterMembersOf", () => {
  const all = new Map(["a", "b", "c"].map((id) => [id, m(id, "rack")] as const))
  it("leaves the selected member out", () => {
    const list = clusterMembersOf(["a", "b", "c"], (id) => all.get(id), ["b"])
    expect(list.map((x) => x.id)).toEqual(["a", "c"])
  })
  it("drops ids that no longer resolve and ignores an empty selection", () => {
    const list = clusterMembersOf(["a", "gone", "c"], (id) => all.get(id), [
      null,
      undefined,
    ])
    expect(list.map((x) => x.id)).toEqual(["a", "c"])
  })
})

describe("filterClusterMembers", () => {
  it("matches a name case-insensitively; blank keeps all", () => {
    const list = [m("a", "rack", "Core-A"), m("b", "rack", "Edge-B")]
    expect(filterClusterMembers(list, "core").map((x) => x.id)).toEqual(["a"])
    expect(filterClusterMembers(list, "  ")).toHaveLength(2)
  })
})
