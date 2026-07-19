import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Play, ScanSearch } from "lucide-react"
import { toast } from "sonner"

import { Spinner } from "@/components/ui/spinner"

import {
  api,
  type CheckRun,
  type DiscoverRun,
  type PrefixChecksResponse,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { apiErrorToast } from "@/lib/api-toast"

export type ScanResult = {
  scanned?: number
  responders?: number
  created?: number
  skipped?: string
  /** Large prefixes sweep on a worker — the response returns before results. */
  queued?: boolean
  /** Id of the background run to poll for live progress (queued path only). */
  run_id?: string
  shards?: number
  /** The prefix is served by a remote Outpost — it sweeps there, not on the core. */
  queued_on_outpost?: boolean
  engine?: { id: string; name: string }
}

export const SCAN_SKIP_MSG: Record<string, string> = {
  too_large:
    "Prefix is larger than the discovery min-prefix-length — raise it in Monitoring settings or rely on the periodic timer.",
  ipv6: "IPv6 ranges can't be ICMP-swept.",
  bad_cidr: "Couldn't parse this prefix's CIDR.",
  no_hosts: "No host addresses to scan.",
}

export function describeScan(r: ScanResult): string {
  if (r.skipped)
    return SCAN_SKIP_MSG[r.skipped] ?? `Scan skipped (${r.skipped}).`
  if (r.queued)
    return `Sweeping ${(r.scanned ?? 0).toLocaleString()} hosts in the background — new IPs will appear here as responders are found.`
  return `Scanned ${r.scanned ?? 0} hosts · ${r.responders ?? 0} responder${
    r.responders === 1 ? "" : "s"
  } · ${r.created ?? 0} new IP${r.created === 1 ? "" : "s"}.`
}

/**
 * Polls a backgrounded discovery run's progress (~1s) until it reports `done`,
 * then toasts the summary and refreshes the IP / space-map queries. `start(id)`
 * begins tracking a run; `run` is the latest snapshot while one is active.
 */
export function useDiscoveryRun(onComplete?: () => void) {
  const [runId, setRunId] = useState<string | null>(null)
  const qc = useQueryClient()
  const settled = useRef(false)
  const lastCreated = useRef(0)

  const q = useQuery({
    queryKey: ["discover-run", runId],
    queryFn: () => api<DiscoverRun>(`/api/monitoring/discover-runs/${runId}/`),
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.done ? false : 1000),
  })
  const run = q.data

  // Live: as shards create IPs, refresh the IP list / space-map so new rows
  // appear on the fly rather than only after the run finishes.
  useEffect(() => {
    const created = run?.created ?? 0
    if (created > lastCreated.current) {
      lastCreated.current = created
      qc.invalidateQueries({ queryKey: ["prefix-ips"] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      qc.invalidateQueries({ queryKey: ["prefixes"] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.created])

  useEffect(() => {
    if (!run?.done || settled.current) return
    settled.current = true
    toast.success(
      `Discovery of ${run.cidr} complete — ${run.responders} responder${run.responders === 1 ? "" : "s"} · ${run.created} new IP${run.created === 1 ? "" : "s"}.`
    )
    qc.invalidateQueries({ queryKey: ["prefix-ips"] })
    qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
    qc.invalidateQueries({ queryKey: ["prefixes"] })
    onComplete?.()
    // Hold the full bar for a beat, then clear back to the button.
    const t = setTimeout(() => {
      setRunId(null)
      settled.current = false
    }, 2500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.done])

  return {
    run: runId ? run : undefined,
    start: (id: string) => {
      settled.current = false
      lastCreated.current = 0
      setRunId(id)
    },
  }
}

/**
 * Polls a bulk Check-now run's progress (~1s) until `done`, then refreshes the
 * prefix's check statuses. `start(id)` begins tracking; `run` is the snapshot
 * while one is active.
 */
export function useCheckRun(onComplete?: () => void) {
  const [runId, setRunId] = useState<string | null>(null)
  const qc = useQueryClient()
  const settled = useRef(false)
  const lastDone = useRef(0)

  const q = useQuery({
    queryKey: ["check-run", runId],
    queryFn: () => api<CheckRun>(`/api/monitoring/check-runs/${runId}/`),
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.done ? false : 1000),
  })
  const run = q.data

  // Live: as checks complete, refresh the IP-table status dots + Monitoring tab
  // so statuses update on the fly rather than only after the run / a reload.
  const refreshStatuses = () => {
    qc.invalidateQueries({ queryKey: ["ip-mon-status"] })
    qc.invalidateQueries({ queryKey: ["prefix-mon-status"] })
    qc.invalidateQueries({ queryKey: ["prefix-checks"] })
  }
  useEffect(() => {
    const done = run?.done_count ?? 0
    if (done > lastDone.current) {
      lastDone.current = done
      refreshStatuses()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.done_count])

  useEffect(() => {
    if (!run?.done || settled.current) return
    settled.current = true
    refreshStatuses()
    onComplete?.()
    const t = setTimeout(() => {
      setRunId(null)
      settled.current = false
    }, 1200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.done])

  return {
    run: runId ? run : undefined,
    start: (id: string) => {
      settled.current = false
      lastDone.current = 0
      setRunId(id)
    },
  }
}

/** Compact inline progress pill shown while a run drains. `dense` matches the
 * shorter h-7 buttons in the floating bulk bars. */
function ProgressPill({
  percent,
  title,
  icon,
  dense,
}: {
  percent: number
  title: string
  icon: React.ReactNode
  dense?: boolean
}) {
  return (
    <div
      className={`inline-flex items-center gap-2 px-2.5 ${dense ? "h-7" : "h-8"}`}
      title={title}
    >
      {icon}
      <div
        className={`${dense ? "w-16" : "w-24"} h-1.5 overflow-hidden rounded-full bg-muted`}
      >
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="num shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {percent}%
      </span>
    </div>
  )
}

export function DiscoverProgress({
  run,
  dense,
}: {
  run: DiscoverRun
  dense?: boolean
}) {
  return (
    <ProgressPill
      dense={dense}
      percent={run.percent}
      title={`${run.hosts_done.toLocaleString()} / ${run.hosts_total.toLocaleString()} hosts · ${run.responders} responder(s) · ${run.created} new IP(s)`}
      icon={
        <ScanSearch className="h-3.5 w-3.5 shrink-0 animate-pulse text-muted-foreground" />
      }
    />
  )
}

export function CheckProgress({
  run,
  dense,
}: {
  run: CheckRun
  dense?: boolean
}) {
  return (
    <ProgressPill
      dense={dense}
      percent={run.percent}
      title={`${run.done_count} / ${run.total} checks complete`}
      icon={
        <Play className="h-3.5 w-3.5 shrink-0 animate-pulse text-muted-foreground" />
      }
    />
  )
}

/**
 * Run discovery against one prefix **now**. Small prefixes return a summary
 * inline; large ones background the sweep and a live progress bar replaces the
 * button until it completes. Used in the prefix detail header and Monitoring
 * tab.
 */
export function DiscoverNowButton({
  prefixId,
  onDone,
}: {
  prefixId: string
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const { run, start } = useDiscoveryRun(onDone)
  // Set while a remote Outpost is sweeping; `baseline` is the prefix's
  // last_discovered_at at request time — we're done when it advances.
  const [outpost, setOutpost] = useState<{
    name: string
    baseline: string | null
    since: number
  } | null>(null)

  const scan = useMutation({
    mutationFn: () =>
      api<ScanResult>(`/api/monitoring/prefixes/${prefixId}/discover/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      if (r.skipped) {
        toast.warning(describeScan(r))
        return
      }
      if (r.queued_on_outpost) {
        const cached = qc.getQueryData<PrefixChecksResponse>([
          "prefix-checks",
          prefixId,
        ])
        setOutpost({
          name: r.engine?.name ?? "Outpost",
          baseline: cached?.last_discovered_at ?? null,
          since: Date.now(),
        })
        toast.success(`Discovery requested on ${r.engine?.name ?? "Outpost"}`)
        return
      }
      toast.success(describeScan(r))
      if (r.queued && r.run_id) start(r.run_id)
      else {
        qc.invalidateQueries({ queryKey: ["prefix-ips"] })
        qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
        onDone?.()
      }
    },
    onError: (err) => apiErrorToast(err),
  })

  // Poll the prefix while the Outpost sweeps; done when it reports back.
  const poll = useQuery({
    queryKey: ["prefix-checks", prefixId],
    queryFn: () =>
      api<PrefixChecksResponse>(`/api/monitoring/prefixes/${prefixId}/checks/`),
    enabled: !!outpost,
    refetchInterval: 3000,
  })
  useEffect(() => {
    if (!outpost) return
    const lda = poll.data?.last_discovered_at ?? null
    const done = lda !== null && lda !== outpost.baseline
    if (done || Date.now() - outpost.since > 120_000) {
      setOutpost(null)
      qc.invalidateQueries({ queryKey: ["prefix-ips"] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      onDone?.()
      if (done) toast.success("Outpost discovery finished")
    }
  }, [poll.data, outpost, qc, onDone])

  if (run)
    return (
      <div className="inline-flex items-center rounded-md border border-input">
        <DiscoverProgress run={run} />
      </div>
    )
  if (outpost)
    return (
      <div className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-[13px] text-muted-foreground">
        <Spinner className="h-3.5 w-3.5" />
        Discovering on {outpost.name}…
      </div>
    )
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={scan.isPending}
      onClick={() => scan.mutate()}
      title="ICMP-sweep this prefix now and create IPs for new responders"
    >
      {scan.isPending ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        <ScanSearch className="h-3.5 w-3.5" />
      )}
      {scan.isPending ? "Scanning…" : "Discover now"}
    </Button>
  )
}

/**
 * Segmented "Check now | Discover now" group for the prefix detail header.
 * Check now re-runs the prefix's monitoring checks immediately; Discover now
 * ICMP-sweeps the subnet and creates IPs for new responders.
 */
export function PrefixScanGroup({
  prefixId,
  onDone,
}: {
  prefixId: string
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const { run, start } = useDiscoveryRun(onDone)
  const refreshChecks = () => {
    qc.invalidateQueries({ queryKey: ["prefix-checks", prefixId] })
    onDone?.()
  }
  const checkRun = useCheckRun(refreshChecks)

  const checkNow = useMutation({
    mutationFn: () =>
      api<{ targets: number; checks: number; run_id?: string }>(
        "/api/monitoring/bulk-check-now/",
        { method: "POST", body: JSON.stringify({ prefix_ids: [prefixId] }) }
      ),
    onSuccess: (res) => {
      toast.success(
        res.checks > 0
          ? `Re-running ${res.checks} check${res.checks === 1 ? "" : "s"} across ${res.targets} IP${res.targets === 1 ? "" : "s"}…`
          : "No monitoring checks on this prefix's IPs yet."
      )
      if (res.run_id) checkRun.start(res.run_id)
      else refreshChecks()
    },
    onError: (err) => apiErrorToast(err),
  })

  const discover = useMutation({
    mutationFn: () =>
      api<ScanResult>(`/api/monitoring/prefixes/${prefixId}/discover/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      if (r.skipped) {
        toast.warning(describeScan(r))
        return
      }
      toast.success(describeScan(r))
      if (r.queued && r.run_id) start(r.run_id)
      else {
        // Small prefix swept inline — refresh the IP list / map immediately.
        qc.invalidateQueries({ queryKey: ["prefix-ips"] })
        qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
        onDone?.()
      }
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <div className="inline-flex overflow-hidden rounded-md border border-input">
      {checkRun.run ? (
        <CheckProgress run={checkRun.run} />
      ) : (
        <button
          type="button"
          disabled={checkNow.isPending}
          onClick={() => checkNow.mutate()}
          className="inline-flex h-8 items-center gap-1.5 px-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          title="Re-run this prefix's monitoring checks now"
        >
          {checkNow.isPending ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {checkNow.isPending ? "Checking…" : "Check now"}
        </button>
      )}
      <span className="w-px self-stretch bg-border" />
      {run ? (
        <DiscoverProgress run={run} />
      ) : (
        <button
          type="button"
          disabled={discover.isPending}
          onClick={() => discover.mutate()}
          className="inline-flex h-8 items-center gap-1.5 px-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          title="ICMP-sweep this prefix now and create IPs for new responders"
        >
          <ScanSearch className="h-3.5 w-3.5" />
          {discover.isPending ? "Scanning…" : "Discover now"}
        </button>
      )}
    </div>
  )
}

/**
 * Compact auto-discover toggle for a single prefix — usable in the prefix
 * detail header. Reflects + flips `Prefix.auto_discover`. Periodic discovery
 * also needs the global switch on (Monitoring → Settings); the title says so.
 */
export function AutoDiscoverButton({
  prefixId,
  initial,
}: {
  prefixId: string
  initial: boolean
}) {
  const qc = useQueryClient()
  const [on, setOn] = useState(initial)
  const m = useMutation({
    mutationFn: (next: boolean) =>
      api(`/api/prefixes/${prefixId}/`, {
        method: "PATCH",
        body: JSON.stringify({ auto_discover: next }),
      }),
    onSuccess: (_d, next) => {
      toast.success(next ? "Auto-discovery enabled" : "Auto-discovery disabled")
      qc.invalidateQueries({ queryKey: ["prefix", prefixId] })
    },
    onError: (err, next) => {
      setOn(!next)
      apiErrorToast(err)
    },
  })
  return (
    <Button
      variant={on ? "default" : "outline"}
      size="sm"
      disabled={m.isPending}
      onClick={() => {
        setOn(!on)
        m.mutate(!on)
      }}
      title="Periodically ICMP-sweep this prefix and auto-create IPs for new responders (needs discovery enabled in Monitoring settings)."
    >
      {m.isPending ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        <ScanSearch className="h-3.5 w-3.5" />
      )}
      Auto-discover{on ? ": On" : ": Off"}
    </Button>
  )
}
