import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { apiAll, LIST_CHUNK } from "./api-all"
import { APPENDED_PAGE_SIZE, withoutPageSize } from "./test-page-size"

// A paged list of `total` rows, answering like DRF's PageNumberPagination:
// an absolute `next` link that carries the query, including page_size.
function server(total: number, defaultSize = 100) {
  const requested: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    requested.push(path)
    const url = new URL(path, "http://backend:8000")
    const size = Number(url.searchParams.get("page_size") ?? defaultSize)
    const page = Number(url.searchParams.get("page") ?? 1)
    const start = (page - 1) * size
    const results = Array.from(
      { length: Math.max(0, Math.min(size, total - start)) },
      (_, i) => ({ id: start + i })
    )
    let next: string | null = null
    if (start + size < total) {
      url.searchParams.set("page", String(page + 1))
      next = url.toString()
    }
    return new Response(
      JSON.stringify({ count: total, next, previous: null, results }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  })
  vi.stubGlobal("fetch", fetchMock)
  return requested
}

describe("apiAll", () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it("walks next until the list ends, on this origin", async () => {
    const requested = server(2500)
    const page = await apiAll<{ id: number }>("/api/sites/?picker=1")
    expect(page.results).toHaveLength(2500)
    expect(page.results.map((r) => r.id)).toEqual(
      Array.from({ length: 2500 }, (_, i) => i)
    )
    expect(page.count).toBe(2500)
    expect(page.next).toBeNull()
    expect(requested).toHaveLength(3)
    // The first request names its page size; the rest follow `next` by
    // path only - never the host the server saw.
    const first = new URL(requested[0], "http://x")
    expect(first.pathname).toBe("/api/sites/")
    expect(first.searchParams.get("picker")).toBe("1")
    expect(first.searchParams.get("page_size")).toBe("1000")
    for (const r of requested) expect(r.startsWith("/api/sites/?")).toBe(true)
    expect(new URL(requested[2], "http://x").searchParams.get("page")).toBe("3")
  })

  it("stops at max and keeps the server's total", async () => {
    const requested = server(50_000)
    const page = await apiAll<{ id: number }>("/api/interfaces/")
    expect(page.results).toHaveLength(10_000)
    expect(page.count).toBe(50_000)
    expect(page.next).not.toBeNull()
    expect(requested).toHaveLength(10)
  })

  it("honours chunk and max", async () => {
    const requested = server(30)
    const page = await apiAll<{ id: number }>("/api/tags/", {
      chunk: 10,
      max: 25,
    })
    expect(page.results).toHaveLength(25)
    expect(page.next).not.toBeNull()
    expect(requested).toHaveLength(3)
  })

  it("fetches a path that names its own page_size as that one page", async () => {
    const requested = server(500)
    const page = await apiAll<{ id: number }>("/api/devices/?page_size=50")
    expect(page.results).toHaveLength(50)
    expect(requested).toEqual(["/api/devices/?page_size=50"])
  })

  it("returns a short list in one request", async () => {
    const requested = server(7)
    const page = await apiAll<{ id: number }>("/api/statuses/")
    expect(page.results).toHaveLength(7)
    expect(page.next).toBeNull()
    expect(requested).toHaveLength(1)
  })

  it("keeps the caller's query as written", async () => {
    const requested = server(3)
    await apiAll("/api/devices/?rack=r1,r2")
    expect(requested).toEqual(["/api/devices/?rack=r1,r2&page_size=1000"])
  })
})

describe("the test helper that hides the appended page size", () => {
  it("matches what apiAll appends, and nothing a caller wrote", () => {
    expect(APPENDED_PAGE_SIZE).toBe(LIST_CHUNK)
    expect(withoutPageSize("/api/sites/?page_size=1000")).toBe("/api/sites/")
    expect(withoutPageSize("/api/sites/?picker=1&page_size=1000")).toBe(
      "/api/sites/?picker=1"
    )
    expect(withoutPageSize("/api/devices/?cabinet=c1&page_size=500")).toBe(
      "/api/devices/?cabinet=c1&page_size=500"
    )
  })
})
