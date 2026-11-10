// Browser sync for vulnerability data (#451): this browser fetches NVD,
// FIRST EPSS and OSV and hands each answer to Danbyte verbatim. Danbyte
// parses and validates it (CVSS recomputed from the vector, records kept only
// when they name the product asked for); nothing computed here is trusted.
//
// Pure logic with injected I/O so the pacing, queue and resume behaviour is
// unit-tested without a network. The NVD API key lives only in this object
// (page memory): it is sent as the `apiKey` header to the NVD host and never
// to Danbyte.

export interface SyncPlanEntry {
  product: string
  since: string | null
  until: string
  params: Record<string, string>
}

export interface SyncPlan {
  urls: { nvd: string; epss: string; osv: string }
  page_size: number
  spacing: { nvd: number; nvd_key: number; epss: number; osv: number }
  nvd_window: { requests: number; requests_key: number; seconds: number }
  epss_batch: number
  sync_epss: boolean
  osv_batch: number
  osv_post_records: number
  nvd: SyncPlanEntry[]
  osv: {
    keys: string[][]
    queries: { package: { purl: string } }[]
    unsupported: number
    to_fetch?: string[]
  }
  epss?: { batches: string[][] }
}

export interface SyncProgress {
  nvd?: Record<
    string,
    { start_index: number; total: number | null; done: boolean; error?: string }
  >
  epss?: { done?: number[]; failed?: number[] }
  osv?: { to_fetch?: number; posted?: string[]; done?: boolean }
  errors?: string[]
  resumed?: number
}

export interface BrowserRun {
  id: string
  status: "running" | "ok" | "failed" | "abandoned"
  plan: SyncPlan
  progress: SyncProgress
  error?: string
  counts?: Record<string, unknown> | null
}

export type ItemState = "waiting" | "fetching" | "done" | "failed"
export type EngineStatus = "idle" | "running" | "paused" | "done" | "failed"
export type Phase = "nvd" | "epss" | "osv" | "finish"

export interface ProductState {
  product: string
  state: ItemState
  startIndex: number
  total: number | null
  error?: string
}

export interface EngineSnapshot {
  status: EngineStatus
  phase: Phase
  message: string
  products: ProductState[]
  epss: { total: number; done: number; failed: number; state: ItemState }
  osv: { total: number; done: number; state: ItemState; skipped: boolean }
  requests: number
  etaSeconds: number | null
  run: BrowserRun | null
}

/** A Danbyte API error as `api()` throws it. */
export interface PostError {
  status: number
  body: unknown
  message: string
}

export interface EngineDeps {
  /** A request to a public service (window.fetch). */
  fetchExternal: (url: string, init: RequestInit) => Promise<Response>
  /** A POST to Danbyte (the shared `api()` helper: session + CSRF). */
  post: <T>(path: string, body?: string) => Promise<T>
  now: () => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  online: () => boolean
}

const BASE = "/api/vulnerabilities/sync/"
const RETRY_BACKOFF_MS = [30_000, 60_000]
const RETRY_STATUSES = new Set([403, 429, 500, 502, 503, 504])
const POST_RETRY_MS = 10_000
const OSV_MAX_ROUNDS = 50

export const NETWORK_MESSAGE =
  "The browser could not reach the service (offline, blocked by a proxy, or refused by the browser's cross-origin or content-security rules)."
export const KEY_MESSAGE =
  "NVD could not be reached with the API key from this browser. Clear the key to continue at the slower pace."
export const OFFLINE_MESSAGE = "This browser is offline."

class Paused extends Error {}

/** Rolling-window limiter: at most `max` requests in any `windowMs`, and at
 * least `minGapMs` between two. NVD allows 5 per 30 s without a key and 50
 * with one; FIRST and OSV get a fixed spacing. */
export class RateLimiter {
  private stamps: number[] = []
  constructor(
    readonly max: number,
    readonly windowMs: number,
    readonly minGapMs = 0
  ) {}

  /** Milliseconds until the next request may go. */
  delay(now: number): number {
    this.stamps = this.stamps.filter((t) => t > now - this.windowMs)
    let d = 0
    if (this.stamps.length >= this.max) d = this.stamps[0] + this.windowMs - now
    if (this.stamps.length) {
      const last = this.stamps[this.stamps.length - 1]
      d = Math.max(d, last + this.minGapMs - now)
    }
    return Math.max(0, d)
  }

  async take(deps: EngineDeps, signal: AbortSignal): Promise<void> {
    for (;;) {
      const d = this.delay(deps.now())
      if (d <= 0) break
      await deps.sleep(d, signal)
      if (signal.aborted) throw new Paused("")
    }
    this.stamps.push(deps.now())
  }

  /** Steady-state seconds for `n` more requests. */
  eta(n: number): number {
    if (n <= 0) return 0
    const perWindow = Math.max(1, this.max)
    const byWindow = (n / perWindow) * this.windowMs
    return Math.ceil(Math.max(byWindow, n * this.minGapMs) / 1000)
  }
}

export function nvdLimiter(plan: SyncPlan, keyed: boolean): RateLimiter {
  const w = plan.nvd_window
  // A second of margin over NVD's window, so a clock skew never trips it.
  return new RateLimiter(
    keyed ? w.requests_key : w.requests,
    (w.seconds + 1) * 1000,
    plan.spacing.nvd_key * 1000
  )
}

export function nvdUrl(
  plan: SyncPlan,
  entry: SyncPlanEntry,
  startIndex: number
): string {
  const q = new URLSearchParams(entry.params)
  q.set("resultsPerPage", String(plan.page_size))
  q.set("startIndex", String(startIndex))
  return `${plan.urls.nvd}?${q.toString()}`
}

function isPostError(e: unknown): e is PostError {
  return (
    !!e && typeof e === "object" && typeof (e as PostError).status === "number"
  )
}

function detail(e: PostError): string {
  const b = e.body as Record<string, unknown> | null
  if (b && typeof b === "object") {
    for (const v of Object.values(b)) if (typeof v === "string") return v
  }
  return e.message
}

function isRunClosed(e: PostError): boolean {
  return (
    e.status === 409 &&
    !!e.body &&
    typeof e.body === "object" &&
    "run_status" in e.body
  )
}

export class SyncEngine {
  private run: BrowserRun | null = null
  private apiKey = ""
  private listeners = new Set<(s: EngineSnapshot) => void>()
  private abort = new AbortController()
  private looping = false
  private errors: string[] = []
  private limiters: { nvd: RateLimiter; epss: RateLimiter; osv: RateLimiter }
  private snap: EngineSnapshot = {
    status: "idle",
    phase: "nvd",
    message: "",
    products: [],
    epss: { total: 0, done: 0, failed: 0, state: "waiting" },
    osv: { total: 0, done: 0, state: "waiting", skipped: false },
    requests: 0,
    etaSeconds: null,
    run: null,
  }

  constructor(private deps: EngineDeps) {
    this.limiters = {
      nvd: new RateLimiter(5, 31_000, 700),
      epss: new RateLimiter(1, 1000, 1000),
      osv: new RateLimiter(1, 200, 200),
    }
  }

  snapshot(): EngineSnapshot {
    return this.snap
  }

  subscribe(fn: (s: EngineSnapshot) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Page memory only. Changing it re-paces NVD. */
  setApiKey(key: string) {
    this.apiKey = key.trim()
    if (this.run) this.limiters.nvd = nvdLimiter(this.run.plan, !!this.apiKey)
  }

  private emit(patch: Partial<EngineSnapshot> = {}) {
    this.snap = { ...this.snap, ...patch, etaSeconds: this.eta() }
    for (const fn of this.listeners) fn(this.snap)
  }

  private eta(): number | null {
    if (!this.run) return null
    const plan = this.run.plan
    let nvd = 0
    for (const p of this.snap.products) {
      if (p.state === "done" || p.state === "failed") continue
      nvd +=
        p.total === null
          ? 1
          : Math.max(1, Math.ceil((p.total - p.startIndex) / plan.page_size))
    }
    const epss = Math.max(0, this.snap.epss.total - this.snap.epss.done)
    const osv = Math.max(0, this.snap.osv.total - this.snap.osv.done)
    return (
      this.limiters.nvd.eta(nvd) +
      this.limiters.epss.eta(epss) +
      this.limiters.osv.eta(osv)
    )
  }

  /** Take the server's run: its plan and what was already posted. */
  adopt(run: BrowserRun) {
    this.run = run
    this.limiters.nvd = nvdLimiter(run.plan, !!this.apiKey)
    this.limiters.epss = new RateLimiter(
      1,
      run.plan.spacing.epss * 1000,
      run.plan.spacing.epss * 1000
    )
    this.limiters.osv = new RateLimiter(
      1,
      run.plan.spacing.osv * 1000,
      run.plan.spacing.osv * 1000
    )
    const prog = run.progress
    const prev = new Map(this.snap.products.map((p) => [p.product, p]))
    const products = run.plan.nvd.map((e): ProductState => {
      const p = prog.nvd?.[e.product]
      const failed = prev.get(e.product)?.state === "failed"
      return {
        product: e.product,
        state: p?.done ? "done" : failed ? "failed" : "waiting",
        startIndex: p?.start_index ?? 0,
        total: p?.total ?? null,
        error: p?.done ? undefined : (prev.get(e.product)?.error ?? p?.error),
      }
    })
    const batches = run.plan.epss?.batches
    const epssDone = prog.epss?.done?.length ?? 0
    const toFetch = run.plan.osv.to_fetch
    const osvSkipped = run.plan.osv.queries.length === 0
    this.emit({
      run,
      products,
      epss: {
        total: batches?.length ?? 0,
        done: epssDone,
        failed: prog.epss?.failed?.length ?? 0,
        state:
          !run.plan.sync_epss ||
          (batches !== undefined && epssDone >= batches.length && epssDone > 0)
            ? "done"
            : "waiting",
      },
      osv: {
        total: toFetch?.length ?? 0,
        done: prog.osv?.posted?.length ?? 0,
        state: osvSkipped || prog.osv?.done ? "done" : "waiting",
        skipped: osvSkipped,
      },
      status: run.status === "running" ? this.snap.status : "idle",
    })
  }

  /** Open (or reopen) the run on the server and work until done, paused or
   * failed. Safe to call again after a pause: it resumes. */
  async start(): Promise<void> {
    if (this.looping) return
    this.looping = true
    this.abort = new AbortController()
    this.emit({ status: "running", message: "" })
    try {
      const run = await this.deps.post<BrowserRun>(
        BASE,
        JSON.stringify({ via: "browser" })
      )
      this.adopt(run)
      await this.work()
    } catch (e) {
      this.stop(e)
    } finally {
      this.looping = false
    }
  }

  pause() {
    this.abort.abort()
    if (this.snap.status === "running")
      this.emit({
        status: "paused",
        message: "",
        products: this.snap.products.map((p) =>
          p.state === "fetching" ? { ...p, state: "waiting" as const } : p
        ),
      })
  }

  /** A failed product is queued again; a paused engine picks it up on start. */
  retry(product: string) {
    this.emit({
      products: this.snap.products.map((p) =>
        p.product === product
          ? { ...p, state: "waiting" as const, error: undefined }
          : p
      ),
    })
  }

  /** Stop for good: the run is left abandoned (resumable for 20 hours). */
  async cancel(): Promise<void> {
    this.abort.abort()
    if (!this.run) return
    try {
      const run = await this.deps.post<BrowserRun>(
        `${BASE}${this.run.id}/finish/`,
        JSON.stringify({ stop: true })
      )
      this.emit({ run, status: "idle", message: "" })
    } catch (e) {
      this.stop(e)
    }
  }

  private stop(e: unknown) {
    // A product cut off mid-way waits again; it resumes from its index.
    const products = this.snap.products.map((p) =>
      p.state === "fetching" ? { ...p, state: "waiting" as const } : p
    )
    if (e instanceof Paused) {
      this.emit({ status: "paused", message: e.message, products })
      return
    }
    if (isPostError(e)) {
      this.emit({
        products,
        status: isRunClosed(e) ? "paused" : "failed",
        message: isRunClosed(e)
          ? "The run was closed on the server. Resume reopens it where it stopped."
          : detail(e),
      })
      return
    }
    this.emit({
      products,
      status: "failed",
      message: e instanceof Error ? e.message : String(e),
    })
  }

  private checkpoint() {
    if (this.abort.signal.aborted) throw new Paused("")
    if (!this.deps.online()) throw new Paused(OFFLINE_MESSAGE)
  }

  private setProduct(product: string, patch: Partial<ProductState>) {
    this.emit({
      products: this.snap.products.map((p) =>
        p.product === product ? { ...p, ...patch } : p
      ),
    })
  }

  /** A public service request, with bounded retries on 403/429/5xx. Returns
   * the body text, or null when the service kept refusing (`what` failed). */
  private async external(
    source: "nvd" | "epss" | "osv",
    url: string,
    init: RequestInit = {}
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    for (let attempt = 0; ; attempt++) {
      this.checkpoint()
      await this.limiters[source].take(this.deps, this.abort.signal)
      this.checkpoint()
      let res: Response
      try {
        res = await this.deps.fetchExternal(url, {
          ...init,
          mode: "cors",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: this.abort.signal,
        })
      } catch {
        if (this.abort.signal.aborted) throw new Paused("")
        if (!this.deps.online()) throw new Paused(OFFLINE_MESSAGE)
        throw new Paused(
          source === "nvd" && this.apiKey ? KEY_MESSAGE : NETWORK_MESSAGE
        )
      } finally {
        this.emit({ requests: this.snap.requests + 1 })
      }
      if (res.ok) return { ok: true, text: await res.text() }
      const host = new URL(url).host
      const error = `${host} answered HTTP ${res.status}`
      if (!RETRY_STATUSES.has(res.status) || attempt >= RETRY_BACKOFF_MS.length)
        return { ok: false, error }
      this.emit({ message: `${error}; trying again shortly.` })
      await this.deps.sleep(RETRY_BACKOFF_MS[attempt], this.abort.signal)
      if (this.abort.signal.aborted) throw new Paused("")
    }
  }

  /** A post to Danbyte; a 429 waits and tries again. */
  private async send<T>(path: string, body?: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.post<T>(path, body)
      } catch (e) {
        if (!isPostError(e) || e.status !== 429 || attempt >= 5) throw e
        await this.deps.sleep(POST_RETRY_MS, new AbortController().signal)
      }
    }
  }

  private async work() {
    const run = this.run!
    this.emit({ phase: "nvd" })
    await this.nvdPhase(run)
    this.emit({ phase: "epss" })
    await this.epssPhase(run)
    this.emit({ phase: "osv" })
    await this.osvPhase(run)
    this.emit({ phase: "finish" })
    const done = await this.send<BrowserRun>(
      `${BASE}${run.id}/finish/`,
      JSON.stringify({ errors: this.errors })
    )
    this.errors = []
    this.emit({
      run: done,
      status: done.status === "ok" ? "done" : "failed",
      message: done.status === "ok" ? "" : done.error || "",
    })
  }

  private async nvdPhase(run: BrowserRun) {
    for (const entry of run.plan.nvd) {
      const cur = this.snap.products.find((p) => p.product === entry.product)
      if (!cur || cur.state === "done" || cur.state === "failed") continue
      this.setProduct(entry.product, { state: "fetching", error: undefined })
      for (;;) {
        const p = this.snap.products.find((x) => x.product === entry.product)!
        if (p.total !== null && p.startIndex >= p.total) break
        const got = await this.external(
          "nvd",
          nvdUrl(run.plan, entry, p.startIndex),
          this.apiKey ? { headers: { apiKey: this.apiKey } } : {}
        )
        if (!got.ok) {
          this.fail(entry.product, `NVD ${entry.product}: ${got.error}`)
          break
        }
        const q = new URLSearchParams({
          product: entry.product,
          start_index: String(p.startIndex),
        })
        try {
          const r = await this.send<{
            start_index: number
            total: number
            done: boolean
          }>(`${BASE}${run.id}/nvd/?${q.toString()}`, got.text)
          this.setProduct(entry.product, {
            startIndex: r.start_index,
            total: r.total,
          })
          if (r.done) break
        } catch (e) {
          if (!isPostError(e) || isRunClosed(e)) throw e
          const expected = (e.body as { expected?: number } | null)?.expected
          if (e.status === 409 && typeof expected === "number") {
            this.setProduct(entry.product, { startIndex: expected })
            continue
          }
          if (e.status === 403 || e.status === 404) throw e
          this.fail(entry.product, `NVD ${entry.product}: ${detail(e)}`)
          break
        }
      }
      const p = this.snap.products.find((x) => x.product === entry.product)!
      if (p.state === "fetching")
        this.setProduct(entry.product, { state: "done" })
    }
  }

  private fail(product: string, message: string) {
    this.errors.push(message)
    this.setProduct(product, { state: "failed", error: message })
  }

  private async epssPhase(run: BrowserRun) {
    if (!run.plan.sync_epss) return
    const plan = await this.send<{ batches: string[][]; done: number[] }>(
      `${BASE}${run.id}/epss-plan/`
    )
    const done = new Set(plan.done)
    let failed = 0
    this.emit({
      epss: {
        total: plan.batches.length,
        done: done.size,
        failed,
        state: "fetching",
      },
    })
    for (let i = 0; i < plan.batches.length; i++) {
      if (done.has(i)) continue
      const ids = plan.batches[i]
      const got = await this.external(
        "epss",
        `${run.plan.urls.epss}?cve=${ids.join(",")}`
      )
      if (got.ok) {
        try {
          await this.send(`${BASE}${run.id}/epss/?batch=${i}`, got.text)
          done.add(i)
        } catch (e) {
          if (!isPostError(e) || isRunClosed(e) || e.status === 403) throw e
          failed++
          this.errors.push(`EPSS batch ${i + 1}: ${detail(e)}`)
        }
      } else {
        failed++
        this.errors.push(`EPSS batch ${i + 1}: ${got.error}`)
      }
      this.emit({
        epss: {
          total: plan.batches.length,
          done: done.size,
          failed,
          state: "fetching",
        },
      })
    }
    this.emit({
      epss: {
        total: plan.batches.length,
        done: done.size,
        failed,
        state: failed ? "failed" : "done",
      },
    })
  }

  private async osvIds(run: BrowserRun): Promise<string[]> {
    const seen: Record<string, string> = {}
    const queries = run.plan.osv.queries
    for (let i = 0; i < queries.length; i += run.plan.osv_batch) {
      let pending: object[] = queries.slice(i, i + run.plan.osv_batch)
      for (let round = 0; round < OSV_MAX_ROUNDS && pending.length; round++) {
        const got = await this.external(
          "osv",
          `${run.plan.urls.osv}/v1/querybatch`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ queries: pending }),
          }
        )
        if (!got.ok) throw new Error(`OSV query: ${got.error}`)
        const results = (
          JSON.parse(got.text) as {
            results?: ({
              vulns?: ({ id?: unknown; modified?: string } | null)[]
              next_page_token?: string
            } | null)[]
          }
        ).results
        if (!Array.isArray(results) || results.length !== pending.length)
          throw new Error("OSV answered a batch that does not fit the request.")
        const next: object[] = []
        results.forEach((r, j) => {
          for (const v of r?.vulns ?? [])
            if (typeof v?.id === "string") seen[v.id] = v.modified ?? ""
          if (typeof r?.next_page_token === "string" && r.next_page_token)
            next.push({
              ...pending[j],
              page_token: r.next_page_token,
            })
        })
        pending = next
      }
    }
    const r = await this.send<{ to_fetch: string[] }>(
      `${BASE}${run.id}/osv-ids/`,
      JSON.stringify({ vulns: seen })
    )
    return r.to_fetch
  }

  private async osvPhase(run: BrowserRun) {
    if (run.plan.osv.queries.length === 0 || this.snap.osv.state === "done")
      return
    this.emit({ osv: { ...this.snap.osv, state: "fetching" } })
    let toFetch = run.plan.osv.to_fetch
    if (!toFetch) {
      try {
        toFetch = await this.osvIds(run)
      } catch (e) {
        if (e instanceof Paused || isPostError(e)) throw e
        this.errors.push(e instanceof Error ? e.message : String(e))
        this.emit({ osv: { ...this.snap.osv, state: "failed" } })
        return
      }
      run.plan.osv.to_fetch = toFetch
    }
    const posted = new Set(run.progress.osv?.posted ?? [])
    const left = toFetch.filter((id) => !posted.has(id))
    let failed = 0
    this.emit({
      osv: { ...this.snap.osv, total: toFetch.length, done: posted.size },
    })
    const per = Math.max(1, run.plan.osv_post_records)
    for (let i = 0; i < left.length; i += per) {
      const texts: string[] = []
      for (const id of left.slice(i, i + per)) {
        const got = await this.external(
          "osv",
          `${run.plan.urls.osv}/v1/vulns/${encodeURIComponent(id)}`
        )
        if (got.ok) texts.push(got.text)
        else failed++
      }
      if (texts.length) {
        // The answers verbatim, as one JSON list.
        const r = await this.send<{ posted: number }>(
          `${BASE}${run.id}/osv/`,
          `[${texts.join(",")}]`
        )
        this.emit({ osv: { ...this.snap.osv, done: r.posted } })
      }
    }
    if (failed)
      this.errors.push(`OSV: ${failed} advisories could not be fetched.`)
    this.emit({ osv: { ...this.snap.osv, state: failed ? "failed" : "done" } })
  }
}
