import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { CircleStop, Pause, Play } from "lucide-react"

import { api } from "@/lib/api"
import { docsUrl } from "@/lib/docs"
import { useMe } from "@/lib/use-me"
import { SyncEngine } from "@/lib/vuln-browser-sync"
import type {
  BrowserRun,
  EngineDeps,
  EngineSnapshot,
  ItemState,
} from "@/lib/vuln-browser-sync"
import { DataTable } from "@/components/data-table"
import { FormText } from "@/components/forms"
import { Loading } from "@/components/loading"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-card"
import {
  SyncStateBadge,
  vulnSyncProductColumns,
} from "@/components/columns/vuln-sync-columns"
import {
  VULN_SETTINGS_KEY,
  useVulnSettings,
} from "@/components/vulnerabilities/use-vuln-settings"

// Browser sync (#451): this browser fetches NVD, EPSS and OSV and posts each
// answer to Danbyte, which validates and stores it. The server needs no
// internet. The NVD key typed here stays in page memory.

export const Route = createFileRoute("/settings/vulnerabilities/sync")({
  component: VulnerabilitySyncPage,
})

const DEFAULT_HOSTS = ["services.nvd.nist.gov", "api.first.org", "api.osv.dev"]

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done)
  })
}

export function browserDeps(): EngineDeps {
  return {
    fetchExternal: (url, init) => window.fetch(url, init),
    post: <T,>(path: string, body?: string) =>
      api<T>(path, { method: "POST", ...(body !== undefined ? { body } : {}) }),
    now: () => Date.now(),
    sleep: abortableSleep,
    online: () => navigator.onLine !== false,
  }
}

const STATUS_LABEL: Record<EngineSnapshot["status"], string> = {
  idle: "Ready",
  running: "Running",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
}

const STATUS_VARIANT: Record<
  EngineSnapshot["status"],
  "secondary" | "info" | "warning" | "success" | "destructive"
> = {
  idle: "secondary",
  running: "info",
  paused: "warning",
  done: "success",
  failed: "destructive",
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return ""
  if (seconds < 60) return `about ${seconds} s left`
  const m = Math.round(seconds / 60)
  return m < 60
    ? `about ${m} min left`
    : `about ${Math.round(m / 6) / 10} h left`
}

export function syncNote(running: boolean, snap: EngineSnapshot): string {
  const parts: string[] = []
  if (running)
    parts.push(
      snap.phase === "finish" ? "Finishing…" : formatEta(snap.etaSeconds)
    )
  if (snap.requests > 0)
    parts.push(`${snap.requests} request${snap.requests === 1 ? "" : "s"}`)
  return parts.filter(Boolean).join(" · ")
}

function Bar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-md bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  )
}

function PhaseRow({
  label,
  state,
  done,
  total,
  unit,
}: {
  label: string
  state: ItemState
  done: number
  total: number
  unit: string
}) {
  return (
    <div className="grid grid-cols-[5rem_1fr_auto] items-center gap-3 text-sm">
      <span className="font-medium">{label}</span>
      <Bar done={state === "done" && !total ? 1 : done} total={total || 1} />
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="num whitespace-nowrap">
          {total ? `${done} / ${total} ${unit}` : ""}
        </span>
        <SyncStateBadge state={state} />
      </span>
    </div>
  )
}

function VulnerabilitySyncPage() {
  const { canManageDeployment, isLoading } = useMe()
  const settings = useVulnSettings()
  const qc = useQueryClient()
  const engineRef = useRef<SyncEngine | null>(null)
  if (!engineRef.current) engineRef.current = new SyncEngine(browserDeps())
  const engine = engineRef.current
  const snap = useSyncExternalStore(
    (fn) => engine.subscribe(fn),
    () => engine.snapshot(),
    () => engine.snapshot()
  )
  const [key, setKey] = useState("")
  const [blocked, setBlocked] = useState<string[]>([])

  const data = settings.data
  const ready =
    !!data?.enabled && data.update_source === "browser" && canManageDeployment

  // An open or interrupted browser run is shown with its progress, so a
  // reload continues where it stopped.
  const lastRun = data?.last_run
  useEffect(() => {
    if (!ready || !lastRun || lastRun.via !== "browser") return
    if (lastRun.status === "ok") return
    let live = true
    api<BrowserRun>(`/api/vulnerabilities/sync/${lastRun.id}/`)
      .then((r) => {
        if (live && engine.snapshot().status === "idle") engine.adopt(r)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [ready, lastRun, engine])

  useEffect(() => engine.setApiKey(key), [engine, key])

  // Leaving the page pauses the run (it resumes from the server's progress).
  useEffect(() => () => engine.pause(), [engine])

  useEffect(() => {
    if (snap.status !== "running") return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [snap.status])

  const hosts = useMemo(() => {
    const urls = snap.run?.plan.urls
    if (urls) return [hostOf(urls.nvd), hostOf(urls.epss), hostOf(urls.osv)]
    return [
      data?.nvd_url ? hostOf(data.nvd_url) : DEFAULT_HOSTS[0],
      data?.epss_url ? hostOf(data.epss_url) : DEFAULT_HOSTS[1],
      data?.osv_url ? hostOf(data.osv_url) : DEFAULT_HOSTS[2],
    ]
  }, [snap.run, data])

  // A host the nginx Content-Security-Policy does not allow shows up as a
  // violation event; name it rather than leaving a bare network error.
  useEffect(() => {
    const onViolation = (e: SecurityPolicyViolationEvent) => {
      if (!e.violatedDirective.startsWith("connect-src")) return
      const host = hostOf(e.blockedURI)
      if (hosts.includes(host))
        setBlocked((b) => (b.includes(host) ? b : [...b, host]))
    }
    document.addEventListener("securitypolicyviolation", onViolation)
    return () =>
      document.removeEventListener("securitypolicyviolation", onViolation)
  }, [hosts])

  const finished = snap.status === "done" || snap.status === "failed"
  useEffect(() => {
    if (!finished) return
    qc.invalidateQueries({ queryKey: VULN_SETTINGS_KEY })
    if (snap.status === "done") toast.success("Vulnerability data updated")
  }, [finished, snap.status, qc])

  const columns = useMemo(
    () =>
      vulnSyncProductColumns({
        onRetry: (p) => engine.retry(p),
      }),
    [engine]
  )

  if (isLoading || settings.isLoading) return <Loading />
  if (!canManageDeployment)
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-mono">users.manage</span> permission
        to sync vulnerability data.
      </p>
    )
  if (!ready)
    return (
      <div className="max-w-3xl space-y-3">
        <SettingsHeader title="Browser sync" />
        <p className="text-sm text-muted-foreground">
          Turn vulnerability data on and set the update source to Browser in{" "}
          <Link to="/settings/admin" className="link">
            Settings · Admin
          </Link>{" "}
          first.
        </p>
      </div>
    )

  const running = snap.status === "running"
  const resumable =
    snap.status === "paused" ||
    (snap.status === "idle" &&
      snap.products.some((p) => p.state !== "waiting" || p.startIndex > 0))
  const productsDone = snap.products.filter((p) => p.state === "done").length
  const nvdState: ItemState = snap.products.some((p) => p.state === "failed")
    ? "failed"
    : snap.products.length && productsDone === snap.products.length
      ? "done"
      : snap.phase === "nvd" && running
        ? "fetching"
        : "waiting"

  return (
    <div className="max-w-5xl space-y-4">
      <SettingsHeader
        title="Browser sync"
        badge={
          <Badge variant={STATUS_VARIANT[snap.status]}>
            {STATUS_LABEL[snap.status]}
          </Badge>
        }
      >
        Your browser contacts {hosts.join(", ")}. The Danbyte server does not
        need internet; it checks every answer before storing it.
      </SettingsHeader>

      {blocked.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[13px]">
          The Content-Security-Policy blocks {blocked.join(", ")}. Add{" "}
          {blocked.length === 1 ? "it" : "them"} to connect-src in the nginx
          site, or use Upload or Server mode.{" "}
          <a
            className="link"
            href={docsUrl("features/vulnerabilities/#browser-mode")}
            target="_blank"
            rel="noreferrer"
          >
            Docs
          </a>
        </div>
      )}

      <SettingsCard title="Sync">
        <FormText
          label="NVD API key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={setKey}
          placeholder="Optional"
          info="Used by this browser only and never sent to Danbyte. Raises NVD's limit from 5 to 50 requests per 30 seconds; without it, about 6 seconds per page."
          disabled={running}
        />
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => engine.pause()}
            >
              <Pause />
              Pause
            </Button>
          ) : (
            <Button type="button" onClick={() => void engine.start()}>
              <Play />
              {resumable ? "Resume" : finished ? "Sync again" : "Start sync"}
            </Button>
          )}
          {(snap.status === "paused" || (resumable && !running)) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void engine.cancel()}
            >
              <CircleStop />
              Stop
            </Button>
          )}
          <span className="num text-xs text-muted-foreground">
            {syncNote(running, snap)}
          </span>
        </div>
        {snap.message && (
          <p
            className={
              "text-xs whitespace-pre-line " +
              (snap.status === "failed" || snap.status === "paused"
                ? "text-destructive"
                : "text-muted-foreground")
            }
          >
            {snap.message}
          </p>
        )}
        <div className="grid gap-2">
          <PhaseRow
            label="NVD"
            state={nvdState}
            done={productsDone}
            total={snap.products.length}
            unit="products"
          />
          {snap.run?.plan.sync_epss !== false && (
            <PhaseRow
              label="EPSS"
              state={snap.epss.state}
              done={snap.epss.done}
              total={snap.epss.total}
              unit="batches"
            />
          )}
          {!snap.osv.skipped && snap.run && (
            <PhaseRow
              label="OSV"
              state={snap.osv.state}
              done={snap.osv.done}
              total={snap.osv.total}
              unit="advisories"
            />
          )}
        </div>
      </SettingsCard>

      {snap.products.length > 0 && (
        <DataTable
          data={snap.products}
          columns={columns}
          tableId="vuln-sync-products"
          embedded
          unpaged
          flexColumn="error"
        />
      )}
      <p className="text-xs text-muted-foreground">
        KEV dates come inside the NVD records. The KEV ransomware flag and notes
        need the catalog file, imported in{" "}
        <Link to="/settings/admin" className="link">
          Settings · Admin
        </Link>
        .
      </p>
    </div>
  )
}
