import { describe, expect, it } from "vitest"

import type { CableWayHop, ResolvedPathway } from "@/lib/api"
import {
  channelKeyOf,
  channelOptions,
  hopOptions,
  hopUnits,
  lengthText,
  reasonText,
  wayChain,
} from "./cable-ways"

function pathway(patch: Partial<ResolvedPathway> = {}): ResolvedPathway {
  return {
    key: "path:vertical:left:rear",
    id: null,
    source: "default",
    kind: "vertical",
    subkind: "channel",
    side: "left",
    face: "rear",
    surface: "",
    u_from: 1,
    u_to: 42,
    offset_mm: null,
    depth_mm: null,
    x_mm: null,
    y_mm: null,
    inner_w_mm: 50,
    inner_d_mm: 90,
    fill_limit_pct: 40,
    name: "",
    description: "",
    label: "Left rear",
    hidden: false,
    addon: false,
    orphan: false,
    overridden: [],
    accessory_type: null,
    device: null,
    ...patch,
  }
}

function hop(patch: Partial<CableWayHop> = {}): CableWayHop {
  return {
    pathway: null,
    key: "path:vertical:left:rear",
    kind: "vertical",
    label: "Left rear",
    enter_u: 12,
    leave_u: 42,
    ...patch,
  }
}

const ROOF = hop({
  key: "entry:top:rear-right",
  kind: "entry",
  label: "Roof rear-right",
  enter_u: null,
  leave_u: null,
})

describe("a way's chain", () => {
  it("reads port, hops and the tray it meets", () => {
    expect(
      wayChain(
        "Gi1/0/12",
        { hops: [hop(), ROOF], exit: "top" },
        { tray: "OH-A" }
      )
    ).toBe("Gi1/0/12 → Left rear → Roof rear-right → tray OH-A")
  })

  it("names the way out when no entry ends it", () => {
    expect(wayChain("eth0", { hops: [hop()], exit: "top" })).toBe(
      "eth0 → Left rear → roof"
    )
    expect(wayChain("eth0", { hops: [hop()], exit: "bottom" })).toBe(
      "eth0 → Left rear → floor"
    )
  })

  it("ends at the far port in one rack", () => {
    expect(
      wayChain("PSU 1", { hops: [hop()], exit: "port" }, { farPort: "C13-03" })
    ).toBe("PSU 1 → Left rear → C13-03")
    expect(
      wayChain("PSU 1", { hops: [hop()], exit: "port" }, { tray: "OH-A" })
    ).toBe("PSU 1 → Left rear → far port")
  })

  it("words units, lengths and reasons", () => {
    expect(hopUnits(hop())).toBe("U12→U42")
    expect(hopUnits(hop({ leave_u: 12 }))).toBe("U12")
    expect(hopUnits(ROOF)).toBe("")
    expect(lengthText(850)).toBe("850 mm")
    expect(lengthText(1250)).toBe("1.25 m")
    expect(lengthText(2000)).toBe("2 m")
    expect(lengthText(null)).toBe("")
    expect(reasonText("pdu-channel")).toBe("PDU channel")
    expect(reasonText("new-code")).toBe("new-code")
  })
})

describe("pathway options", () => {
  const items = [
    pathway(),
    pathway({ key: "path:vertical:right:rear", side: "right", hidden: true }),
    pathway({
      key: "channel:0u:left:rear",
      kind: "channel",
      label: "0U left rear",
      id: "row-1",
    }),
    pathway({
      key: "channel:0u:left:front",
      kind: "channel",
      face: "front",
      label: "0U left front",
    }),
    pathway({
      key: "channel:0u:right:rear",
      kind: "channel",
      side: "right",
      label: "0U right rear",
    }),
    pathway({ key: "channel:0u:left:x", kind: "channel", orphan: true }),
  ]

  it("offers a hop only the shown pathways", () => {
    expect(hopOptions(items).map((o) => o.value)).not.toContain(
      "path:vertical:right:rear"
    )
    expect(hopOptions(items).map((o) => o.value)).not.toContain(
      "channel:0u:left:x"
    )
  })

  it("offers a side-mounted device its rail's channels at its face", () => {
    expect(channelOptions(items, "side_left", "rear")).toEqual([
      { value: "channel:0u:left:rear", label: "0U left rear" },
    ])
    expect(channelOptions(items, "side_left", "").map((o) => o.value)).toEqual([
      "channel:0u:left:rear",
      "channel:0u:left:front",
    ])
    expect(channelOptions(items, "side_right", "rear")).toEqual([
      { value: "channel:0u:right:rear", label: "0U right rear" },
    ])
    expect(channelOptions(items, "", "rear")).toEqual([])
  })

  it("finds the key of a device's channel row", () => {
    expect(channelKeyOf(items, "row-1")).toBe("channel:0u:left:rear")
    expect(channelKeyOf(items, "gone")).toBe("")
    expect(channelKeyOf(items, null)).toBe("")
  })
})
