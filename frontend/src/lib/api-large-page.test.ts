import { afterEach, describe, expect, it, vi } from "vitest"

import { api, LARGE_PAGE_SLOTS } from "./api"

function ok(body: unknown = { results: [] }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

describe("large list pages (#452)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("keeps at most two large pages in flight; small ones never wait", async () => {
    let inFlight = 0
    let most = 0
    const release: (() => void)[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("page_size=1000")) return ok()
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise<void>((r) => release.push(r))
      inFlight--
      return ok()
    })
    vi.stubGlobal("fetch", fetchMock)

    const large = [1, 2, 3, 4].map((n) =>
      api(`/api/sites/?page=${n}&page_size=1000`)
    )
    await vi.waitFor(() => expect(release).toHaveLength(LARGE_PAGE_SLOTS))
    await api("/api/sites/?page_size=50")
    await api("/api/sites/")
    while (release.length) {
      release.shift()!()
      await new Promise((r) => setTimeout(r, 0))
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6))
    while (release.length) release.shift()!()
    await Promise.all(large)
    expect(most).toBe(LARGE_PAGE_SLOTS)
  })

  it("retries a 429 after its Retry-After", async () => {
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

    const p = api<{ count: number }>("/api/sites/?page_size=1000")
    await vi.advanceTimersByTimeAsync(1900)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect((await p).count).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not retry a 429 on a small page", async () => {
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
