import { describe, expect, it } from "vitest"

import {
  mergeOrder,
  orderSections,
  parseLayout,
  resolveSidebar,
  setHidden,
  setItemOrder,
  setSectionOrder,
  type SidebarLayout,
} from "./sidebar-layout"

type Item = { id: string }
type Section = { id: string; clusters: { label?: string; items: Item[] }[] }

const sec = (id: string, ...clusters: string[][]): Section => ({
  id,
  clusters: clusters.map((ids, i) => ({
    label: clusters.length > 1 ? `c${i}` : undefined,
    items: ids.map((x) => ({ id: x })),
  })),
})

const MENU: Section[] = [
  sec("org", ["/tenants", "/sites"]),
  sec("ipam", ["/prefixes", "/ips", "/ip-ranges"], ["/vlans", "/vlan-groups"]),
  sec("dcim", ["/devices", "/racks"]),
  sec("power", ["/power-feeds", "/power-panels"]),
]

const layout = (p: Partial<SidebarLayout>): SidebarLayout => ({
  v: 1,
  order: [],
  hidden: [],
  items: {},
  ...p,
})

const ids = (sections: Section[]) => sections.map((s) => s.id)
const entries = (s: Section | undefined) =>
  (s?.clusters ?? []).map((c) => c.items.map((i) => i.id))

describe("parseLayout", () => {
  it("reads a stored layout", () => {
    expect(
      parseLayout({ v: 1, order: ["a"], hidden: ["b"], items: { a: ["/x"] } })
    ).toEqual(layout({ order: ["a"], hidden: ["b"], items: { a: ["/x"] } }))
  })

  it("treats nothing, or an unknown version, as no layout", () => {
    expect(parseLayout(null)).toBeNull()
    expect(parseLayout(undefined)).toBeNull()
    expect(parseLayout("x")).toBeNull()
    expect(parseLayout({ v: 2, hidden: ["ipam"] })).toBeNull()
  })

  it("drops values that are not ids", () => {
    expect(
      parseLayout({ v: 1, order: "ipam", hidden: ["ipam", 3], items: [] })
    ).toEqual(layout({ hidden: ["ipam"] }))
  })
})

describe("mergeOrder", () => {
  it("applies the saved order", () => {
    expect(mergeOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual([
      "c",
      "a",
      "b",
    ])
  })

  it("keeps a new id after the shipped id before it", () => {
    // "n" shipped between a and b after the order was saved.
    expect(mergeOrder(["a", "n", "b", "c"], ["c", "b", "a"])).toEqual([
      "c",
      "b",
      "a",
      "n",
    ])
  })

  it("puts a new first id first", () => {
    expect(mergeOrder(["n", "a", "b"], ["b", "a"])).toEqual(["n", "b", "a"])
  })

  it("drops saved ids that no longer ship, and duplicates", () => {
    expect(mergeOrder(["a", "b"], ["gone", "b", "b", "a"])).toEqual(["b", "a"])
  })

  it("is the shipped order when nothing is saved", () => {
    expect(mergeOrder(["a", "b", "c"], [])).toEqual(["a", "b", "c"])
  })
})

describe("resolveSidebar", () => {
  it("is the shipped menu with no layout", () => {
    expect(resolveSidebar(MENU, null)).toEqual(MENU)
  })

  it("hides whole sections", () => {
    const out = resolveSidebar(MENU, layout({ hidden: ["power", "org"] }))
    expect(ids(out)).toEqual(["ipam", "dcim"])
  })

  it("hides single entries, dropping a cluster left empty", () => {
    const out = resolveSidebar(
      MENU,
      layout({ hidden: ["/ips", "/vlans", "/vlan-groups"] })
    )
    expect(entries(out.find((s) => s.id === "ipam"))).toEqual([
      ["/prefixes", "/ip-ranges"],
    ])
  })

  it("drops a section whose entries are all hidden", () => {
    const out = resolveSidebar(
      MENU,
      layout({ hidden: ["/power-feeds", "/power-panels"] })
    )
    expect(ids(out)).not.toContain("power")
  })

  it("orders sections", () => {
    const out = resolveSidebar(
      MENU,
      layout({ order: ["power", "dcim", "ipam", "org"] })
    )
    expect(ids(out)).toEqual(["power", "dcim", "ipam", "org"])
  })

  it("orders entries within their cluster", () => {
    const out = resolveSidebar(
      MENU,
      layout({
        items: {
          ipam: ["/ip-ranges", "/prefixes", "/ips", "/vlan-groups", "/vlans"],
        },
      })
    )
    expect(entries(out.find((s) => s.id === "ipam"))).toEqual([
      ["/ip-ranges", "/prefixes", "/ips"],
      ["/vlan-groups", "/vlans"],
    ])
  })

  it("shows sections and entries added after the layout was saved", () => {
    const saved = layout({
      order: ["dcim", "org", "ipam", "power"],
      hidden: ["power", "/racks"],
      items: { dcim: ["/racks", "/devices"] },
    })
    const next: Section[] = [
      ...MENU.slice(0, 2),
      sec("dcim", ["/devices", "/cables", "/racks"]),
      sec("wireless", ["/wireless-lans"]),
      MENU[3],
    ]
    const out = resolveSidebar(next, saved)
    // Wireless ships right after DCIM, so it lands after DCIM in the
    // user's order - shown, though Power beside it stays hidden.
    expect(ids(out)).toEqual(["dcim", "wireless", "org", "ipam"])
    expect(entries(out[0])).toEqual([["/devices", "/cables"]])
  })

  it("ignores ids of sections and entries that are gone", () => {
    const out = resolveSidebar(
      MENU,
      layout({ order: ["vpn", "dcim"], hidden: ["vpn", "/old"] })
    )
    expect(ids(out)).toEqual(["org", "ipam", "dcim", "power"])
  })
})

describe("orderSections", () => {
  it("keeps hidden sections, for the editor to list", () => {
    const out = orderSections(
      MENU,
      layout({ order: ["power", "org", "ipam", "dcim"], hidden: ["power"] })
    )
    expect(ids(out)).toEqual(["power", "org", "ipam", "dcim"])
  })
})

describe("layout edits", () => {
  it("hides and shows an id", () => {
    const hidden = setHidden(null, "ipam", true)
    expect(hidden.hidden).toEqual(["ipam"])
    expect(setHidden(hidden, "ipam", true).hidden).toEqual(["ipam"])
    expect(setHidden(hidden, "ipam", false).hidden).toEqual([])
  })

  it("keeps hidden ids of entries not on the current menu", () => {
    const out = setHidden(layout({ hidden: ["/jobs"] }), "power", true)
    expect(out.hidden).toEqual(["/jobs", "power"])
  })

  it("stores section and entry order", () => {
    const a = setSectionOrder(null, ["dcim", "ipam"])
    const b = setItemOrder(a, "dcim", ["/racks", "/devices"])
    expect(b).toEqual(
      layout({
        order: ["dcim", "ipam"],
        items: { dcim: ["/racks", "/devices"] },
      })
    )
  })
})
