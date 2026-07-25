// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ColumnDef } from "@tanstack/react-table"

import type { DeviceType, Tag } from "@/lib/api"
import { useTableFilters } from "@/components/table-filters"
import { buildDeviceTypeColumns } from "./device-type-columns"

// A hardware catalog is the longest list in the product, so its rail is the one
// that has to actually narrow. These pin what each facet buckets on — the parts
// that are derived rather than read off a foreign key (images, faceplate,
// usage) and the two that hide themselves when the data doesn't split.

const tag = (slug: string): Tag => ({
  id: slug.length,
  name: slug,
  slug,
  color: "",
  text_color: "",
})

let seq = 0
function dt(patch: Partial<DeviceType> = {}): DeviceType {
  seq += 1
  return {
    id: `dt-${seq}`,
    numid: seq,
    name: `type-${seq}`,
    manufacturer: null,
    model: "",
    part_number: "",
    platform: null,
    u_height: 1,
    rack_width: "full",
    description: "",
    front_image: null,
    rear_image: null,
    faceplate: null,
    image_ports: null,
    is_full_depth: true,
    airflow: "",
    weight: null,
    weight_unit: "kg",
    subdevice_role: "",
    exclude_from_utilization: false,
    tags: [],
    custom_fields: {},
    device_count: 0,
    owning_site: null,
    release_date: null,
    end_of_sale: null,
    end_of_security_updates: null,
    end_of_support: null,
    lifecycle_url: "",
    lifecycle_state: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...patch,
  }
}

const marker = {
  kind: "interface",
  name: "eth0",
  x: 0.5,
  y: 0.5,
  w: 0.1,
  h: 0.1,
}
const cisco = { id: "m-cisco", name: "Cisco" }
const site = { id: "s-hq", name: "HQ" }

// front+rear photo, markers placed, in use, EoL, tagged, site-local
const laidOut = dt({
  name: "laid-out",
  manufacturer: cisco,
  front_image: "/media/front.png",
  rear_image: "/media/rear.png",
  image_ports: { front: [marker], rear: [] },
  device_count: 4,
  lifecycle_state: "eol",
  tags: [tag("core")],
  owning_site: site,
  u_height: 2,
})
// front photo only, no markers, custom faceplate saved
const photographed = dt({
  name: "photographed",
  manufacturer: cisco,
  front_image: "/media/front.png",
  faceplate: { v: 1, front: [], rear: [] },
  device_count: 2,
  tags: [tag("core"), tag("edge")],
})
// markers but the photo was removed — the panel falls back, so must the facet
const orphanMarkers = dt({
  name: "orphan-markers",
  image_ports: { front: [marker], rear: [] },
  device_count: 1,
})
// nothing: no photo, no layout, nothing built from it
const bare = dt({ name: "bare", tags: [tag("edge")] })

const ROWS = [laidOut, photographed, orphanMarkers, bare]

function facetColumns(): ColumnDef<DeviceType, unknown>[] {
  return buildDeviceTypeColumns<DeviceType>({ omit: ["part_number"] })
}

/** Mount the rail the page renders and read back its group headings. */
function headings(rows: DeviceType[]): string[] {
  const { result } = renderHook(() => useTableFilters(facetColumns(), rows))
  render(<div>{result.current.rail}</div>)
  return screen.getAllByRole("heading").map((h) => h.textContent)
}

/** Tick one facet option and return the names of the rows that survive. */
function pick(facet: string, ...values: string[]): string[] {
  const { result } = renderHook(() => useTableFilters(facetColumns(), ROWS))
  for (const v of values) act(() => result.current.toggleValue(facet, v))
  return result.current.filteredRows.map((r) => r.name)
}

afterEach(cleanup)

describe("device-type filter rail", () => {
  it("offers every facet the long-catalog page needs, in column order", () => {
    expect(headings(ROWS)).toEqual([
      "Manufacturer",
      "U",
      "Images",
      "Faceplate",
      "Usage",
      "Lifecycle",
      "Scope",
      "Tags",
    ])
  })

  it("hides the derived facets that can't split the rows", () => {
    // One manufacturer-less, image-less, unused, global, untagged row: only the
    // facets that always read as a list of what exists stay.
    const flat = headings([dt({ name: "alone" })])
    expect(flat).not.toContain("Faceplate")
    expect(flat).not.toContain("Scope")
    expect(flat).toContain("Images")
  })

  it("buckets Images on having any rack-face photo", () => {
    expect(pick("images", "yes")).toEqual(["laid-out", "photographed"])
    expect(pick("images", "no")).toEqual(["orphan-markers", "bare"])
  })

  it("buckets Faceplate on what a device of the type would draw", () => {
    // Markers without a photo don't render as photo ports, so they aren't
    // counted as laid out.
    expect(pick("faceplate", "photo")).toEqual(["laid-out"])
    expect(pick("faceplate", "custom")).toEqual(["photographed"])
    expect(pick("faceplate", "auto")).toEqual(["orphan-markers", "bare"])
  })

  it("splits Usage into in-use and unused catalog entries", () => {
    expect(pick("devices", "out")).toEqual(["bare"])
    expect(pick("devices", "in")).toEqual([
      "laid-out",
      "photographed",
      "orphan-markers",
    ])
  })

  it("filters on manufacturer, lifecycle, scope and tags", () => {
    expect(pick("manufacturer", cisco.id)).toEqual(["laid-out", "photographed"])
    expect(pick("lifecycle", "eol")).toEqual(["laid-out"])
    expect(pick("scope", site.id)).toEqual(["laid-out"])
    expect(pick("scope", "__global__")).toEqual([
      "photographed",
      "orphan-markers",
      "bare",
    ])
    // Tags are OR-ed, and the chips in the cells toggle the same state.
    expect(pick("tags", "edge")).toEqual(["photographed", "bare"])
    expect(pick("tags", "core", "edge")).toEqual([
      "laid-out",
      "photographed",
      "bare",
    ])
  })

  it("stacks facets", () => {
    const { result } = renderHook(() => useTableFilters(facetColumns(), ROWS))
    act(() => result.current.toggleValue("images", "yes"))
    act(() => result.current.toggleValue("devices", "in"))
    act(() => result.current.toggleValue("tags", "edge"))
    expect(result.current.filteredRows.map((r) => r.name)).toEqual([
      "photographed",
    ])
    expect(result.current.activeCount).toBe(3)
  })
})

describe("device-type columns shared with other surfaces", () => {
  it("keeps the embedded and monitoring tables to the columns they ask for", () => {
    const embedded = buildDeviceTypeColumns({
      include: ["name", "part_number", "u_height", "devices"],
      heightHeader: "Height",
    })
    expect(embedded.map((c) => c.id)).toEqual([
      "name",
      "part_number",
      "u_height",
      "devices",
    ])

    const policy = buildDeviceTypeColumns({
      include: [
        "name",
        "manufacturer",
        "model",
        "u_height",
        "devices",
        "description",
        "tags",
        "updated",
      ],
      countFacets: "range",
    })
    expect(policy.map((c) => c.id)).toEqual([
      "name",
      "manufacturer",
      "model",
      "u_height",
      "devices",
      "description",
      "tags",
      "updated",
    ])
    // …and that tab keeps its numeric Devices range, not the list's split.
    const devices = policy.find((c) => c.id === "devices")
    expect(devices?.meta?.facet).toMatchObject({ kind: "range" })
  })
})
