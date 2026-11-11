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
      "/vulnerabilities",
      "/eol-products",
      "/support-contracts",
    ])
  })

  it("shows Vulnerabilities only while the feature is on", () => {
    const item = sections
      .flatMap((s) => s.clusters.flatMap((c) => c.items))
      .find((x) => x.url === "/vulnerabilities")!
    expect(item.feature).toBe("vulnerabilities")
    expect(item.anyOf).toEqual(["device", "virtualmachine"])
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
          // `monitoring_.checks.index.tsx`: a page under /monitoring that
          // opts out of the /monitoring layout.
          const escaped = base.replace(/^([^.]+)\./, "$1_.")
          expect(
            [base, escaped].some(
              (b) => files.has(`${b}.tsx`) || files.has(`${b}.index.tsx`)
            ),
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

  it("gives Monitoring its own section: the work, then its setup", () => {
    const monitoring = sections.find((s) => s.id === "monitoring")!
    expect(monitoring.label).toBe("Monitoring")
    expect(
      monitoring.clusters.map((c) => [c.label, c.items.map((i) => i.url)])
    ).toEqual([
      [
        undefined,
        [
          "/monitoring",
          "/monitoring/checks",
          "/alerts",
          "/monitoring/sla",
          "/monitoring/performance",
          "/discovery",
        ],
      ],
      [
        "Setup",
        ["/monitoring/policies", "/monitoring/settings", "/monitoring-engines"],
      ],
    ])
    const ids = sections.map((s) => s.id)
    expect(ids.indexOf("governance")).toBe(ids.indexOf("monitoring") + 1)
    for (const url of ["/monitoring", "/alerts", "/discovery"])
      expect(urlsOf("Governance")).not.toContain(url)
  })

  it("keeps the gate each Monitoring tab had", () => {
    const item = (url: string) =>
      sections
        .flatMap((s) => s.clusters.flatMap((c) => c.items))
        .find((x) => x.url === url)!
    const monitoring = ["checktemplate", "checkassignment", "silence"]
    for (const url of [
      "/monitoring",
      "/monitoring/checks",
      "/monitoring/sla",
      "/monitoring/performance",
      "/monitoring/policies",
    ])
      expect(item(url).anyOf, url).toEqual(monitoring)
    expect(item("/monitoring/settings").perm).toBe("users.manage")
    expect(item("/monitoring-engines").perm).toBe("users.manage")
    expect(item("/discovery").objectType).toBe("inventoryprofile")
    expect(item("/discovery").integration).toEqual(["discovery"])
    expect(item("/alerts").anyOf).toEqual([
      "alertrule",
      "notificationchannel",
      "silence",
    ])
  })

  it("lights the Monitoring page a URL belongs to", () => {
    const urls = sections.flatMap((s) =>
      s.clusters.flatMap((c) => c.items.map((i) => i.url))
    )
    expect(activeNavUrl("/monitoring", urls)).toBe("/monitoring")
    expect(activeNavUrl("/monitoring/checks/abc", urls)).toBe(
      "/monitoring/checks"
    )
    expect(activeNavUrl("/monitoring/sla/templates/x", urls)).toBe(
      "/monitoring/sla"
    )
    expect(activeNavUrl("/monitoring-engines", urls)).toBe(
      "/monitoring-engines"
    )
    expect(activeNavUrl("/discovery/findings", urls)).toBe("/discovery")
  })
})
