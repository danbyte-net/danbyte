import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Rack, RackSyncResponse } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"

const DIM_LABEL: Record<string, string> = {
  width: "Rail width",
  u_height: "Height (U)",
  starting_unit: "Starting unit",
  desc_units: "Descending units",
  outer_width_mm: "Outer width (mm)",
  outer_depth_mm: "Outer depth (mm)",
  max_weight: "Weight budget",
  max_weight_unit: "Budget unit",
}

const show = (v: unknown) =>
  v === null || v === ""
    ? "—"
    : typeof v === "boolean"
      ? v
        ? "yes"
        : "no"
      : String(v)

/**
 * Re-align a rack with its rack type — the rack twin of the device page's
 * sync-from-type. A type that gains a PDU (or has its dimensions corrected)
 * needs a way to reach the racks already built from it; without this the
 * model only ever applied at creation.
 *
 * Dry-run first, always: the dialog shows the drift and what would be added
 * before anything is written. Extras are reported, never deleted.
 */
export function RackSyncTypeButton({ rack }: { rack: Rack }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [preview, setPreview] = useState<RackSyncResponse | null>(null)

  const run = useMutation({
    mutationFn: (apply: boolean) =>
      api<RackSyncResponse>(`/api/racks/${rack.id}/sync-from-type/`, {
        method: "POST",
        body: JSON.stringify(apply ? { apply: true } : {}),
      }),
    onSuccess: (r) => {
      if (!r.applied) {
        setPreview(r)
        return
      }
      qc.invalidateQueries({ queryKey: ["rack", rack.id] })
      qc.invalidateQueries({ queryKey: ["rack-devices", rack.id] })
      qc.invalidateQueries({ queryKey: ["devices"] })
      const dims = r.result?.dims.length ?? 0
      const added = r.result?.accessories ?? []
      toast.success(
        added.length
          ? `Synced — added ${added.join(", ")}`
          : dims
            ? `Synced ${dims} dimension${dims === 1 ? "" : "s"}`
            : "Already in step with its type"
      )
      setPreview(null)
    },
    onError: (err) => apiErrorToast(err),
  })

  if (!rack.rack_type || !canDo("rack", "change")) return null

  const diff = preview?.diff
  const dims = Object.entries(diff?.dims ?? {})
  const add = diff?.accessories?.add ?? []
  const extra = diff?.accessories?.extra ?? []
  const inStep = dims.length === 0 && add.length === 0

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={run.isPending}
        title="Compare this rack with its type and apply the differences"
        onClick={() => run.mutate(false)}
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {run.isPending && !preview ? "Checking..." : "Sync type"}
      </Button>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Sync with {rack.rack_type.name}</DialogTitle>
          </DialogHeader>

          {inStep ? (
            <p className="text-sm text-muted-foreground">
              This rack already matches its type — nothing to apply.
            </p>
          ) : (
            <div className="grid gap-4 text-sm">
              {dims.length > 0 && (
                <div className="grid gap-1">
                  <span className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                    Dimensions to copy
                  </span>
                  {dims.map(([field, v]) => (
                    <div key={field} className="flex items-baseline gap-2">
                      <span className="min-w-40">
                        {DIM_LABEL[field] ?? field}
                      </span>
                      <span className="num text-muted-foreground line-through">
                        {show(v.rack)}
                      </span>
                      <span className="num">→ {show(v.type)}</span>
                    </div>
                  ))}
                </div>
              )}
              {add.length > 0 && (
                <div className="grid gap-1">
                  <span className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                    Accessories to add
                  </span>
                  <span className="font-mono">{add.join(", ")}</span>
                  <span className="text-[11px] text-muted-foreground">
                    Each becomes a side-mounted device named{" "}
                    <span className="font-mono">{rack.name}-&lt;label&gt;</span>
                    , with its type's components.
                  </span>
                </div>
              )}
              {extra.length > 0 && (
                <div className="grid gap-1">
                  <span className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                    Not on the type
                  </span>
                  <span className="font-mono">{extra.join(", ")}</span>
                  <span className="text-[11px] text-muted-foreground">
                    Left alone — syncing never deletes a strip. Remove them by
                    hand if they really are gone.
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPreview(null)}
              disabled={run.isPending}
            >
              {inStep ? "Close" : "Cancel"}
            </Button>
            {!inStep && (
              <Button
                size="sm"
                disabled={run.isPending}
                onClick={() => run.mutate(true)}
              >
                {run.isPending ? "Applying..." : "Apply"}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
