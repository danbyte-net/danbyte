// @vitest-environment jsdom
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ConnectPair,
  ConnectPort,
  ConnectPreview,
  ConnectRequest,
  FloorPlanTile,
  FloorPlanTray,
  StoredCablePath,
} from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import {
  applyNewCables,
  cableDraftPayload,
  draftCablePorts,
  EMPTY_CABLE_DRAFT,
  withDraftRoutes,
} from "./cable-draft"
import {
  ConnectCablesPanel,
  connectCandidates,
  connectRequest,
} from "./connect-cables"
import type { ConnectApply, ConnectSource } from "./connect-cables"
import { AfterPlacingCard } from "./place-cables"
import type { PlanShape } from "./shapes"

// Connect to…: pick targets on the floor (on the plan or from a list,
// same room first); the server proposes port pairs, which can be changed
// or dropped; the kept pairs preview on the plan; Add cables hands them to
// the draft, which Save sends as `cables.create` with their routes.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

afterEach(cleanup)
beforeEach(() => apiMock.mockReset())

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  )
}

const tile = (
  id: string,
  x: number,
  kind: string,
  oid: string,
  name: string,
  hidden = false
) =>
  ({
    id,
    x,
    y: 2,
    width: 1,
    height: 1,
    linked: hidden
      ? { kind, id: null, name: "Hidden", hidden: true }
      : { kind, id: oid, name },
  }) as unknown as FloorPlanTile

const tiles = [
  tile("t1", 0, "device", "d1", "sw-a"),
  tile("t2", 10, "rack", "r2", "RB"),
  tile("t3", 4, "device", "d3", "srv-3"),
  tile("t4", 2, "device", "d4", "secret", true),
  tile("t5", 30, "cabinet", "c5", "CAB-1"),
]
const room = {
  id: "a1",
  kind: "area",
  x: 0,
  y: 0,
  width: 12,
  height: 6,
  room: { id: "rm", name: "Hall", color: "" },
} as unknown as PlanShape
const sources: ConnectSource[] = [
  { kind: "device", id: "d1", name: "sw-a", tileId: "t1" },
]

const port = (over: Partial<ConnectPort>): ConnectPort => ({
  kind: "interface",
  id: "p",
  name: "ge-1",
  device: "d1",
  device_name: "sw-a",
  type: "1000base-t",
  media: "copper",
  connector: "rj45",
  speed_mbps: 1000,
  uplink: false,
  mgmt_only: false,
  poe_mode: "",
  ...over,
})

function route(): StoredCablePath {
  const points: [number, number][] = [
    [0.5, 2.5],
    [10.5, 2.5],
  ]
  return {
    kind: "trays",
    legs: [
      {
        from: { end: "A", tile: "t1", device: "d1", at: points[0] },
        to: { end: "B", tile: "t2", device: "d2", at: points[1] },
        points,
        trays: [
          { id: "tr1", entry: points[0], exit: points[1], elevation_mm: 2700 },
        ],
        waypoints: [],
      },
    ],
    tray_order: ["tr1"],
    run_mm: 6000,
    drop_a_mm: 800,
    drop_b_mm: 800,
    extra_mm: 0,
    slack_mm: 760,
    length_mm: 8500,
  }
}

const pair = (key: string, a: string, b: string): ConnectPair => ({
  key,
  a: port({ id: `a-${a}`, name: a }),
  b: port({ id: `b-${b}`, name: b, device: "d2", device_name: "sw-b" }),
  type: "cat6",
  route: route(),
  via: "trays",
  suggestions: [],
  reason: "",
  error: "",
})

const trays = [
  {
    id: "tr1",
    name: "T-1",
    points: [
      [0, 1],
      [11, 1],
    ],
  },
] as unknown as FloorPlanTray[]

const planned = { id: "st1", name: "Planned", color: "#888888" }

function answer(
  make: (req: ConnectRequest) => Partial<ConnectPreview>,
  ports: ConnectPort[] = []
) {
  apiMock.mockImplementation(async (url, init) => {
    if (String(url).includes("/cable-plan/ports/")) return { ports }
    if (String(url).includes("/dcim/choices/")) return {}
    const req = JSON.parse(String(init?.body ?? "{}")) as ConnectRequest
    return {
      pairs: [],
      short: [],
      statuses: [planned],
      can_add: true,
      suggestions: [],
      cell_mm: 600,
      scale_source: null,
      ...make(req),
    }
  })
}
const planRequests = () =>
  apiMock.mock.calls
    .filter(([url]) => String(url).endsWith("/cable-plan/"))
    .map(([, init]) => JSON.parse(String(init!.body)) as ConnectRequest)

type PanelProps = Parameters<typeof ConnectCablesPanel>[0]

function panel(over: Partial<PanelProps> = {}) {
  const props = {
    planId: "p1",
    sources,
    tiles,
    shapes: [room],
    trays,
    input: {},
    onTilePick: vi.fn<PanelProps["onTilePick"]>(),
    onPreviews: vi.fn<PanelProps["onPreviews"]>(),
    onApply: vi.fn<(a: ConnectApply) => void>(),
    onClose: vi.fn(),
    ...over,
  }
  wrap(<ConnectCablesPanel {...props} />)
  return props
}

describe("connectCandidates", () => {
  it("ranks the same room first, then the nearest; never hidden or the source", () => {
    const c = connectCandidates(tiles, [room], sources)
    expect(c.map((x) => x.name)).toEqual(["srv-3", "RB", "CAB-1"])
    expect(c[0].sameRoom).toBe(true)
    expect(c[2].sameRoom).toBe(false)
  })
})

describe("connectRequest", () => {
  it("sends the targets, the draft's ports and the edited pairs", () => {
    const req = connectRequest({
      sources,
      targets: [{ kind: "rack", id: "r2" }],
      family: "data",
      perTarget: 2,
      includeMgmt: false,
      taken: [{ kind: "interface", id: "x" }],
      input: { positions: { t1: { x: 1, y: 2 } } },
      pairs: null,
      suggestRuns: false,
      keepRuns: true,
    })
    expect(req).toEqual({
      mode: "new",
      source: [{ kind: "device", id: "d1" }],
      targets: [{ kind: "rack", id: "r2" }],
      family: "data",
      per_target: 2,
      exclude_ports: [{ kind: "interface", id: "x" }],
      positions: { t1: { x: 1, y: 2 } },
    })
  })
})

describe("ConnectCablesPanel", () => {
  it("picks targets on the plan and from the list", async () => {
    answer(() => ({ pairs: [pair("pair-1", "ge-8", "ge-8")] }))
    const props = panel()
    // Picking on the plan is on from the start.
    await waitFor(() => expect(props.onTilePick).toHaveBeenCalled())
    const pick = props.onTilePick.mock.calls.at(-1)![0]!
    pick.onPick(tiles[1])
    await waitFor(() => expect(planRequests().length).toBe(1))
    expect(planRequests()[0].targets).toEqual([{ kind: "rack", id: "r2" }])
    // A hidden tile is never picked.
    props.onTilePick.mock.calls.at(-1)![0]!.onPick(tiles[3])
    fireEvent.click(screen.getByRole("checkbox", { name: "Connect to srv-3" }))
    await waitFor(() =>
      expect(planRequests().at(-1)!.targets).toEqual([
        { kind: "rack", id: "r2" },
        { kind: "device", id: "d3" },
      ])
    )
    expect(props.onTilePick.mock.calls.at(-1)![0]!.picked.has("t3")).toBe(true)
  })

  it("previews the kept pairs and drops one", async () => {
    answer(() => ({
      pairs: [pair("pair-1", "ge-8", "ge-8"), pair("pair-2", "ge-7", "ge-7")],
    }))
    const props = panel()
    fireEvent.click(screen.getByRole("checkbox", { name: "Connect to RB" }))
    await screen.findByText("sw-a · ge-8 → sw-b · ge-8")
    await waitFor(() => {
      const routes = props.onPreviews.mock.calls.at(-1)![0]
      expect([...(routes?.keys() ?? [])]).toEqual(["pair-1", "pair-2"])
    })
    expect(screen.getAllByText("8.5 m").length).toBe(2)
    fireEvent.click(screen.getByRole("button", { name: "Drop ge-7" }))
    await waitFor(() => {
      const routes = props.onPreviews.mock.calls.at(-1)![0]
      expect([...(routes?.keys() ?? [])]).toEqual(["pair-1"])
    })
    fireEvent.click(screen.getByRole("button", { name: "Add 1 cable" }))
    const applied = props.onApply.mock.calls[0][0]
    expect(applied.pairs.map((p) => p.key)).toEqual(["pair-1"])
    expect(applied.status).toEqual(planned)
  })

  it("changes a port with the picker and sends the edited pairs", async () => {
    const ge5 = port({ id: "a-ge-5", name: "ge-5" })
    answer(
      (req) =>
        req.pairs
          ? {
              pairs: req.pairs.map((p) => ({
                ...pair(p.key, p.a.id.slice(2), "ge-8"),
              })),
            }
          : { pairs: [pair("pair-1", "ge-8", "ge-8")] },
      [ge5]
    )
    panel()
    fireEvent.click(screen.getByRole("checkbox", { name: "Connect to RB" }))
    await screen.findByText("sw-a · ge-8 → sw-b · ge-8")
    fireEvent.click(
      screen.getByRole("button", { name: "Change ports of ge-8" })
    )
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([url]) =>
          String(url).includes("/cable-plan/ports/?device=d1")
        )
      ).toBe(true)
    )
    const [first] = screen.getAllByRole("combobox")
    fireEvent.click(first)
    fireEvent.click(await screen.findByText("ge-5"))
    await waitFor(() =>
      expect(planRequests().at(-1)!.pairs).toEqual([
        {
          key: "pair-1",
          a: { kind: "interface", id: "a-ge-5" },
          b: { kind: "interface", id: "b-ge-8" },
        },
      ])
    )
    await screen.findByText("sw-a · ge-5 → sw-b · ge-8")
  })

  it("says so when no planned status exists, and adds nothing", async () => {
    answer(() => ({ pairs: [pair("pair-1", "ge-8", "ge-8")], statuses: [] }))
    panel()
    fireEvent.click(screen.getByRole("checkbox", { name: "Connect to RB" }))
    await screen.findByText("No planned cable status.", { exact: false })
    expect(
      screen.getByRole("link", { name: "Add one" }).getAttribute("href")
    ).toBe("/statuses/new")
    expect(
      screen
        .getByRole("button", { name: "Add 1 cable" })
        .hasAttribute("disabled")
    ).toBe(true)
  })

  it("lists pairs that got no cable, and why", async () => {
    answer(() => ({
      short: [
        {
          a_device: { id: "d1", name: "sw-a" },
          b_device: { id: "d2", name: "sw-b" },
          made: 0,
          reason: "No free ports.",
        },
      ],
    }))
    panel()
    fireEvent.click(screen.getByRole("checkbox", { name: "Connect to RB" }))
    await screen.findByText("sw-a → sw-b: No free ports.")
  })
})

describe("new cables in the draft", () => {
  const apply = () => {
    let n = 0
    return applyNewCables(EMPTY_CABLE_DRAFT, {
      pairs: [
        pair("pair-1", "ge-8", "ge-8"),
        { ...pair("pair-2", "ge-7", "ge-7"), route: null },
      ],
      type: null,
      color: "#ff0000",
      status: planned,
      trays: [],
      newId: () => `new-${++n}`,
    })
  }

  it("holds the cables and their routes as one step", () => {
    const cd = apply()
    expect(cd.cables!.map((c) => [c.key, c.type, c.status.id])).toEqual([
      ["new-1", "cat6", "st1"],
      ["new-2", "cat6", "st1"],
    ])
    expect(Object.keys(cd.routes)).toEqual(["new-1"])
    expect(cd.routes["new-1"]!.length).toBe("write")
    expect(draftCablePorts(cd).map((p) => p.id)).toEqual([
      "a-ge-8",
      "b-ge-8",
      "a-ge-7",
      "b-ge-7",
    ])
  })

  it("saves them as cables.create, then their routes by key", () => {
    const out = cableDraftPayload(apply(), tiles)
    expect(out.cables!.create).toEqual([
      {
        key: "new-1",
        a: [{ kind: "interface", id: "a-ge-8" }],
        b: [{ kind: "interface", id: "b-ge-8" }],
        type: "cat6",
        color: "#ff0000",
        status_id: "st1",
      },
      {
        key: "new-2",
        a: [{ kind: "interface", id: "a-ge-7" }],
        b: [{ kind: "interface", id: "b-ge-7" }],
        type: "cat6",
        color: "#ff0000",
        status_id: "st1",
      },
    ])
    expect(
      out.cable_paths!.upsert.map((u) => [u.cable, u.write_length])
    ).toEqual([["new-1", true]])
  })

  it("draws them as planned until saved", () => {
    const drawn = withDraftRoutes([], apply())
    expect(drawn).toHaveLength(1)
    expect(drawn[0].status?.is_planned).toBe(true)
    expect(drawn[0].label).toBe("sw-a · ge-8 → sw-b · ge-8")
  })
})

describe("After placing → Connect to…", () => {
  it("offers new cables even with nothing else to do", () => {
    const onConnect = vi.fn()
    wrap(
      <AfterPlacingCard
        room={null}
        roomBusy={false}
        onSetRoom={() => {}}
        cables={0}
        onRouteCables={() => {}}
        onConnect={onConnect}
        onDismiss={() => {}}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Connect to…" }))
    expect(onConnect).toHaveBeenCalled()
  })
})
