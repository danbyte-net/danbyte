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
    ])
  })

  it("lists Lifecycle under DCIM after Support contracts, for device or VM viewers", () => {
    const dcim = urlsOf("DCIM")
    expect(dcim.indexOf("/lifecycle")).toBe(
      dcim.indexOf("/support-contracts") + 1
    )
    const item = sections
      .flatMap((s) => s.clusters.flatMap((c) => c.items))
      .find((i) => i.url === "/lifecycle")
    expect(item?.anyOf).toEqual(["device", "virtualmachine"])
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
    for (const id of ["ipam", "circuits", "power", "wireless", "vpn"])
      expect(ids).toContain(id)
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
