import { describe, expect, it } from "vitest"

import { sections } from "./app-sidebar"

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
