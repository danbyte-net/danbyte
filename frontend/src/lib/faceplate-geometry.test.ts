import { describe, expect, it } from "vitest"

import {
  CONNECTOR_MM,
  familyForType,
  renderTemplateName,
} from "./faceplate-geometry"
import { autoLayout } from "./faceplate-layout"

describe("familyForType", () => {
  it("maps pluggable form-factor suffixes", () => {
    expect(familyForType("10gbase-x-sfpp")).toBe("sfp")
    expect(familyForType("25gbase-x-sfp28")).toBe("sfp")
    expect(familyForType("50gbase-x-sfp56")).toBe("sfp")
    expect(familyForType("100gbase-x-sfpdd")).toBe("sfp")
    expect(familyForType("100gbase-x-dsfp")).toBe("sfp")
    expect(familyForType("40gbase-x-qsfpp")).toBe("qsfp")
    expect(familyForType("100gbase-x-qsfp28")).toBe("qsfp")
    expect(familyForType("400gbase-x-qsfp112")).toBe("qsfp")
    expect(familyForType("800gbase-x-qsfpdd")).toBe("qsfp")
    expect(familyForType("1.6tbase-x-qsfpdd1600")).toBe("qsfp")
    expect(familyForType("100gbase-x-cfp4")).toBe("qsfp")
    expect(familyForType("400gbase-x-osfp")).toBe("osfp")
    expect(familyForType("400gbase-x-osfp-rhs")).toBe("osfp")
    expect(familyForType("1.6tbase-x-osfp1600-rhs")).toBe("osfp")
    expect(familyForType("100gbase-x-cfp2")).toBe("cfp2")
    expect(familyForType("100gbase-x-cfp")).toBe("cfp")
    expect(familyForType("400gbase-x-cfp8")).toBe("cfp")
    expect(familyForType("10gbase-x-xfp")).toBe("xfp")
    expect(familyForType("10gbase-x-x2")).toBe("x2")
    expect(familyForType("10gbase-x-xenpak")).toBe("x2")
    expect(familyForType("1000base-x-gbic")).toBe("gbic")
  })

  it("maps fibre channel by form factor", () => {
    expect(familyForType("64gfc-qsfpp")).toBe("qsfp")
    expect(familyForType("32gfc-sfp28")).toBe("sfp")
  })

  it("maps copper / backplane / legacy to rj45", () => {
    expect(familyForType("1000base-t")).toBe("rj45")
    expect(familyForType("10gbase-t")).toBe("rj45")
    expect(familyForType("2.5gbase-t")).toBe("rj45")
    expect(familyForType("1000base-kx")).toBe("rj45")
    expect(familyForType("t1")).toBe("rj45")
    expect(familyForType("docsis")).toBe("rj45")
    expect(familyForType("cisco-stackwise-480")).toBe("rj45")
  })

  it("maps wireless/cellular to antenna", () => {
    expect(familyForType("ieee802.11ax")).toBe("antenna")
    expect(familyForType("lte")).toBe("antenna")
    expect(familyForType("5g")).toBe("antenna")
  })

  it("maps aux/console connector slugs", () => {
    expect(familyForType("usb-a")).toBe("usb-a")
    expect(familyForType("usb-c")).toBe("usb-c")
    expect(familyForType("usb-micro-b")).toBe("usb-mini")
    expect(familyForType("hdmi")).toBe("hdmi")
    expect(familyForType("mini-hdmi")).toBe("usb-mini")
    expect(familyForType("vga")).toBe("vga")
    expect(familyForType("dvi")).toBe("dvi")
    expect(familyForType("displayport")).toBe("displayport")
    expect(familyForType("mini-displayport")).toBe("mini-dp")
    expect(familyForType("de-9")).toBe("dsub-9")
    expect(familyForType("rj-11")).toBe("rj11")
    expect(familyForType("sd")).toBe("sd")
    expect(familyForType("microsd")).toBe("sd")
  })

  it("falls back to generic for unknown / empty / odd media", () => {
    expect(familyForType("")).toBe("generic")
    expect(familyForType("sonet-oc48")).toBe("generic")
    expect(familyForType("gpon")).toBe("generic")
    expect(familyForType("some-future-slug")).toBe("generic")
  })

  it("QSFP is wider than SFP which is narrower than RJ45's height profile", () => {
    // The whole point: cages must differ in real proportions.
    expect(CONNECTOR_MM.qsfp.w).toBeGreaterThan(CONNECTOR_MM.sfp.w)
    expect(CONNECTOR_MM.osfp.w).toBeGreaterThan(CONNECTOR_MM.qsfp.w)
    expect(CONNECTOR_MM.rj45.h).toBeGreaterThan(CONNECTOR_MM.sfp.h)
  })
})

describe("renderTemplateName", () => {
  it("resolves {position} with the member position", () => {
    expect(renderTemplateName("GigabitEthernet{position}/0/1", 2)).toBe(
      "GigabitEthernet2/0/1"
    )
  })
  it("uses the token default when standalone", () => {
    expect(renderTemplateName("Gi{position}/0/1", null)).toBe("Gi1/0/1")
    expect(renderTemplateName("xe-{position:0}/0/1", null)).toBe("xe-0/0/1")
  })
  it("prefers position over the token default", () => {
    expect(renderTemplateName("xe-{position:0}/0/1", 3)).toBe("xe-3/0/1")
  })
  it("leaves plain names alone", () => {
    expect(renderTemplateName("eth0", 5)).toBe("eth0")
  })
})

describe("autoLayout — C9500-48Y4C shape", () => {
  const ports = [
    ...Array.from({ length: 48 }, (_, i) => ({
      id: `sfp-${i + 1}`,
      name: `TwentyFiveGigE1/0/${i + 1}`,
      type: "25gbase-x-sfp28",
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `qsfp-${i + 49}`,
      name: `HundredGigE1/0/${i + 49}`,
      type: "100gbase-x-qsfp28",
    })),
  ]

  it("splits one prefix into two family groups, sfp before qsfp", () => {
    const doc = autoLayout(ports)
    expect(doc.front).toHaveLength(2)
    const [a, b] = doc.front
    expect(a.slots).toHaveLength(48)
    expect(b.slots).toHaveLength(4)
    // 48-port SFP field: two rows, banked in 12s.
    expect(a.rows).toBe(2)
    expect(a.bank).toBe(12)
    // 4 QSFP uplinks: single dense block, no banking.
    expect(b.bank).toBe(0)
  })

  it("keeps ascending port order (zigzag = column-major at render)", () => {
    const doc = autoLayout(ports)
    const names = doc.front[0].slots.map(
      (s) => (s as { t: "port"; name: string }).name
    )
    expect(names[0]).toBe("TwentyFiveGigE1/0/1")
    expect(names[1]).toBe("TwentyFiveGigE1/0/2")
    expect(names[47]).toBe("TwentyFiveGigE1/0/48")
  })

  it("all-fibre spine stays dense (no runaway single row)", () => {
    const spine = Array.from({ length: 32 }, (_, i) => ({
      id: `q${i}`,
      name: `Ethernet1/${i + 1}`,
      type: "100gbase-x-qsfp28",
    }))
    const doc = autoLayout(spine)
    expect(doc.front).toHaveLength(1)
    expect(doc.front[0].rows).toBe(2)
  })

  it("chassis line cards become one group per slot prefix", () => {
    const chassis = [
      { id: "a1", name: "Ethernet1/1", type: "10gbase-x-sfpp" },
      { id: "a2", name: "Ethernet1/2", type: "10gbase-x-sfpp" },
      { id: "b1", name: "Ethernet2/1", type: "10gbase-x-sfpp" },
    ]
    const doc = autoLayout(chassis)
    expect(doc.front).toHaveLength(2)
    expect(doc.front.map((g) => g.label).sort()).toEqual([
      "Ethernet1/",
      "Ethernet2/",
    ])
  })

  it("copper renders before pluggables regardless of input order", () => {
    const mixed = [
      { id: "u1", name: "Te1/0/49", type: "10gbase-x-sfpp" },
      { id: "c1", name: "Gi1/0/1", type: "1000base-t" },
    ]
    const doc = autoLayout(mixed)
    expect(doc.front[0].label).toBe("Gi1/0/")
    expect(doc.front[1].label).toBe("Te1/0/")
  })
})
