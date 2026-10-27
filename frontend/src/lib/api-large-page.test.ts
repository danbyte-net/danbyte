import { afterEach, describe, expect, it, vi } from "vitest"

import { api, LARGE_PAGE_SLOTS } from "./api"

function ok(body: unknown = { results: [] }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

// A fetch that holds every request whose URL contains `held` until released.
function holdingFetch(held: string) {
  const state = { inFlight: 0, most: 0, release: [] as (() => void)[] }
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).includes(held)) return ok()
    state.inFlight++
    state.most = Math.max(state.most, state.inFlight)
    await new Promise<void>((r) => state.release.push(r))
    state.inFlight--
    return ok()
  })
  vi.stubGlobal("fetch", fetchMock)
  return { state, fetchMock }
}

describe("large list pages (#452)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("never queues reads of 1,000 rows", async () => {
    const { state } = holdingFetch("page_size=1000")
    const reads = [1, 2, 3, 4].map((n) =>
      api(`/api/sites/?page=${n}&page_size=1000`)
    )
    await vi.waitFor(() => expect(state.release).toHaveLength(4))
    expect(state.most).toBe(4)
    while (state.release.length) state.release.shift()!()
    await Promise.all(reads)
  })

  it("keeps at most two reads above 1,000 rows in flight", async () => {
    const { state, fetchMock } = holdingFetch("page_size=2000")
    const large = [1, 2, 3, 4].map((n) =>
      api(`/api/sites/?page=${n}&page_size=2000`)
    )
    await vi.waitFor(() => expect(state.release).toHaveLength(LARGE_PAGE_SLOTS))
    // Smaller reads pass the queue.
    await api("/api/sites/?page_size=1000")
    await api("/api/sites/")
    while (state.release.length) {
      state.release.shift()!()
      await new Promise((r) => setTimeout(r, 0))
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6))
    while (state.release.length) state.release.shift()!()
    await Promise.all(large)
    expect(state.most).toBe(LARGE_PAGE_SLOTS)
  })

  it("retries any read answered 429 after its Retry-After", async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "busy" }), {
          status: 429,
          headers: { "Retry-After": "2" },
        })
      )
      .mockResolvedValueOnce(ok({ count: 1, results: [{ id: 1 }] }))
    vi.stubGlobal("fetch", fetchMock)

    const p = api<{ count: number }>("/api/sites/?page_size=50")
    await vi.advanceTimersByTimeAsync(1900)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect((await p).count).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not retry a 429 without Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: "slow down" }), { status: 429 })
      )
    vi.stubGlobal("fetch", fetchMock)
    await expect(api("/api/sites/?page_size=10")).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
