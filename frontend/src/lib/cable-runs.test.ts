import { beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import {
  advanceEnd,
  freePorts,
  nextFreePorts,
  pairPositionally,
} from "./cable-runs"

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))

// Deliberately out of order: the API order must not decide the run.
const sw = [
  { id: "g10", name: "Gi1/0/10", cable: null },
  { id: "g1", name: "Gi1/0/1", cable: { id: "c1" } },
  { id: "g2", name: "Gi1/0/2", cable: null },
  { id: "g3", name: "Gi1/0/3", cable: { id: "c9" } },
  { id: "g4", name: "Gi1/0/4", cable: null },
]

describe("nextFreePorts", () => {
  it("offers the next free port in natural order", () => {
    expect(nextFreePorts(sw, ["g1"]).map((p) => p.id)).toEqual(["g2"])
  })

  it("skips ports that are already cabled", () => {
    expect(nextFreePorts(sw, ["g2"]).map((p) => p.id)).toEqual(["g4"])
  })

  it("orders Gi1/0/10 after Gi1/0/4, not after Gi1/0/1", () => {
    expect(nextFreePorts(sw, ["g4"]).map((p) => p.id)).toEqual(["g10"])
  })

  it("advances a multi-port end by as many ports", () => {
    expect(nextFreePorts(sw, ["g1", "g2"]).map((p) => p.id)).toEqual([
      "g4",
      "g10",
    ])
  })

  it("leaves out excluded ports and stops at the end", () => {
    expect(
      nextFreePorts(sw, ["g2"], 1, new Set(["g4"])).map((p) => p.id)
    ).toEqual(["g10"])
    expect(nextFreePorts(sw, ["g10"])).toEqual([])
    expect(nextFreePorts(sw, ["elsewhere"])).toEqual([])
  })
})

describe("freePorts", () => {
  it("lists uncabled ports in natural order", () => {
    expect(freePorts(sw).map((p) => p.name)).toEqual([
      "Gi1/0/2",
      "Gi1/0/4",
      "Gi1/0/10",
    ])
  })
})

describe("pairPositionally", () => {
  it("pairs first with first and keeps the leftovers", () => {
    const r = pairPositionally(["a1", "a2", "a3"], ["b1", "b2"])
    expect(r.pairs).toEqual([
      ["a1", "b1"],
      ["a2", "b2"],
    ])
    expect(r.leftoverA).toEqual(["a3"])
    expect(r.leftoverB).toEqual([])
  })
})

describe("advanceEnd", () => {
  beforeEach(() => {
    apiMock.mockReset()
    apiMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith("/api/interfaces/?device=sw1")
          ? { count: sw.length, results: sw }
          : {
              count: 2,
              results: [
                { id: "e1", name: "Eth1/1", cable: { id: "c1" } },
                { id: "e2", name: "Eth1/2", cable: null },
              ],
            }
      )
    )
  })

  const term = (
    id: string,
    name: string,
    device = "sw1",
    kind: Api.TerminationKind = "interface"
  ): Api.Termination => ({
    kind,
    id,
    name,
    device: { id: device, name: device },
  })

  it("moves each end on to its next free port on the same device", async () => {
    expect(await advanceEnd([term("g1", "Gi1/0/1")])).toEqual([
      { kind: "interface", id: "g2" },
    ])
    expect(await advanceEnd([term("e1", "Eth1/1", "sw2")])).toEqual([
      { kind: "interface", id: "e2" },
    ])
    expect(apiMock).toHaveBeenCalledWith(
      "/api/interfaces/?device=sw1&page_size=500"
    )
  })

  it("has no next for a circuit end or a run off the end", async () => {
    expect(
      await advanceEnd([term("t1", "Side A", "c1", "circuit_termination")])
    ).toEqual([])
    expect(await advanceEnd([term("g10", "Gi1/0/10")])).toEqual([])
  })
})
