import { describe, expect, it } from "vitest"

import type { TopoCardValues, TopoNode } from "@/lib/api"
import { CARD_FIELD_LABELS, CARD_MAX_LINES, cardContent } from "./card-fields"

// What a Diagram card says: the owner's line names, values alone where
// they are unambiguous, and at most one pill - monitoring beats status.

const ACTIVE = {
  id: "st-1",
  name: "Active",
  slug: "active",
  color: "4caf50",
  text_color: "#ffffff",
  is_default: true,
}

function node(
  fields: string[],
  values: TopoCardValues = {},
  over: Partial<TopoNode["data"]> = {}
): TopoNode["data"] {
  return {
    name: "leaf-01",
    device_id: "dev-1",
    status_mini: ACTIVE,
    device_type: "EX4300-48T",
    role: { id: "r1", name: "Leaf", slug: "leaf", color: "1d4ed8" },
    site: "DC1",
    location: "Hall A",
    card: { fields, source: "default", values },
    ...over,
  }
}

const DEFAULTS = ["monitor", "primary_ip", "loopback", "serial"]
const VALUES: TopoCardValues = {
  primary_ip: { id: "ip1", address: "10.0.0.11", cidr: "10.0.0.11/24" },
  loopback: [{ id: "ip2", address: "10.255.0.11", cidr: "10.255.0.11/32" }],
  serial: "FDO2231X0AB",
}

describe("card lines", () => {
  it("uses the owner's names for the lines", () => {
    expect(CARD_FIELD_LABELS.primary_ip).toBe("IP")
    expect(CARD_FIELD_LABELS.loopback).toBe("Loopback")
    expect(CARD_FIELD_LABELS.serial).toBe("Serial")
  })

  it("shows the default lines as values: IP, Loopback, SN serial", () => {
    const c = cardContent(node(DEFAULTS, VALUES))
    expect(c.name).toBe("leaf-01")
    expect(c.lines).toEqual([
      { key: "primary_ip", label: "IP", text: "10.0.0.11" },
      { key: "loopback", label: "Loopback", text: "10.255.0.11" },
      { key: "serial", label: "Serial", text: "SN FDO2231X0AB" },
    ])
  })

  it("is the name alone for an empty list", () => {
    const c = cardContent(node([], VALUES))
    expect(c.lines).toEqual([])
    expect(c.pill).toBeNull()
    expect(c.pillSlot).toEqual([])
  })

  it("is the name alone without card data", () => {
    const c = cardContent(node(DEFAULTS, VALUES, { card: undefined }))
    expect(c.lines).toEqual([])
    expect(c.pill).toBeNull()
  })

  it("skips lines with no value", () => {
    const c = cardContent(
      node(["primary_ip", "loopback", "serial", "asset_tag"], {
        primary_ip: null,
        loopback: [],
        serial: "",
      })
    )
    expect(c.lines).toEqual([])
  })

  it("prefixes the values a bare value would leave ambiguous", () => {
    const c = cardContent(
      node(["oob_ip", "asset_tag", "rack", "secondary_ip"], {
        oob_ip: { id: "o", address: "10.9.0.11", cidr: "10.9.0.11/24" },
        asset_tag: "A-00123",
        rack: { id: "rk", name: "R12", position: 20 },
        secondary_ip: { id: "s", address: "10.0.1.11", cidr: "10.0.1.11/24" },
      })
    )
    expect(c.lines.map((l) => l.text)).toEqual([
      "OOB 10.9.0.11",
      "Asset A-00123",
      "Rack R12 · U20",
      "10.0.1.11",
    ])
  })

  it("counts extra loopbacks and lists tags", () => {
    const c = cardContent(
      node(["loopback", "tags", "rack"], {
        loopback: [
          { id: "a", address: "10.255.0.11", cidr: "10.255.0.11/32" },
          { id: "b", address: "fd00::11", cidr: "fd00::11/128" },
        ],
        tags: [
          { name: "prod", slug: "prod", color: "" },
          { name: "edge", slug: "edge", color: "" },
        ],
        rack: { id: "rk", name: "R12", position: null },
      })
    )
    expect(c.lines.map((l) => l.text)).toEqual([
      "10.255.0.11 +1",
      "prod, edge",
      "Rack R12",
    ])
  })

  it("reads node-level keys from the node itself", () => {
    const c = cardContent(
      node(["device_type", "role", "site", "location", "platform"], {
        platform: { id: "p", name: "Junos" },
      })
    )
    expect(c.lines.map((l) => l.text)).toEqual([
      "EX4300-48T",
      "Leaf",
      "DC1",
      "Hall A",
      "Junos",
    ])
  })

  it("labels custom fields and formats their values", () => {
    const c = cardContent(
      node(["cf_contract_id", "cf_managed", "cf_owners", "cf_empty"], {
        cf_contract_id: "C-7",
        cf_managed: false,
        cf_owners: ["netops", "noc"],
        cf_empty: null,
      }),
      { cfLabels: { contract_id: "Contract" } }
    )
    expect(c.lines.map((l) => l.text)).toEqual([
      "Contract: C-7",
      "Managed: No",
      "Owners: netops, noc",
    ])
  })

  it("caps the lines", () => {
    const c = cardContent(
      node(
        [
          "primary_ip",
          "loopback",
          "serial",
          "device_type",
          "role",
          "site",
          "location",
        ],
        VALUES
      )
    )
    expect(c.lines).toHaveLength(CARD_MAX_LINES)
  })

  it("takes an explicit field list over the node's", () => {
    const c = cardContent(node(DEFAULTS, VALUES), { fields: ["serial"] })
    expect(c.lines.map((l) => l.key)).toEqual(["serial"])
  })
})

describe("card pill", () => {
  it("shows no pill while a monitored device is up", () => {
    const c = cardContent(node(DEFAULTS, VALUES), { monitor: "up" })
    expect(c.pill).toBeNull()
    // ...but keeps room for one, so going down never resizes the card.
    expect(c.pillSlot).toEqual(["Down", "Degraded"])
  })

  it("shows Down and Degraded from monitoring", () => {
    expect(
      cardContent(node(DEFAULTS, VALUES), { monitor: "down" }).pill
    ).toEqual({ kind: "check", status: "down", text: "Down" })
    expect(
      cardContent(node(DEFAULTS, VALUES), { monitor: "degraded" }).pill
    ).toEqual({ kind: "check", status: "degraded", text: "Degraded" })
    for (const monitor of ["unknown", "stale", "skipped"] as const)
      expect(cardContent(node(DEFAULTS, VALUES), { monitor }).pill).toBeNull()
  })

  it("keeps no room on a patch panel for a monitoring pill", () => {
    const c = cardContent(node(DEFAULTS, VALUES, { panel: true }), {
      monitor: "down",
    })
    expect(c.pill).toBeNull()
    expect(c.pillSlot).toEqual([])
  })

  it("needs `monitor` in the list for the monitoring pill", () => {
    const c = cardContent(node(["primary_ip"], VALUES), { monitor: "down" })
    expect(c.pill).toBeNull()
  })

  it("shows the lifecycle status whenever `status` is listed", () => {
    const c = cardContent(node(["status", "primary_ip"], VALUES))
    expect(c.pill).toEqual({ kind: "status", status: ACTIVE, text: "Active" })
    expect(c.pillSlot).toEqual(["Active"])
    expect(c.lines.map((l) => l.key)).toEqual(["primary_ip"])
  })

  it("lets monitoring beat the lifecycle status - one pill at most", () => {
    const fields = ["status", "monitor", "primary_ip"]
    const down = cardContent(node(fields, VALUES), { monitor: "down" })
    expect(down.pill?.kind).toBe("check")
    expect(down.pillSlot).toEqual(["Down", "Degraded", "Active"])
    const up = cardContent(node(fields, VALUES), { monitor: "up" })
    expect(up.pill?.kind).toBe("status")
  })

  it("uses the tenant's names for the monitoring states", () => {
    const c = cardContent(node(DEFAULTS, VALUES), {
      monitor: "down",
      checkLabels: { down: "Offline" },
    })
    expect(c.pill?.text).toBe("Offline")
    expect(c.pillSlot).toEqual(["Offline", "Degraded"])
  })
})
