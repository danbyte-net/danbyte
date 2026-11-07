import { describe, expect, it } from "vitest"

import { jsonSectionsOf, sectionsOf } from "./sections"

describe("sectionsOf", () => {
  it("finds FRR blocks and nested address families", () => {
    const text = [
      "frr version 10.2",
      "!",
      "interface lo",
      " ip address 10.17.0.11/32",
      " isis passive",
      "!",
      "router bgp 65111",
      " bgp router-id 10.17.0.11",
      " !",
      " address-family l2vpn evpn",
      "  neighbor FABRIC activate",
      "  advertise-all-vni",
      " exit-address-family",
      "!",
      "interface gi1",
    ].join("\n")
    expect(sectionsOf(text)).toEqual([
      { title: "interface lo", line: 3, end: 5, level: 1 },
      { title: "router bgp 65111", line: 7, end: 13, level: 1 },
      { title: "address-family l2vpn evpn", line: 10, end: 12, level: 2 },
      // No body: listed, but nothing to fold.
      { title: "interface gi1", line: 15, end: 15, level: 1 },
    ])
  })

  it("keeps blank lines inside an ifupdown stanza only when it carries on", () => {
    const text = [
      "auto mgmt0",
      "iface mgmt0 inet static",
      "    address 10.0.0.101/24",
      "",
      "    gateway 10.0.0.1",
      "",
      "auto br0",
      "iface br0",
      "    mtu 8900",
      "",
    ].join("\n")
    expect(sectionsOf(text)).toEqual([
      { title: "iface mgmt0 inet static", line: 2, end: 5, level: 1 },
      { title: "iface br0", line: 8, end: 9, level: 1 },
    ])
  })

  it("splits systemd-networkd units and file markers", () => {
    const text = [
      "### FILE: 10-mgmt0.link",
      "[Match]",
      "MACAddress=bc:24:11:00:01:01",
      "",
      "[Link]",
      "Name=mgmt0",
      "",
      "### FILE: 20-mgmt0.network",
      "[Network]",
      "DHCP=no",
    ].join("\n")
    expect(sectionsOf(text)).toEqual([
      { title: "10-mgmt0.link", line: 1, end: 6, level: 0 },
      { title: "[Match]", line: 2, end: 3, level: 1 },
      { title: "[Link]", line: 5, end: 6, level: 1 },
      { title: "20-mgmt0.network", line: 8, end: 10, level: 0 },
      { title: "[Network]", line: 9, end: 10, level: 1 },
    ])
  })

  it("ignores text that only looks like a header", () => {
    expect(sectionsOf("description interface gi1\n[not a section\n")).toEqual(
      []
    )
  })
})

describe("jsonSectionsOf", () => {
  it("spans each object and array to its closing bracket", () => {
    const text = JSON.stringify({ ntp: { servers: ["a", "b"] }, x: 1 }, null, 2)
    expect(jsonSectionsOf(text)).toEqual([
      { title: "", line: 1, end: 9, level: 0 },
      { title: "ntp", line: 2, end: 7, level: 1 },
      { title: "servers", line: 3, end: 6, level: 2 },
    ])
  })
})
