import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, RefreshCw } from "lucide-react"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SimpleTable } from "@/components/ui/simple-table"

interface PreviewRow {
  id: string
  name: string
  add: number
  extra: number
  interfaces_with_ips: number
}

interface Preview {
  applied: false
  totals: {
    devices: number
    changing: number
    skipped: number
    extra_with_ips: number
  }
  devices: PreviewRow[]
}

interface Run {
  id: string
  status: "queued" | "running" | "success" | "failed"
  progress: {
    done?: number
    total?: number
    changed?: number
    skipped?: number
    failed?: number
  }
  failures: { name: string; error: string }[]
  error: string
}

/** Push a type's component templates at every device built from it (#103).
 *
 * Preview first, always: the destructive half (removing components the type no
 * longer defines) cascades cabling and IP links, so the dialog counts the
 * interfaces carrying addresses before the box can be ticked. */
export function DeviceTypeSyncDialog({
  deviceTypeId,
  name,
  open,
  onOpenChange,
}: {
  deviceTypeId: string
  name: string
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const [removeExtra, setRemoveExtra] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  // Confirm before touching a fleet: this edits every device of the type at
  // once, and with `removeExtra` it deletes components and their cabling.
  const [confirming, setConfirming] = useState(false)

  const preview = useQuery({
    queryKey: ["device-type-sync-preview", deviceTypeId],
    queryFn: () =>
      api<Preview>(`/api/device-types/${deviceTypeId}/sync-devices/`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    enabled: open && !runId,
    staleTime: 0,
  })

  // Poll while the run is in flight; stop as soon as it settles.
  const run = useQuery({
    queryKey: ["device-type-sync-run", runId],
    queryFn: () =>
      api<Run>(`/api/device-types/import-runs/${runId}/`),
    enabled: !!runId,
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === "queued" || s === "running" ? 1000 : false
    },
  })

  const start = useMutation({
    mutationFn: () =>
      api<{ applied: true; run: Run }>(
        `/api/device-types/${deviceTypeId}/sync-devices/`,
        {
          method: "POST",
          body: JSON.stringify({ apply: true, remove_extra: removeExtra }),
        }
      ),
    onSuccess: (r) => {
      setRunId(r.run.id)
      // Leave the confirm step behind - the run view owns the dialog now,
      // and the destructive button must not linger looking un-pressed.
      setConfirming(false)
    },
    onError: (e) => apiErrorToast(e, "Couldn't start the sync"),
  })

  const done = run.data?.status === "success" || run.data?.status === "failed"
  if (done && run.data && !run.isFetching) {
    // Components changed under the fleet - anything counting them is stale.
    qc.invalidateQueries({ queryKey: ["device-type", deviceTypeId] })
  }

  const close = () => {
    onOpenChange(false)
    setRunId(null)
    setRemoveExtra(false)
    setConfirming(false)
  }

  const t = preview.data?.totals
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>Sync devices from {name}</DialogTitle>
          <DialogDescription>
            Adds the components this type defines to every device built from
            it. Devices already matching are left alone.
          </DialogDescription>
        </DialogHeader>

        {runId ? (
          <div className="grid gap-2 text-sm">
            <p>
              {run.data?.status === "success"
                ? "Finished."
                : run.data?.status === "failed"
                  ? "The run failed."
                  : "Syncing…"}{" "}
              <span className="num text-muted-foreground">
                {run.data?.progress?.done ?? 0} of{" "}
                {run.data?.progress?.total ?? 0}
              </span>
            </p>
            {run.data?.status === "success" && (
              <p className="text-[13px] text-muted-foreground">
                {run.data.progress.changed ?? 0} changed
                {run.data.progress.skipped
                  ? `, ${run.data.progress.skipped} skipped (no permission)`
                  : ""}
                {run.data.progress.failed
                  ? `, ${run.data.progress.failed} failed`
                  : ""}
                .
              </p>
            )}
            {run.data?.error && (
              <p className="text-[13px] text-destructive">{run.data.error}</p>
            )}
            {!!run.data?.failures?.length && (
              <ul className="max-h-32 overflow-y-auto rounded-md border border-border p-2 text-[12px]">
                {run.data.failures.map((f) => (
                  <li key={f.name}>
                    <span className="font-mono">{f.name}</span> - {f.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : confirming ? (
          <div
            className={
              "grid gap-2 rounded-md border p-3 text-sm " +
              (removeExtra
                ? "border-destructive/40 bg-destructive/5"
                : "border-amber-500/40 bg-amber-500/10 dark:border-amber-400/40 dark:bg-amber-400/10")
            }
          >
            <p className="flex items-center gap-1.5 font-medium">
              <AlertTriangle
                className={
                  "h-4 w-4 " +
                  (removeExtra
                    ? "text-destructive"
                    : "text-amber-600 dark:text-amber-300")
                }
              />
              {removeExtra
                ? "This deletes components across the fleet"
                : "This edits every device of this type"}
            </p>
            <p className="text-[13px]">
              <span className="num font-medium">{t?.changing ?? 0}</span>{" "}
              device{t?.changing === 1 ? "" : "s"} will be brought in line with{" "}
              <span className="font-medium">{name}</span>.
            </p>
            {removeExtra && (
              <p className="text-[13px]">
                Components this type no longer defines will be{" "}
                <span className="font-medium">deleted</span>, along with their
                cabling
                {t?.extra_with_ips ? (
                  <>
                    {" "}
                    and the{" "}
                    <span className="num font-medium">
                      {t.extra_with_ips}
                    </span>{" "}
                    IP assignment
                    {t.extra_with_ips === 1 ? "" : "s"} on the interfaces being
                    removed
                  </>
                ) : null}
                . This cannot be undone.
              </p>
            )}
            <p className="text-[12px] text-muted-foreground">
              It runs in the background; you can close this and come back.
            </p>
          </div>
        ) : preview.isLoading ? (
          <p className="text-sm text-muted-foreground">Checking devices…</p>
        ) : t?.changing === 0 ? (
          <p className="text-sm text-muted-foreground">
            All {t.devices} devices already match this type - nothing to sync.
          </p>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm">
              <span className="num font-medium">{t?.changing ?? 0}</span> of{" "}
              <span className="num">{t?.devices ?? 0}</span> devices would
              change
              {t?.skipped
                ? ` (${t.skipped} skipped - you can't change them)`
                : ""}
              .
            </p>
            <div className="max-h-56 overflow-y-auto">
              <SimpleTable<PreviewRow>
                columns={[
                  {
                    id: "name",
                    header: "Device",
                    flex: true,
                    cell: (d) => (
                      <span className="font-mono text-xs">{d.name}</span>
                    ),
                  },
                  {
                    id: "add",
                    header: "Adds",
                    align: "right",
                    cell: (d) => <span className="num">{d.add}</span>,
                  },
                  {
                    id: "extra",
                    header: "Extra",
                    align: "right",
                    cell: (d) => <span className="num">{d.extra}</span>,
                  },
                ]}
                data={preview.data?.devices ?? []}
                getRowKey={(d) => d.id}
              />
            </div>
            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                className="mt-0.5"
                checked={removeExtra}
                onCheckedChange={(v) => setRemoveExtra(!!v)}
              />
              <span>
                Also remove components this type no longer defines
                {t?.extra_with_ips ? (
                  <span className="text-destructive">
                    {" "}
                    - {t.extra_with_ips} of them carry IP addresses, which this
                    would drop along with their cabling
                  </span>
                ) : (
                  " - this deletes their cabling and IP links too"
                )}
                .
              </span>
            </label>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() =>
              confirming && !runId ? setConfirming(false) : close()
            }
          >
            {confirming && !runId ? "Back" : done ? "Close" : "Cancel"}
          </Button>
          {!runId && !!t?.changing && !confirming && (
            <Button onClick={() => setConfirming(true)}>
              Sync {t.changing} device{t.changing === 1 ? "" : "s"}
            </Button>
          )}
          {confirming && !runId && (
            <Button
              variant={removeExtra ? "destructive" : "default"}
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              {start.isPending
                ? "Starting…"
                : removeExtra
                  ? "Sync & remove extras"
                  : "Sync devices"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Header button that opens the dialog. */
export function SyncDevicesButton({
  deviceTypeId,
  name,
  deviceCount,
}: {
  deviceTypeId: string
  name: string
  deviceCount: number
}) {
  const [open, setOpen] = useState(false)
  if (!deviceCount) return null
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <RefreshCw className="h-3.5 w-3.5" /> Sync devices
      </Button>
      <DeviceTypeSyncDialog
        deviceTypeId={deviceTypeId}
        name={name}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  )
}
