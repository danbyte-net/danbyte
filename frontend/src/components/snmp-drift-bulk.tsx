import { useState } from "react"
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import {
  ChevronDown,
  GitCompareArrows,
  ListRestart,
  RefreshCw,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  SnmpBulkAction,
  SnmpBulkRun,
  SnmpBulkStart,
  SnmpDriftRow,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { PendingLabel } from "@/components/pending-label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// Bulk Poll / Refresh MACs / Sync from SNMP on the SNMP drift page (#419).
// One request per action queues the run server-side; the page follows its
// progress in one toast and reloads the drift list when it is done.

const PATH: Record<SnmpBulkAction, string> = {
  poll: "bulk-poll",
  macs: "bulk-mac-refresh",
  sync: "bulk-sync",
}
export const LABEL: Record<SnmpBulkAction, string> = {
  poll: "Poll",
  macs: "Refresh MACs",
  sync: "Sync from SNMP",
}
const VERB: Record<SnmpBulkAction, string> = {
  poll: "Polling…",
  macs: "Refreshing…",
  sync: "Syncing…",
}
const ICON: Record<SnmpBulkAction, typeof RefreshCw> = {
  poll: RefreshCw,
  macs: ListRestart,
  sync: GitCompareArrows,
}

/** The server's per-request cap - a larger fleet goes in several runs. */
export const MAX_DEVICES = 5000

const RUN_POLL_MS = 2000
/** Past this the toast stops following; the jobs keep running. */
const RUN_GIVE_UP_MS = 30 * 60_000

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface BulkOutcome {
  start: SnmpBulkStart
  run: SnmpBulkRun | null
  timedOut?: boolean
}

/** The closing toast: a title and the details worth reading. */
export function bulkSummary({ start, run, timedOut }: BulkOutcome): {
  tone: "success" | "warning" | "info"
  title: string
  detail: string
} {
  const c = run?.counts
  const ok = c?.ok ?? 0
  const details: string[] = []
  if (c?.unreachable)
    details.push(
      start.action === "sync"
        ? `${plural(c.unreachable, "device")} without a reachable poll`
        : `${c.unreachable} unreachable`
    )
  if (c?.failed) details.push(`${c.failed} failed`)
  if (c?.busy) details.push(`${c.busy} already being read`)
  const denied = (c?.denied ?? 0) + start.skipped
  if (denied) details.push(`${denied} not permitted`)
  for (const o of start.outposts)
    details.push(
      `${plural(o.devices, "device")} queued on Outpost ${o.name}${o.stale ? " (offline)" : ""}`
    )
  if (start.action === "sync" && run?.sync) {
    const s = run.sync
    const bits = [
      s.interfaces_created && `${s.interfaces_created} interfaces added`,
      s.interfaces_updated && `${s.interfaces_updated} updated`,
      s.ips_assigned && `${s.ips_assigned} IPs assigned`,
      s.vlans_assigned && `${s.vlans_assigned} VLANs set`,
    ].filter(Boolean)
    if (bits.length) details.unshift(bits.join(", "))
    if (s.ips_skipped) details.push(`${s.ips_skipped} IPs without a prefix`)
  }
  const detail = details.join(" · ")
  if (timedOut)
    return {
      tone: "info",
      title: `${LABEL[start.action]} still running - ${run?.processed ?? 0} / ${run?.total ?? start.queued} done`,
      detail,
    }
  if (!start.run_id)
    return {
      tone: start.outposts.length ? "info" : "warning",
      title: start.outposts.length
        ? `${LABEL[start.action]} queued on ${plural(start.outposts.length, "Outpost")}`
        : "Nothing to run",
      detail,
    }
  const title =
    start.action === "poll"
      ? `Polled ${ok} of ${plural(start.queued, "device")}`
      : start.action === "macs"
        ? `MAC tables read on ${ok} of ${plural(start.queued, "device")}`
        : `Synced ${ok} of ${plural(start.queued, "device")}`
  return { tone: ok === start.queued ? "success" : "warning", title, detail }
}

/** Follow a run until it is done (or too long), reporting progress. */
export async function followRun(
  runId: string,
  onProgress: (run: SnmpBulkRun) => void,
  pollMs = RUN_POLL_MS
): Promise<{ run: SnmpBulkRun | null; timedOut: boolean }> {
  const until = Date.now() + RUN_GIVE_UP_MS
  for (;;) {
    const run = await api<SnmpBulkRun>(
      `/api/monitoring/snmp-drift/bulk-runs/${runId}/`
    )
    if (!run.found) return { run: null, timedOut: false }
    onProgress(run)
    if (run.done) return { run, timedOut: false }
    if (Date.now() > until) return { run, timedOut: true }
    await sleep(pollMs)
  }
}

const MUTATION_KEY = ["snmp-drift-bulk"]

/** Start a bulk action and follow it in one toast. Every bulk control on the
 * page shares the pending state, so only one run is driven at a time. */
export function useSnmpBulk() {
  const qc = useQueryClient()
  const running = useIsMutating({ mutationKey: MUTATION_KEY }) > 0
  const m = useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: async ({
      action,
      ids,
    }: {
      action: SnmpBulkAction
      ids: string[]
    }): Promise<BulkOutcome> => {
      const start = await api<SnmpBulkStart>(
        `/api/monitoring/snmp-drift/${PATH[action]}/`,
        { method: "POST", body: JSON.stringify({ devices: ids }) }
      )
      if (!start.run_id) return { start, run: null }
      const id = `snmp-bulk-${start.run_id}`
      toast.loading(`${VERB[action]} 0 / ${start.queued}`, { id })
      try {
        const { run, timedOut } = await followRun(start.run_id, (r) =>
          toast.loading(`${VERB[action]} ${r.processed ?? 0} / ${r.total}`, {
            id,
          })
        )
        return { start, run, timedOut }
      } finally {
        toast.dismiss(id)
      }
    },
    onSuccess: (outcome) => {
      const s = bulkSummary(outcome)
      const opts = { description: s.detail || undefined }
      if (s.tone === "success") toast.success(s.title, opts)
      else if (s.tone === "warning") toast.warning(s.title, opts)
      else toast.info(s.title, opts)
    },
    onError: (e) => apiErrorToast(e),
    onSettled: () => {
      for (const key of [
        ["snmp-drift"],
        ["snmp-drift-fleet"],
        ["device-snmp-drift"],
        ["device-snmp"],
        ["device-interfaces"],
        ["device-macs"],
        ["mac-sightings"],
      ])
        void qc.invalidateQueries({ queryKey: key })
    },
  })
  return {
    run: (action: SnmpBulkAction, ids: string[]) => m.mutate({ action, ids }),
    running: running || m.isPending,
    action: m.variables?.action,
  }
}

/** The confirm before a fleet-wide run, and before every Sync: it writes the
 * source of truth on each device it names. */
export function SnmpBulkConfirm({
  action,
  rows,
  onOpenChange,
  onConfirm,
}: {
  action: SnmpBulkAction | null
  rows: SnmpDriftRow[]
  onOpenChange: (open: boolean) => void
  onConfirm: (action: SnmpBulkAction) => void
}) {
  const sample = rows.slice(0, 6)
  const extra = rows.length - sample.length
  const over = rows.length > MAX_DEVICES
  return (
    <ConfirmDialog
      open={action !== null}
      onOpenChange={onOpenChange}
      title={
        action ? `${LABEL[action]} - ${plural(rows.length, "device")}?` : ""
      }
      description={
        action === "sync"
          ? "Adds observed interfaces, fixes MAC, status, speed and VLAN, and assigns discovered IPs. Device names are left alone."
          : action === "macs"
            ? "Reads each device's whole MAC table in the background."
            : "Polls each device in the background."
      }
      confirmLabel={action ? LABEL[action] : ""}
      pendingLabel={action ? VERB[action] : ""}
      destructive={false}
      confirmDisabled={over}
      onConfirm={() => action && onConfirm(action)}
    >
      <ul className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-3 py-2 text-xs">
        {sample.map((r) => (
          <li key={r.device} className="truncate text-foreground">
            {r.device_name}
          </li>
        ))}
        {extra > 0 && (
          <li className="text-muted-foreground">…and {extra} more</li>
        )}
      </ul>
      {over && (
        <p className="text-xs text-destructive">
          At most {MAX_DEVICES.toLocaleString()} devices at a time.
        </p>
      )}
    </ConfirmDialog>
  )
}

/** Floating bar for the selected drift rows. */
export function SnmpDriftBulkBar({
  selected,
  onCleared,
}: {
  selected: SnmpDriftRow[]
  onCleared: () => void
}) {
  const bulk = useSnmpBulk()
  const [confirm, setConfirm] = useState<SnmpBulkAction | null>(null)
  if (selected.length === 0) return null
  const ids = selected.map((r) => r.device)
  const start = (action: SnmpBulkAction) => {
    // Sync writes intent, so it always asks; reads go straight away.
    if (action === "sync") setConfirm(action)
    else bulk.run(action, ids)
  }
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium whitespace-nowrap text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          {(["poll", "macs", "sync"] as const).map((action) => {
            const Icon = ICON[action]
            return (
              <Button
                key={action}
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                disabled={bulk.running}
                onClick={() => start(action)}
              >
                <Icon className="mr-1 h-3 w-3" />
                <PendingLabel
                  label={LABEL[action]}
                  verb={VERB[action]}
                  pending={bulk.running && bulk.action === action}
                />
              </Button>
            )
          })}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onCleared}
            aria-label="Clear selection"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <SnmpBulkConfirm
        action={confirm}
        rows={selected}
        onOpenChange={(open) => !open && setConfirm(null)}
        onConfirm={(action) => {
          setConfirm(null)
          bulk.run(action, ids)
          onCleared()
        }}
      />
    </>
  )
}

/** The page-header menu that runs an action on every listed device. */
export function SnmpDriftAllMenu({ rows }: { rows: SnmpDriftRow[] }) {
  const bulk = useSnmpBulk()
  const [confirm, setConfirm] = useState<SnmpBulkAction | null>(null)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={bulk.running || rows.length === 0}
          >
            <PendingLabel
              label="All devices"
              verb={bulk.action ? VERB[bulk.action] : "Running…"}
              pending={bulk.running}
            />
            <ChevronDown className="ml-1 h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {(["poll", "macs", "sync"] as const).map((action) => {
            const Icon = ICON[action]
            return (
              <DropdownMenuItem
                key={action}
                onSelect={() => setConfirm(action)}
              >
                <Icon className="h-3.5 w-3.5" />
                {LABEL[action]}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <SnmpBulkConfirm
        action={confirm}
        rows={rows}
        onOpenChange={(open) => !open && setConfirm(null)}
        onConfirm={(action) => {
          setConfirm(null)
          bulk.run(
            action,
            rows.map((r) => r.device)
          )
        }}
      />
    </>
  )
}
