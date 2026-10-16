// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { flexRender } from "@tanstack/react-table"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { TagList } from "@/components/cells/tag-list"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import {
  useUrlTableFilters,
  wireFacetColumns,
} from "@/components/table-filters"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { Device, IPAddress, Prefix, Tag } from "@/lib/api"

// Tag chips on the Devices, Prefixes and IP addresses lists toggle the Tag
// facet, which lives in the URL as `?tag=`; a tag on a detail page links to
// its list filtered by that tag.

const CORE: Tag = {
  id: 7,
  slug: "core",
  name: "Core",
  color: "",
  text_color: "",
}
const EDGE: Tag = {
  id: 8,
  slug: "edge",
  name: "Edge",
  color: "",
  text_color: "",
}

type AnyRow = { id: string; tags: Tag[] }
const ROWS = [
  { id: "a", name: "a", tags: [CORE] },
  { id: "b", name: "b", tags: [EDGE] },
] as unknown as AnyRow[]

type Build = () => ColumnDef<AnyRow, unknown>[]

const LISTS: { name: string; build: Build; pageWires?: boolean }[] = [
  {
    name: "devices",
    build: () =>
      buildDeviceColumns<Device>({}) as unknown as ColumnDef<AnyRow, unknown>[],
  },
  {
    name: "ips",
    build: () =>
      buildIpColumns<IPAddress>({}) as unknown as ColumnDef<AnyRow, unknown>[],
  },
  {
    name: "prefixes",
    build: () =>
      buildPrefixColumns<Prefix>({}) as unknown as ColumnDef<AnyRow, unknown>[],
    // /prefixes renders its own column set and wires the chips itself.
    pageWires: true,
  },
]

function makeRouter(url: string, build: Build, pageWires: boolean) {
  function List() {
    const facetColumns = useMemo(build, [])
    const { columns, filteredRows, selectedValues, toggleValue } =
      useUrlTableFilters(facetColumns, ROWS)
    const rendered = useMemo(
      () =>
        pageWires
          ? wireFacetColumns(facetColumns, selectedValues, toggleValue)
          : columns,
      [columns, facetColumns, selectedValues, toggleValue]
    )
    const tagsCol = rendered.find((c) => c.id === "tags")!
    return (
      <div>
        <p data-testid="rows">{filteredRows.map((r) => r.id).join(" ")}</p>
        {ROWS.map((r) => (
          <div key={r.id} data-testid={`tags-${r.id}`}>
            {flexRender(tagsCol.cell, {
              row: { original: r },
              column: { columnDef: tagsCol },
            } as never)}
          </div>
        ))}
      </div>
    )
  }
  const root = createRootRoute()
  const list = createRoute({
    getParentRoute: () => root,
    path: "/list",
    component: List,
  })
  return createRouter({
    routeTree: root.addChildren([list]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
}

const chip = (rowId: string) =>
  screen.getByTestId(`tags-${rowId}`).querySelector("[data-slot=badge]")!

afterEach(cleanup)

describe.each(LISTS)("$name list tag chips", ({ build, pageWires }) => {
  it("toggle the Tag facet in ?tag= with the active ring", async () => {
    const router = makeRouter("/list", build, !!pageWires)
    render(<RouterProvider router={router as never} />)
    await screen.findByTestId("rows")

    fireEvent.click(chip("a"))
    await waitFor(() =>
      expect(
        (router.state.location.search as Record<string, unknown>).tag
      ).toBe("core")
    )
    expect(screen.getByTestId("rows").textContent).toBe("a")
    expect(chip("a").className).toMatch(/ring-1/)
  })

  it("land filtered from a link", async () => {
    const router = makeRouter("/list?tag=edge", build, !!pageWires)
    render(<RouterProvider router={router as never} />)
    await screen.findByTestId("rows")
    expect(screen.getByTestId("rows").textContent).toBe("b")
  })
})

describe("a tag on a detail page", () => {
  it("links to its list filtered by the tag", async () => {
    const root = createRootRoute({
      component: () => (
        <TooltipProvider>
          <TagList tags={[CORE]} listTo="/devices" />
        </TooltipProvider>
      ),
    })
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
    render(<RouterProvider router={router as never} />)
    const link = await screen.findByRole("link", { name: "Core" })
    expect(link.getAttribute("href")).toBe("/devices?tag=core")
  })
})
