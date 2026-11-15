// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type { SiteMapDependencyLine } from "@/lib/api"
import {
  buildDependenciesLayer,
  chevron,
  dependencyPath,
  dependencyTip,
} from "./dependencies-layer"

// The site map's Dependencies layer (#450).

const devices: SiteMapDependencyLine = {
  id: "dep:1",
  kind: "devices",
  dependency_kind: "dependency",
  medium: {
    id: "m",
    name: "Radio",
    slug: "radio",
    color: "#8b5cf6",
    text_color: "#fff",
    icon: "",
    line_style: "dashed",
  },
  redundancy_group: "",
  a: { lat: 55, lng: 12, device_id: "u", device_name: "mast-1", site_id: "s" },
  z: { lat: 55, lng: 13, device_id: "d", device_name: "cpe-7", site_id: "s" },
}

const sites: SiteMapDependencyLine = {
  id: "depsites:a:b:none:dependency",
  kind: "sites",
  dependency_kind: "dependency",
  medium: null,
  site_a: { id: "a", name: "HQ", latitude: 55, longitude: 12 },
  site_z: { id: "b", name: "Branch", latitude: 56, longitude: 10 },
  count: 7,
  pairs: Array.from({ length: 6 }, (_, i) => ({
    upstream: { id: "u", name: "core-1" },
    downstream: { id: `d${i}`, name: `acc-${i}` },
    redundancy_group: "",
  })),
}

describe("dependency lines", () => {
  it("run device to device, or bow between two sites", () => {
    expect(dependencyPath(devices)).toEqual([
      [55, 12],
      [55, 13],
    ])
    const arc = dependencyPath(sites)
    expect(arc[0]).toEqual([55, 12])
    expect(arc[arc.length - 1]).toEqual([56, 10])
    expect(arc.length).toBeGreaterThan(2)
  })

  it("point their chevron downstream", () => {
    const [arm, tip, other] = chevron(dependencyPath(devices))!
    // East-bound line: the arms trail west of the tip, one either side.
    expect(arm[1]).toBeLessThan(tip[1])
    expect(other[1]).toBeLessThan(tip[1])
    expect(Math.sign(arm[0] - tip[0])).toBe(-Math.sign(other[0] - tip[0]))
  })

  it("name their ends and list a site pair's dependencies", () => {
    expect(dependencyTip(devices)).toBe("mast-1 → cpe-7 · Radio")
    const tip = dependencyTip(sites)
    expect(tip).toContain("HQ → Branch · 7 dependencies")
    expect(tip).toContain("core-1 → acc-0")
    expect(tip).toContain("+2 more")
    expect(tip).not.toContain("acc-5")
  })

  it("draw a chevron on a dependency, none on a peer link", () => {
    const count = (l: SiteMapDependencyLine) =>
      buildDependenciesLayer([l]).getLayers().length
    expect(count(devices)).toBe(3)
    expect(count({ ...devices, dependency_kind: "peer" })).toBe(2)
  })
})
