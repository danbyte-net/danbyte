// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  SiteMapCable,
  SiteMapCapacity,
  SiteMapConnection,
  SiteMapLink,
  SiteMapLinkEnd,
} from "@/lib/api"
import {
  bundleText,
  CableSummary,
  LinkFacts,
  showCableEnds,
  speedText,
} from "./link-facts"

// A line's facts (#246), shared by its popover and its inspector: the speed
// and where it came from, the circuit's provider and ID, the ports at each
// end with their speeds (an end you may not view says so and nothing more),
// and a bundle's links - a few in the popover, the rest counted.

vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/lib/use-dcim-choices", () => ({
  useCableTypeLabel: () => (v: string) => v.toUpperCase(),
}))

afterEach(cleanup)

const cap = (
  label: string,
  source: SiteMapCapacity["source"],
  more: Partial<SiteMapCapacity> = {}
): SiteMapCapacity => ({
  kbps: 1,
  up_kbps: null,
  source,
  label,
  count: 1,
  unknown: 0,
  ...more,
})

const port = (name: string, speed_kbps: number | null = null) => ({
  id: `p-${name}`,
  name,
  kind: "interface",
  speed_kbps,
})

const end = (
  device: string | null,
  p: ReturnType<typeof port> | null,
  more: Partial<SiteMapLinkEnd> = {}
): SiteMapLinkEnd => ({
  site_id: "s",
  device: device ? { id: `d-${device}`, name: device } : null,
  port: p,
  restricted: false,
  ...more,
})

const HIDDEN: SiteMapLinkEnd = {
  site_id: null,
  device: null,
  port: null,
  restricted: true,
}

const link = (
  a: SiteMapLinkEnd,
  z: SiteMapLinkEnd,
  label: string | null,
  cable_id: string | null = null
): SiteMapLink => ({
  a,
  z,
  cable_id,
  capacity: label ? { kbps: 1, up_kbps: null, source: "cable", label } : null,
})

const site = (id: string) => ({ id, name: id, latitude: 55, longitude: 10 })

const circuit = (more: Partial<SiteMapConnection> = {}): SiteMapConnection => ({
  id: "circuit:c1",
  kind: "circuit",
  name: "AAL-AAR",
  site_a: site("Aalborg"),
  site_z: site("Aarhus"),
  color: "",
  status: null,
  meta: { provider: "TDC NET", type: "Dark fiber", commit_rate_kbps: 1 },
  ...more,
})

/** The value cell of the row labelled `label`. */
const row = (label: string) =>
  screen.getByText(label, { selector: "span" }).nextElementSibling!

describe("speedText", () => {
  it("says the figure and where it came from, tersely", () => {
    expect(speedText(cap("10G", "cable"))).toBe("10G · cable")
    expect(speedText(cap("500/100M", "commit"))).toBe("500/100M · commit rate")
    expect(speedText(cap("1G", "port"))).toBe("1G · port speed")
    expect(speedText(cap("10G", "interface"))).toBe("10G · interfaces")
    expect(speedText(cap("500M", "override"))).toBe("500M · set on tunnel")
    expect(speedText(null)).toBeNull()
    expect(speedText(undefined)).toBeNull()
  })
})

describe("bundleText", () => {
  it("counts a bundle's links and the unknown ones, not a single link", () => {
    expect(bundleText(cap("10G", "cable"), 1)).toBeNull()
    expect(bundleText(cap("3×10G", "cable", { count: 3 }), 3)).toBe("3 links")
    expect(bundleText(cap("1G", "cable", { count: 1, unknown: 3 }), 4)).toBe(
      "4 links · 3 unknown"
    )
    // Nothing known: the links there are.
    expect(bundleText(null, 4)).toBe("4 links")
    expect(bundleText(null, 1)).toBeNull()
  })
})

describe("LinkFacts", () => {
  it("shows a circuit's speed, provider, ID and type", () => {
    render(
      <LinkFacts
        line={circuit({
          capacity: cap("100G", "commit"),
          links: [
            link(
              end(null, null, {
                termination: {
                  id: "t1",
                  side: "A",
                  port_speed_kbps: 100_000_000,
                  upstream_speed_kbps: null,
                },
              }),
              end("aarhus-core1", port("Ethernet1/49", 100_000_000)),
              "100G"
            ),
          ],
          link_count: 1,
        })}
      />
    )
    expect(row("Speed").textContent).toBe("100G · commit rate")
    expect(row("Provider").textContent).toBe("TDC NET")
    expect(row("Circuit ID").textContent).toContain("AAL-AAR")
    expect(screen.getByRole("button", { name: "Copy AAL-AAR" })).toBeTruthy()
    expect(row("Type").textContent).toBe("Dark fiber")
    // One link: its two ends, each with its speed. A side not cabled still
    // shows its termination's port speed.
    const ends = screen.getByRole("region", { name: "Ends" })
    expect(within(ends).getByText("A").nextElementSibling!.textContent).toBe(
      "Not cabled · 100G"
    )
    expect(within(ends).getByText("Z").nextElementSibling!.textContent).toBe(
      "aarhus-core1 · Ethernet1/49 · 100G"
    )
    expect(screen.queryByRole("region", { name: "Links" })).toBeNull()
    expect(screen.queryByText("Bundle")).toBeNull()
  })

  it("an asymmetric termination reads both directions", () => {
    render(
      <LinkFacts
        line={circuit({
          capacity: cap("500/100M", "port"),
          links: [
            link(
              end(null, null, {
                termination: {
                  id: "t1",
                  side: "A",
                  port_speed_kbps: 500_000,
                  upstream_speed_kbps: 100_000,
                },
              }),
              end(null, null),
              "500/100M"
            ),
          ],
          link_count: 1,
        })}
      />
    )
    expect(row("Speed").textContent).toBe("500/100M · port speed")
    expect(screen.getByText("A").nextElementSibling!.textContent).toBe(
      "Not cabled · 500/100M"
    )
  })

  it("says Unknown rather than guess, and waits for the capacity payload", () => {
    const { rerender } = render(
      <LinkFacts line={circuit({ capacity: null, links: [], link_count: 0 })} />
    )
    expect(row("Speed").textContent).toBe("Unknown")
    // The plain payload (no ?include=capacity) has no speed rows at all.
    rerender(<LinkFacts line={circuit()} />)
    expect(screen.queryByText("Speed")).toBeNull()
    expect(row("Provider").textContent).toBe("TDC NET")
  })

  it("shows a tunnel's own figure, encapsulation and group", () => {
    render(
      <LinkFacts
        line={{
          kind: "tunnel",
          name: "vpn",
          meta: { encapsulation: "gre", group: "Branches" },
          capacity: cap("500M", "override"),
          links: [
            link(
              end("hq-fw1", port("tun0")),
              end(null, null, {
                virtual_machine: { id: "vm1", name: "edge-vm" },
                port: { ...port("wg0"), kind: "vm_interface" },
              }),
              "500M"
            ),
          ],
          link_count: 1,
        }}
      />
    )
    expect(row("Speed").textContent).toBe("500M · set on tunnel")
    expect(row("Encapsulation").textContent).toBe("gre")
    expect(row("Group").textContent).toBe("Branches")
    expect(screen.getByText("Z").nextElementSibling!.textContent).toBe(
      "edge-vm · wg0"
    )
  })

  it("shows an end you may not view as restricted, and nothing about it", () => {
    render(
      <LinkFacts
        line={{
          kind: "cable",
          capacity: null,
          links: [
            link(end("a-sw1", port("xe-0/0/1", 10_000_000)), HIDDEN, null),
          ],
          link_count: 1,
        }}
      />
    )
    expect(screen.getByText("Z").nextElementSibling!.textContent).toBe(
      "Restricted"
    )
    expect(screen.getByText("A").nextElementSibling!.textContent).toBe(
      "a-sw1 · xe-0/0/1 · 10G"
    )
  })

  const bundle = (n: number, total = n) => ({
    kind: "cable",
    meta: { count: 2 },
    capacity: cap(`${total}×10G`, "cable", { count: total }),
    links: Array.from({ length: n }, (_, i) =>
      link(
        end("aal-core1", port(`Ethernet1/${i + 1}`)),
        end("aar-fw1", port(`ethernet1/${i + 1}`)),
        "10G",
        `cab-${i}`
      )
    ),
    link_count: total,
  })

  it("lists a bundle's links: a few in the popover, the rest counted", () => {
    render(<LinkFacts line={bundle(5)} compact />)
    expect(row("Bundle").textContent).toBe("5 links")
    expect(row("Cables").textContent).toBe("2")
    const links = screen.getByRole("region", { name: "Links" })
    expect(within(links).getAllByText("10G")).toHaveLength(3)
    expect(links.textContent).toContain("aal-core1 · Ethernet1/1")
    expect(links.textContent).not.toContain("Ethernet1/4")
    expect(links.textContent).toContain("+2 more")
    expect(screen.queryByRole("region", { name: "Ends" })).toBeNull()
  })

  it("lists every link the map sent in the inspector, and counts past 50", () => {
    render(<LinkFacts line={bundle(50, 64)} />)
    const links = screen.getByRole("region", { name: "Links" })
    expect(within(links).getAllByText("10G")).toHaveLength(50)
    expect(links.textContent).toContain("+14 more")
  })

  it("marks a link of unknown speed", () => {
    render(
      <LinkFacts
        line={{
          kind: "cable",
          capacity: cap("1G", "cable", { count: 1, unknown: 1 }),
          links: [
            link(end("a", port("1")), end("b", port("1")), "1G"),
            link(end("a", port("2")), end("b", port("2")), null),
          ],
          link_count: 2,
        }}
      />
    )
    expect(row("Bundle").textContent).toBe("2 links · 1 unknown")
    const links = screen.getByRole("region", { name: "Links" })
    expect(within(links).getByText("Unknown")).toBeTruthy()
  })
})

const cableEnd = (device: string, p: string) => ({
  lat: 55,
  lng: 10,
  device_id: `d-${device}`,
  device_name: device,
  site_id: "s",
  port: p,
  kind: "interface",
})

const plainCable = (more: Partial<SiteMapCable> = {}): SiteMapCable => ({
  id: "cab1",
  label: "UP1",
  type: "smf",
  color: "",
  status: { name: "Active", color: "#10b981" },
  fiber_count: 2,
  a: cableEnd("sw1", "xe-1"),
  z: cableEnd("sw2", "xe-2"),
  route_ids: [],
  same_point: false,
  ...more,
})

describe("showCableEnds", () => {
  it("drops a plain cable's ends: its one link says the same", () => {
    const one = link(
      end("sw1", port("xe-1")),
      end("sw2", port("xe-2")),
      "10G",
      "cab1"
    )
    one.a.device!.id = "d-sw1"
    one.z.device!.id = "d-sw2"
    expect(showCableEnds(plainCable({ links: [one], link_count: 1 }))).toBe(
      false
    )
  })

  it("keeps them for a trunk, several links, none, or the plain payload", () => {
    const through = link(
      end("sw1", port("xe-9")),
      end("sw2", port("xe-2")),
      "10G"
    )
    expect(showCableEnds(plainCable({ links: [through], link_count: 1 }))).toBe(
      true
    )
    expect(showCableEnds(plainCable({ links: [], link_count: 0 }))).toBe(true)
    expect(showCableEnds(plainCable())).toBe(true)
  })
})

describe("CableSummary", () => {
  it("shows the type, status pill and strands", () => {
    render(<CableSummary cable={plainCable()} />)
    expect(screen.getByText("SMF")).toBeTruthy()
    // The status is its pill.
    expect(screen.getByText("Active").getAttribute("style")).toContain(
      "background-color"
    )
    expect(screen.getByText("strands")).toBeTruthy()
    expect(screen.getByText(":xe-1")).toBeTruthy()
  })
})
