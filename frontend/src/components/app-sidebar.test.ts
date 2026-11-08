import { describe, expect, it } from "vitest"

import { activeNavUrl, sections } from "./app-sidebar"

function urlsOf(label: string): string[] {
  const section = sections.find((s) => s.label === label)
  if (!section) throw new Error(`no section ${label}`)
  return section.clusters.flatMap((c) => c.items.map((i) => i.url))
}

describe("app sidebar sections", () => {
  it("lists the map pages under Maps, in order", () => {
    expect(urlsOf("Maps")).toEqual([
      "/site-map",
      "/floorplans",
      "/topology",
      "/virtual-topology",
      "/application-map",
    ])
  })

  it("groups DCIM into Devices, Catalog, Racks & cabinets and Connections", () => {
    const dcim = sections.find((s) => s.id === "dcim")!
    expect(
      dcim.clusters.map((c) => [c.label, c.items.map((i) => i.url)])
    ).toEqual([
      [
        "Devices",
        ["/devices", "/virtual-chassis", "/device-roles", "/device-profiles"],
      ],
      [
        "Catalog",
        [
          "/manufacturers",
          "/device-types",
          "/module-types",
          "/platforms",
          "/platform-groups",
        ],
      ],
      [
        "Racks & cabinets",
        [
          "/racks",
          "/rack-types",
          "/rack-roles",
          "/cabinets",
          "/cabinet-types",
          "/cabinet-roles",
        ],
      ],
      [
        "Connections",
        ["/interfaces", "/cables", "/port-reservations", "/port-utilization"],
      ],
    ])
  })

  it("lists software and lifecycle pages in their own section after DCIM", () => {
    const ids = sections.map((s) => s.id)
    expect(ids.indexOf("software")).toBe(ids.indexOf("dcim") + 1)
    expect(urlsOf("Software & lifecycle")).toEqual([
      "/applications",
      "/application-groups",
      "/lifecycle",
      "/eol-products",
      "/support-contracts",
    ])
  })

  it("keeps each moved page's permission gate", () => {
    const gate = (url: string) => {
      const i = sections
        .flatMap((s) => s.clusters.flatMap((c) => c.items))
        .find((x) => x.url === url)!
      return i.objectType ?? i.anyOf
    }
    expect(gate("/lifecycle")).toEqual(["device", "virtualmachine"])
    expect(gate("/applications")).toBe("application")
    expect(gate("/application-groups")).toBe("applicationgroup")
    expect(gate("/eol-products")).toBe("eolproduct")
    expect(gate("/support-contracts")).toBe("supportcontract")
    expect(gate("/manufacturers")).toBe("manufacturer")
    expect(gate("/device-types")).toBe("devicetype")
    expect(gate("/module-types")).toBe("moduletype")
    expect(gate("/platforms")).toBe("platform")
    expect(gate("/platform-groups")).toBe("platformgroup")
    expect(gate("/device-profiles")).toBe("deviceprofile")
    expect(gate("/port-utilization")).toBe("device")
  })

  it("names the virtual page Virtual topology", () => {
    const item = sections
      .flatMap((s) => s.clusters.flatMap((c) => c.items))
      .find((i) => i.url === "/virtual-topology")
    expect(item?.title).toBe("Virtual topology")
  })

  it("lists each map page in no other section", () => {
    const maps = new Set(urlsOf("Maps"))
    for (const section of sections) {
      if (section.label === "Maps") continue
      for (const url of urlsOf(section.label)) {
        expect(maps.has(url), `${section.label} lists ${url}`).toBe(false)
      }
    }
    expect(urlsOf("DCIM")).not.toContain("/topology")
    expect(urlsOf("Virtualization")).not.toContain("/virtual-topology")
  })
})

describe("sidebar layout ids (#285)", () => {
  it("gives every section a unique id a saved layout can refer to", () => {
    const ids = sections.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of [
      "ipam",
      "dcim",
      "software",
      "circuits",
      "power",
      "wireless",
      "vpn",
    ])
      expect(ids).toContain(id)
  })

  it("points every entry at a route file", () => {
    // Keys only: the route modules are never loaded.
    const files = new Set(
      Object.keys(import.meta.glob("../routes/*.tsx")).map((f) =>
        f.replace("../routes/", "")
      )
    )
    for (const section of sections)
      for (const cluster of section.clusters)
        for (const { url } of cluster.items) {
          const base = url.slice(1).replace(/\//g, ".")
          expect(
            files.has(`${base}.tsx`) || files.has(`${base}.index.tsx`),
            url
          ).toBe(true)
        }
  })

  it("gives every entry a unique id (its URL)", () => {
    const urls = sections.flatMap((s) =>
      s.clusters.flatMap((c) => c.items.map((i) => i.url))
    )
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe("sidebar active entry (#418)", () => {
  const all = sections.flatMap((s) =>
    s.clusters.flatMap((c) => c.items.map((i) => i.url))
  )

  it("lights Calendar alone on the calendar page", () => {
    expect(activeNavUrl("/planning/calendar", all)).toBe("/planning/calendar")
  })

  it("keeps Planning lit on the board list and a board", () => {
    expect(activeNavUrl("/planning", all)).toBe("/planning")
    expect(activeNavUrl("/planning/3f2a", all)).toBe("/planning")
    expect(activeNavUrl("/planning/3f2a/tasks/9", all)).toBe("/planning")
  })

  it("keeps a list entry lit on its detail page", () => {
    expect(activeNavUrl("/devices/abc", all)).toBe("/devices")
  })

  it("does not match a sibling that only shares a name prefix", () => {
    expect(activeNavUrl("/ip-ranges", all)).toBe("/ip-ranges")
    expect(activeNavUrl("/ipsx", all)).toBeNull()
    expect(activeNavUrl("/", all)).toBeNull()
  })

  it("lights exactly one entry for every menu page", () => {
    for (const url of all) {
      for (const path of [url, `${url}/x`]) {
        const lit = all.filter((u) => u === activeNavUrl(path, all))
        expect(lit, path).toEqual([url])
      }
    }
  })

  it("is independent of entry order (custom layouts, plugin entries)", () => {
    const urls = ["/plugins/x/sub", "/plugins/x"]
    expect(activeNavUrl("/plugins/x/sub/1", urls)).toBe("/plugins/x/sub")
    expect(activeNavUrl("/plugins/x/sub/1", [...urls].reverse())).toBe(
      "/plugins/x/sub"
    )
  })
})
