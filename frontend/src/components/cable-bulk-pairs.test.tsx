// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { CableBulkPairs } from "./cable-bulk-pairs"
import type { BulkPair } from "./cable-bulk-pairs"

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
// The device picker is covered on its own; here it is one button per device.
vi.mock("@/components/device-picker", () => ({
  DevicePicker: ({ onChange }: { onChange: (v: string) => void }) => (
    <div>
      <button type="button" onClick={() => onChange("sw1")}>
        pick sw1
      </button>
      <button type="button" onClick={() => onChange("pp1")}>
        pick pp1
      </button>
    </div>
  ),
}))

afterEach(cleanup)

const page = <T,>(results: T[]) => ({ count: results.length, results })

const answers: Record<string, unknown> = {
  "/api/devices/sw1/": { id: "sw1", name: "sw1" },
  "/api/devices/pp1/": { id: "pp1", name: "pp1" },
  "/api/interfaces/?device=sw1": page([
    { id: "g10", name: "Gi1/0/10", cable: null },
    { id: "g1", name: "Gi1/0/1", cable: null },
    { id: "g2", name: "Gi1/0/2", cable: { id: "c1" } },
    { id: "g3", name: "Gi1/0/3", cable: null },
  ]),
  "/api/front-ports/?device=pp1": page([
    { id: "f1", name: "Front 1", cable: null },
    { id: "f2", name: "Front 2", cable: null },
    { id: "f3", name: "Front 3", cable: null },
  ]),
}

function setup(errors?: Record<string, unknown>[]) {
  const onPairs = vi.fn<(p: BulkPair[]) => void>()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (errs?: Record<string, unknown>[]) => (
    <QueryClientProvider client={qc}>
      <CableBulkPairs onPairsChange={onPairs} errors={errs} />
    </QueryClientProvider>
  )
  const r = render(ui(errors))
  return {
    onPairs,
    rerender: (e?: Record<string, unknown>[]) => r.rerender(ui(e)),
  }
}

describe("CableBulkPairs (#454)", () => {
  beforeEach(() => {
    apiMock.mockReset()
    apiMock.mockImplementation((path: string) => {
      const hit = Object.keys(answers).find((k) => path.startsWith(k))
      return hit ? Promise.resolve(answers[hit]) : new Promise(() => {})
    })
  })

  async function tickBoth() {
    const [pickA] = screen.getAllByRole("button", { name: "pick sw1" })
    fireEvent.click(pickA)
    const pickB = screen.getAllByRole("button", { name: "pick pp1" })[1]
    fireEvent.click(pickB)
    // B lands on front ports.
    const fronts = await screen.findAllByRole("button", { name: "Front" })
    fireEvent.click(fronts[1])
    return screen.findByRole("checkbox", { name: "Front 1" })
  }

  it("lists free ports only, in natural order", async () => {
    setup()
    fireEvent.click(screen.getAllByRole("button", { name: "pick sw1" })[0])
    await screen.findByRole("checkbox", { name: "Gi1/0/1" })
    expect(
      screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))
    ).toEqual(["Gi1/0/1", "Gi1/0/3", "Gi1/0/10"])
  })

  it("pairs the ticked ports positionally and previews each pair", async () => {
    const { onPairs } = setup()
    await tickBoth()
    // Ticked out of order on A; the pairing still reads top-down.
    fireEvent.click(screen.getByRole("checkbox", { name: "Gi1/0/10" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Gi1/0/1" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Front 1" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Front 2" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Front 3" }))

    await waitFor(() => expect(screen.getByText("Pairs (2)")).toBeTruthy())
    const rows = screen.getAllByRole("row").slice(1)
    expect(rows.map((r) => r.textContent)).toEqual([
      "1sw1:Gi1/0/1pp1:Front 1",
      "2sw1:Gi1/0/10pp1:Front 2",
    ])
    expect(screen.getByText("1 ticked on B without a partner")).toBeTruthy()
    const last = onPairs.mock.calls.at(-1)![0]
    expect(last.map((p) => [p.a, p.b])).toEqual([
      [
        { kind: "interface", id: "g1" },
        { kind: "front_port", id: "f1" },
      ],
      [
        { kind: "interface", id: "g10" },
        { kind: "front_port", id: "f2" },
      ],
    ])
  })

  it("shows a pair's server error on its row", async () => {
    const { rerender } = setup()
    await tickBoth()
    fireEvent.click(screen.getByRole("checkbox", { name: "Gi1/0/1" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Front 1" }))
    await screen.findByText("Pairs (1)")
    rerender([{ b: ["Front 1 is already cabled."] }])
    const row = screen.getAllByRole("row")[1]
    expect(within(row).getByText("Front 1 is already cabled.")).toBeTruthy()
  })
})
