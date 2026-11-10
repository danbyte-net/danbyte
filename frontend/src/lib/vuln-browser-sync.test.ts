import { describe, expect, it } from "vitest"

import {
  KEY_MESSAGE,
  NETWORK_MESSAGE,
  OFFLINE_MESSAGE,
  RateLimiter,
  SyncEngine,
  nvdLimiter,
  nvdUrl,
} from "./vuln-browser-sync"
import type { BrowserRun, EngineDeps, SyncPlan } from "./vuln-browser-sync"

function plan(over: Partial<SyncPlan> = {}): SyncPlan {
  return {
    urls: {
      nvd: "https://services.nvd.nist.gov/rest/json/cves/2.0",
      epss: "https://api.first.org/data/v1/epss",
      osv: "https://api.osv.dev",
    },
    page_size: 2,
    spacing: { nvd: 6.5, nvd_key: 0.7, epss: 1, osv: 0.2 },
    nvd_window: { requests: 5, requests_key: 50, seconds: 30 },
    epss_batch: 100,
    sync_epss: false,
    osv_batch: 1000,
    osv_post_records: 25,
    nvd: [
      {
        product: "o:cisco:ios_xe",
        since: null,
        until: "2026-11-10T00:00:00.000+00:00",
        params: { virtualMatchString: "cpe:2.3:o:cisco:ios_xe" },
      },
    ],
    osv: { keys: [], queries: [], unsupported: 0 },
    ...over,
  }
}

function run(p: SyncPlan, progress = {}): BrowserRun {
  return { id: "r1", status: "running", plan: p, progress }
}

interface Posted {
  path: string
  body?: string
}

/** A fake clock, network and Danbyte. NVD answers `total` records in pages. */
function harness(opts: {
  plan?: SyncPlan
  progress?: object
  total?: number
  nvd?: (url: URL, init: RequestInit) => Promise<Response>
  post?: (path: string, body?: string) => unknown
  online?: () => boolean
}) {
  const clock = { t: 0 }
  const sleeps: number[] = []
  const fetched: { url: string; init: RequestInit; at: number }[] = []
  const posted: Posted[] = []
  const p = opts.plan ?? plan()
  const total = opts.total ?? 3
  // The server's side of the run: what was posted, as a resume reads it.
  const server = JSON.parse(JSON.stringify(opts.progress ?? {})) as {
    nvd?: Record<string, object>
  }
  const deps: EngineDeps = {
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock.t += ms
    },
    online: opts.online ?? (() => true),
    fetchExternal: async (url, init) => {
      fetched.push({ url, init, at: clock.t })
      const u = new URL(url)
      if (opts.nvd) return opts.nvd(u, init)
      const start = Number(u.searchParams.get("startIndex"))
      return new Response(
        JSON.stringify({ startIndex: start, totalResults: total })
      )
    },
    post: async <T>(path: string, body?: string): Promise<T> => {
      posted.push({ path, body })
      if (opts.post) {
        const r = opts.post(path, body)
        if (r !== undefined) return r as T
      }
      if (path.endsWith("/sync/"))
        return run(p, JSON.parse(JSON.stringify(server))) as unknown as T
      if (path.includes("/nvd/")) {
        const page = JSON.parse(body!)
        const next = Math.min(page.startIndex + p.page_size, page.totalResults)
        const product = new URL(path, "http://h").searchParams.get("product")!
        server.nvd = {
          ...server.nvd,
          [product]: {
            start_index: next,
            total: page.totalResults,
            done: next >= page.totalResults,
          },
        }
        return {
          start_index: next,
          total: page.totalResults,
          done: next >= page.totalResults,
        } as T
      }
      if (path.endsWith("/finish/"))
        return { ...run(p), status: "ok" } as unknown as T
      return {} as T
    },
  }
  return { deps, clock, sleeps, fetched, posted, engine: new SyncEngine(deps) }
}

describe("RateLimiter", () => {
  it("lets five through, then waits for the window", () => {
    const l = new RateLimiter(5, 31_000, 700)
    const stamps: number[] = []
    let t = 0
    for (let i = 0; i < 6; i++) {
      t += l.delay(t)
      stamps.push(t)
      ;(l as unknown as { stamps: number[] }).stamps.push(t)
    }
    expect(stamps.slice(0, 5)).toEqual([0, 700, 1400, 2100, 2800])
    expect(stamps[5]).toBe(31_000)
  })

  it("paces by key presence", () => {
    const p = plan()
    expect(nvdLimiter(p, false).max).toBe(5)
    expect(nvdLimiter(p, true).max).toBe(50)
    expect(nvdLimiter(p, true).eta(100)).toBe(70)
  })
})

describe("nvdUrl", () => {
  it("adds paging to the planned query", () => {
    const p = plan()
    const url = new URL(nvdUrl(p, p.nvd[0], 4))
    expect(url.host).toBe("services.nvd.nist.gov")
    expect(url.searchParams.get("virtualMatchString")).toBe(
      "cpe:2.3:o:cisco:ios_xe"
    )
    expect(url.searchParams.get("startIndex")).toBe("4")
    expect(url.searchParams.get("resultsPerPage")).toBe("2")
  })
})

describe("SyncEngine", () => {
  it("pages a product, posts each page verbatim, then finishes", async () => {
    const h = harness({ total: 3 })
    await h.engine.start()
    const nvdPosts = h.posted.filter((x) => x.path.includes("/nvd/"))
    expect(nvdPosts.map((x) => new URL(x.path, "http://h").search)).toEqual([
      "?product=o%3Acisco%3Aios_xe&start_index=0",
      "?product=o%3Acisco%3Aios_xe&start_index=2",
    ])
    // The body is exactly what NVD answered.
    expect(nvdPosts[0].body).toBe(
      JSON.stringify({ startIndex: 0, totalResults: 3 })
    )
    expect(h.posted.at(-1)!.path).toBe("/api/vulnerabilities/sync/r1/finish/")
    const s = h.engine.snapshot()
    expect(s.status).toBe("done")
    expect(s.products[0].state).toBe("done")
  })

  it("waits out NVD's window after five requests without a key", async () => {
    const h = harness({ total: 14 })
    await h.engine.start()
    const at = h.fetched.map((f) => f.at)
    expect(at).toHaveLength(7)
    expect(at[4] - at[0]).toBeLessThan(31_000)
    expect(at[5] - at[0]).toBeGreaterThanOrEqual(31_000)
  })

  it("sends the key to NVD only, never to Danbyte", async () => {
    const h = harness({ total: 3 })
    h.engine.setApiKey("secret-key")
    await h.engine.start()
    for (const f of h.fetched)
      expect(new Headers(f.init.headers).get("apiKey")).toBe("secret-key")
    for (const f of h.fetched) expect(f.init.credentials).toBe("omit")
    expect(JSON.stringify(h.posted)).not.toContain("secret-key")
  })

  it("resumes from the server's progress", async () => {
    const h = harness({
      total: 5,
      progress: {
        nvd: { "o:cisco:ios_xe": { start_index: 4, total: 5, done: false } },
      },
    })
    await h.engine.start()
    expect(h.fetched).toHaveLength(1)
    expect(new URL(h.fetched[0].url).searchParams.get("startIndex")).toBe("4")
  })

  it("skips a finished product", async () => {
    const h = harness({
      progress: {
        nvd: { "o:cisco:ios_xe": { start_index: 3, total: 3, done: true } },
      },
    })
    await h.engine.start()
    expect(h.fetched).toHaveLength(0)
    expect(h.engine.snapshot().status).toBe("done")
  })

  it("follows the server's expected start_index", async () => {
    let first = true
    const h = harness({
      total: 4,
      post: (path) => {
        if (path.includes("/nvd/") && first) {
          first = false
          throw { status: 409, body: { expected: 2 }, message: "409" }
        }
        return undefined
      },
    })
    await h.engine.start()
    const starts = h.fetched.map((f) =>
      new URL(f.url).searchParams.get("startIndex")
    )
    expect(starts).toEqual(["0", "2"])
  })

  it("pauses on a network or CORS error and never loops", async () => {
    const h = harness({
      nvd: async () => {
        throw new TypeError("Failed to fetch")
      },
    })
    await h.engine.start()
    expect(h.fetched).toHaveLength(1)
    const s = h.engine.snapshot()
    expect(s.status).toBe("paused")
    expect(s.message).toBe(NETWORK_MESSAGE)
    expect(h.posted.some((x) => x.path.endsWith("/finish/"))).toBe(false)
  })

  it("says so when the key is what NVD refuses", async () => {
    const h = harness({
      nvd: async () => {
        throw new TypeError("Failed to fetch")
      },
    })
    h.engine.setApiKey("k")
    await h.engine.start()
    expect(h.engine.snapshot().message).toBe(KEY_MESSAGE)
  })

  it("pauses while offline", async () => {
    const h = harness({ online: () => false })
    await h.engine.start()
    expect(h.fetched).toHaveLength(0)
    expect(h.engine.snapshot().message).toBe(OFFLINE_MESSAGE)
  })

  it("backs off on 503, then marks the product failed and goes on", async () => {
    const h = harness({
      nvd: async () => new Response("busy", { status: 503 }),
    })
    await h.engine.start()
    expect(h.fetched).toHaveLength(3)
    expect(h.sleeps).toContain(30_000)
    expect(h.sleeps).toContain(60_000)
    const s = h.engine.snapshot()
    expect(s.products[0].state).toBe("failed")
    const finish = h.posted.find((x) => x.path.endsWith("/finish/"))!
    expect(JSON.parse(finish.body!).errors[0]).toContain("HTTP 503")
  })

  it("pause stops before the next request; start resumes", async () => {
    let engine: SyncEngine | null = null
    let calls = 0
    const h = harness({
      total: 6,
      nvd: async (u) => {
        calls++
        if (calls === 2) engine!.pause()
        const start = Number(u.searchParams.get("startIndex"))
        return new Response(
          JSON.stringify({ startIndex: start, totalResults: 6 })
        )
      },
    })
    engine = h.engine
    await h.engine.start()
    expect(h.engine.snapshot().status).toBe("paused")
    expect(h.engine.snapshot().products[0].state).toBe("waiting")
    const before = h.fetched.length
    expect(before).toBe(2)
    await h.engine.start()
    expect(h.engine.snapshot().status).toBe("done")
    expect(h.fetched.length).toBe(3)
  })

  it("fetches EPSS in planned batches and posts each answer", async () => {
    const p = plan({ sync_epss: true })
    const h = harness({
      plan: p,
      progress: {
        nvd: { "o:cisco:ios_xe": { start_index: 1, total: 1, done: true } },
      },
      nvd: async () => new Response('{"data":[]}'),
      post: (path) =>
        path.endsWith("/epss-plan/")
          ? { batches: [["CVE-2023-20198"], ["CVE-2024-10979"]], done: [0] }
          : undefined,
    })
    await h.engine.start()
    expect(h.fetched.map((f) => f.url)).toEqual([
      "https://api.first.org/data/v1/epss?cve=CVE-2024-10979",
    ])
    expect(
      h.posted.some(
        (x) => x.path === "/api/vulnerabilities/sync/r1/epss/?batch=1"
      )
    ).toBe(true)
    expect(h.engine.snapshot().epss).toMatchObject({ total: 2, done: 2 })
  })

  it("queries OSV, posts the ids, then the records as one list", async () => {
    const p = plan({
      nvd: [],
      osv: {
        keys: [["purl", "", "pypi", "django"]],
        queries: [{ package: { purl: "pkg:pypi/django" } }],
        unsupported: 0,
      },
    })
    const h = harness({
      plan: p,
      nvd: async (u) =>
        u.pathname === "/v1/querybatch"
          ? new Response(
              JSON.stringify({
                results: [{ vulns: [{ id: "GHSA-1", modified: "2026" }] }],
              })
            )
          : new Response('{"id":"GHSA-1"}'),
      post: (path) =>
        path.endsWith("/osv-ids/")
          ? { to_fetch: ["GHSA-1"] }
          : path.endsWith("/osv/")
            ? { posted: 1 }
            : undefined,
    })
    await h.engine.start()
    const ids = h.posted.find((x) => x.path.endsWith("/osv-ids/"))!
    expect(JSON.parse(ids.body!)).toEqual({ vulns: { "GHSA-1": "2026" } })
    const recs = h.posted.find((x) => x.path.endsWith("/osv/"))!
    expect(recs.body).toBe('[{"id":"GHSA-1"}]')
    expect(h.engine.snapshot().osv).toMatchObject({ done: 1, state: "done" })
  })

  it("a closed run pauses with a resume hint", async () => {
    const h = harness({
      post: (path) => {
        if (path.includes("/nvd/"))
          throw {
            status: 409,
            body: { detail: "closed", run_status: "abandoned" },
            message: "409",
          }
        return undefined
      },
    })
    await h.engine.start()
    expect(h.engine.snapshot().status).toBe("paused")
    expect(h.engine.snapshot().message).toContain("Resume")
  })
})
