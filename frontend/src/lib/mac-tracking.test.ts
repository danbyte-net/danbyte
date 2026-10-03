import { describe, expect, it } from "vitest"

import {
  isPartialRead,
  learnedByInterface,
  linesByMac,
  macLabel,
  macQuery,
  reportsMacTable,
  shortName,
  uplinkFields,
  uplinkModeOf,
  uplinkWhy,
} from "./mac-tracking"
import type { DeviceMacs, InterfaceMacRow, MacTableMeta } from "./api"

const META: MacTableMeta = {
  source: "bridge-vlan",
  complete: true,
  error: "",
  legacy: false,
}

describe("macQuery", () => {
  it("reads a whole MAC in every notation the search takes", () => {
    for (const q of [
      "3c:52:82:aa:10:44",
      "3C-52-82-AA-10-44",
      "3c52.82aa.1044",
      "3c5282-aa1044",
      "3c5282aa1044",
      "  3C52.82AA.1044 ",
    ])
      expect(macQuery(q), q).toBe("3c:52:82:aa:10:44")
  })

  it("leaves fragments and mixed separators alone", () => {
    for (const q of [
      "3c:52:82",
      "3c:52-82:aa:10:44",
      "3c52.82aa",
      "sw-acc-03",
      "3c5282aa10445",
      "",
    ])
      expect(macQuery(q), q).toBeNull()
  })
})

describe("Uplink: Automatic / Always / Never", () => {
  it("reads the two fields as one choice", () => {
    expect(uplinkModeOf({ is_uplink: false, never_uplink: false })).toBe("auto")
    expect(uplinkModeOf({})).toBe("auto")
    expect(uplinkModeOf({ is_uplink: true, never_uplink: false })).toBe(
      "always"
    )
    expect(uplinkModeOf({ is_uplink: false, never_uplink: true })).toBe("never")
  })

  it("writes both fields for every choice, never both on", () => {
    expect(uplinkFields("auto")).toEqual({
      is_uplink: false,
      never_uplink: false,
    })
    expect(uplinkFields("always")).toEqual({
      is_uplink: true,
      never_uplink: false,
    })
    expect(uplinkFields("never")).toEqual({
      is_uplink: false,
      never_uplink: true,
    })
  })

  it("shortens an LLDP reason to the neighbour", () => {
    expect(
      uplinkWhy({
        code: "lldp",
        text: "LLDP neighbour sw-core-01",
        neighbor: "sw-core-01",
      })
    ).toBe("LLDP sw-core-01")
    expect(uplinkWhy({ code: "count", text: "7 MACs, above 4" })).toBe(
      "7 MACs, above 4"
    )
  })
})

describe("labels", () => {
  it("names a host by its DNS host part, a known object whole", () => {
    expect(shortName("pc-044.corp.local", "dns_record")).toBe("pc-044")
    expect(shortName("srv-db-01 · eth0", "interface")).toBe("srv-db-01 · eth0")
  })

  it("reads name · IP, else the vendor", () => {
    expect(
      macLabel({
        name: "pc-044.corp.local",
        name_source: "dns",
        ips: [{ ip: "10.10.3.44" }],
        vendor: { name: "HP", source: "ieee" },
      })
    ).toBe("pc-044 · 10.10.3.44")
    expect(
      macLabel({
        name: null,
        name_source: null,
        ips: [{ ip: "10.10.3.44" }],
        vendor: null,
      })
    ).toBe("10.10.3.44")
    expect(
      macLabel({
        name: null,
        name_source: null,
        ips: [],
        vendor: { name: "Polycom", source: "ieee" },
      })
    ).toBe("Polycom")
  })
})

describe("MAC table state", () => {
  it("counts a bridging read as a MAC table", () => {
    expect(reportsMacTable(META, null)).toBe(true)
    expect(reportsMacTable({ ...META, source: "none" }, null)).toBe(false)
    expect(reportsMacTable({ ...META, source: "stack" }, null)).toBe(false)
    expect(reportsMacTable({}, null)).toBe(false)
    expect(reportsMacTable({}, "2026-10-03T10:00:00Z")).toBe(true)
  })

  it("calls a read that stopped early partial", () => {
    expect(isPartialRead(META)).toBe(false)
    expect(isPartialRead({ ...META, complete: false })).toBe(true)
    // Nothing read at all is no MAC table, not a partial one.
    expect(isPartialRead({ ...META, source: "none", complete: false })).toBe(
      false
    )
    expect(isPartialRead({})).toBe(false)
  })

  it("keys a device's ports by interface, only with a MAC table", () => {
    const port = {
      interface_id: "if-1",
      interface_name: "Gi1/0/5",
      device_id: "d",
      port_name: "Gi1/0/5",
      port_key: "gi1/0/5",
      if_index: "6",
      uplink: { is: false, mode: "auto" as const, reasons: [] },
      count: 0,
      located: 0,
      macs: [],
    }
    const macs: DeviceMacs = {
      device: { id: "d", name: "sw" },
      polled_via: null,
      view: "member",
      read_at: "2026-10-03T10:00:00Z",
      polled_at: null,
      stale: false,
      meta: META,
      limit: 4,
      macs: 0,
      ports: [port, { ...port, interface_id: null, port_key: "x" }],
    }
    const source = { deviceId: "d", view: "member" as const }
    const learned = learnedByInterface(macs, source)
    expect([...(learned?.ports.keys() ?? [])]).toEqual(["if-1"])
    expect(
      learnedByInterface({ ...macs, read_at: null, meta: {} }, source)
    ).toBeUndefined()
  })
})

describe("linesByMac", () => {
  const row = (vlan: number | null, first: string): InterfaceMacRow => ({
    id: `${vlan}`,
    mac: "58:97:bd:5e:21:0c",
    vendor: null,
    vlan,
    vlan_object: null,
    ips: [],
    name: null,
    name_source: null,
    first_seen: first,
    last_seen: first,
    gone_at: null,
    state: "present",
    stale: false,
    here: true,
    location: null,
  })

  it("shows a phone in two VLANs once", () => {
    const lines = linesByMac([
      row(20, "2026-09-22T05:41:00Z"),
      row(10, "2026-09-21T04:02:00Z"),
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].vlans).toEqual([10, 20])
    expect(lines[0].first_seen).toBe("2026-09-21T04:02:00Z")
  })
})
