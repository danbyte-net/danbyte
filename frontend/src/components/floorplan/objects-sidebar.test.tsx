// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { FloorPlanTile } from "@/lib/api"

import { ObjectsSidebar } from "./objects-sidebar"

// While the plan is coloured by its racks, the rack table under it lists
// them (#247): the Objects sidebar leaves the racks to it and keeps the
// rest.

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: () => new Promise(() => undefined),
}))
afterEach(cleanup)

const TYPE = {
  id: "tt1",
  name: "Rack",
  slug: "rack",
  color: "#3b82f6",
  icon: "",
  default_width: 1,
  default_height: 1,
  is_zone: false,
  has_fov: false,
}

const tile = (id: string, label: string, linked: FloorPlanTile["linked"]) =>
  ({
    id,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    orientation: 0,
    tile_type: TYPE,
    role_type: null,
    label,
    color: "",
    status: "",
    link_kind: linked?.kind ?? "",
    linked,
  }) as FloorPlanTile

const TILES = [
  tile("t1", "A01", {
    kind: "rack",
    id: "r1",
    name: "A01",
    route: "/racks/r1",
  }),
  tile("t2", "A02", {
    kind: "rack",
    id: "r2",
    name: "A02",
    route: "/racks/r2",
  }),
  tile("t3", "Spare slot", null),
]

function mount(omitRacks: boolean) {
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ObjectsSidebar
          tiles={TILES}
          selectedId={null}
          onPick={() => undefined}
          omitRacks={omitRacks}
        />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("ObjectsSidebar", () => {
  it("lists every placed tile", () => {
    mount(false)
    for (const name of ["A01", "A02", "Spare slot"])
      expect(screen.getByText(name)).toBeTruthy()
    expect(screen.queryByText("Racks: in the table below")).toBeNull()
  })

  it("leaves the racks to the rack table while it is open", () => {
    mount(true)
    expect(screen.queryByText("A01")).toBeNull()
    expect(screen.queryByText("A02")).toBeNull()
    // A rack-type tile with no rack yet is no rack the table lists.
    expect(screen.getByText("Spare slot")).toBeTruthy()
    expect(screen.getByText("Racks: in the table below")).toBeTruthy()
  })
})
