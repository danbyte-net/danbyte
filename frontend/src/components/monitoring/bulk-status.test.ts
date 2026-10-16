import { beforeEach, describe, expect, it, vi } from "vitest"

import { batches } from "@/lib/batches"
import { fetchPrefixStatuses, STATUS_BATCH } from "./bulk-status"

// The prefix list's monitoring column asks for every prefix: over the
// server's bound per call it used to get a 400 and show nothing (#430).

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))

describe("batches", () => {
  it("splits in order and keeps the tail", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(batches([], 2)).toEqual([])
  })
})

describe("fetchPrefixStatuses", () => {
  beforeEach(() => {
    apiMock.mockReset()
  })

  it("posts at most the server's bound per call and merges the answers", async () => {
    const ids = Array.from({ length: STATUS_BATCH + 7 }, (_, i) => `p${i}`)
    apiMock.mockImplementation((_path, init) => {
      const sent = JSON.parse(String(init?.body)).prefixes as string[]
      return Promise.resolve({
        statuses: { [sent[0]]: { status: "up" } },
      })
    })
    const out = await fetchPrefixStatuses(ids)
    expect(apiMock).toHaveBeenCalledTimes(2)
    const sizes = apiMock.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)).prefixes.length
    )
    expect(sizes).toEqual([STATUS_BATCH, 7])
    expect(Object.keys(out.statuses).sort()).toEqual(
      ["p0", `p${STATUS_BATCH}`].sort()
    )
  })

  it("sends one call for a normal list", async () => {
    apiMock.mockResolvedValue({ statuses: {} })
    await fetchPrefixStatuses(["a", "b"])
    expect(apiMock).toHaveBeenCalledTimes(1)
  })
})
