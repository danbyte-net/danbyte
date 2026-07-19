import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ArrowRight, Minus, Plus } from "lucide-react"
import { toast } from "sonner"

import { api, type DeviceSyncResponse } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCheckbox } from "@/components/forms"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

/** Human labels for the component-kind keys the diff comes back with. */
const KIND_LABELS: Record<string, string> = {
  interfaces: "Interfaces",
  console_ports: "Console ports",
  console_server_ports: "Console server ports",
  power_ports: "Power ports",
  power_outlets: "Power outlets",
  rear_ports: "Rear ports",
  front_ports: "Front ports",
  aux_ports: "Aux ports",
  inventory_items: "Inventory",
  device_bays: "Device bays",
  module_bays: "Module bays",
  services: "Services",
}

export function DeviceSyncTypeDialog({
  deviceId,
  deviceName,
  deviceTypeName,
  open,
  onOpenChange,
}: {
  deviceId: string
  deviceName: string
  deviceTypeName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [removeExtra, setRemoveExtra] = useState(false)

  // Preview (dry-run) whenever the dialog is open — never mutates.
  const preview = useQuery({
    queryKey: ["device-sync-preview", deviceId],
    enabled: open,
    gcTime: 0,
    staleTime: 0,
    queryFn: () =>
      api<DeviceSyncResponse>(`/api/devices/${deviceId}/sync-from-type/`, {
        method: "POST",
        body: JSON.stringify({ apply: false }),
      }),
  })

  const apply = useMutation({
    mutationFn: () =>
      api<DeviceSyncResponse>(`/api/devices/${deviceId}/sync-from-type/`, {
        method: "POST",
        body: JSON.stringify({ apply: true, remove_extra: removeExtra }),
      }),
    onSuccess: (data) => {
      const added = Object.values(data.result?.added ?? {}).reduce(
        (a, b) => a + b,
        0
      )
      const removed = Object.values(data.result?.removed ?? {}).reduce(
        (a, b) => a + b,
        0
      )
      toast.success(
        `Synced ${deviceName}: +${added} added` +
          (removed ? `, −${removed} removed` : "")
      )
      // A structural change — refetch everything on the page.
      qc.invalidateQueries()
      onOpenChange(false)
      setRemoveExtra(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  const diff = preview.data?.diff ?? {}
  const kinds = Object.keys(diff)
  const totalAdd = kinds.reduce((n, k) => n + diff[k].add.length, 0)
  const totalExtra = kinds.reduce((n, k) => n + diff[k].extra.length, 0)
  const risk = preview.data?.risk.interfaces_with_ips ?? 0
  const inSync = !preview.isLoading && !preview.isError && kinds.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sync from device type</DialogTitle>
          <DialogDescription>
            Re-apply{" "}
            <span className="font-medium text-foreground">
              {deviceTypeName}
            </span>
            ’s component templates to{" "}
            <span className="font-mono text-foreground">{deviceName}</span>.
            Adding is safe; removing deletes components (and their cabling / IP
            links). Review the changes below before applying.
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading ? (
          <p className="text-sm text-muted-foreground">Computing changes…</p>
        ) : preview.isError ? (
          <QueryError error={preview.error} />
        ) : inSync ? (
          <p className="text-sm text-muted-foreground">
            This device already matches its type — nothing to sync.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-4 text-sm">
              <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <Plus className="h-3.5 w-3.5" />
                {totalAdd} to add
              </span>
              <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <Minus className="h-3.5 w-3.5" />
                {totalExtra} not in type
              </span>
            </div>

            <div className="divide-y divide-border rounded-md border border-border">
              {kinds.map((k) => (
                <div key={k} className="px-3 py-2 text-[13px]">
                  <div className="mb-1 font-medium">{KIND_LABELS[k] ?? k}</div>
                  {diff[k].add.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Plus className="h-3 w-3 shrink-0 text-emerald-500" />
                      {diff[k].add.map((n) => (
                        <span
                          key={n}
                          className="rounded-sm bg-emerald-50 px-1.5 py-0.5 font-mono text-[11px] text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                  )}
                  {diff[k].extra.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Minus className="h-3 w-3 shrink-0 text-amber-500" />
                      {diff[k].extra.map((n) => (
                        <span
                          key={n}
                          className={
                            "rounded-sm px-1.5 py-0.5 font-mono text-[11px] " +
                            (removeExtra
                              ? "bg-red-50 text-red-700 line-through dark:bg-red-950 dark:text-red-300"
                              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
                          }
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {totalExtra > 0 && (
              <div className="space-y-2">
                <FormCheckbox
                  label={`Also remove the ${totalExtra} component${totalExtra === 1 ? "" : "s"} not defined by the type`}
                  checked={removeExtra}
                  onChange={setRemoveExtra}
                  hint="Destructive — deletes these components and cascades their cabling / IP assignments"
                />
                {removeExtra && risk > 0 && (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {risk} interface{risk === 1 ? "" : "s"} being removed{" "}
                      {risk === 1 ? "has" : "have"} assigned IP
                      {risk === 1 ? "" : "s"}. Those assignments will be
                      deleted.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={apply.isPending}
          >
            Cancel
          </Button>
          <Button
            variant={removeExtra ? "destructive" : "default"}
            disabled={apply.isPending || inSync || preview.isLoading}
            onClick={() => apply.mutate()}
          >
            {apply.isPending ? (
              "Syncing…"
            ) : (
              <>
                {removeExtra ? "Sync & remove extras" : "Sync device"}
                <ArrowRight className="h-3.5 w-3.5" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
