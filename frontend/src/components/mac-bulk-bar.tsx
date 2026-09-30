import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { FormCheckbox } from "@/components/forms"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

// Bulk removal for the MAC list (#251). A row there is a MAC *value* gathered
// from several places, so the bar sends values and the dialog asks where to
// remove them from: the MAC objects, the interfaces that carry them, the IPs
// paired with them. A dry run fills in the counts before anything is written.

type SourceKey = "objects" | "interfaces" | "vm_interfaces" | "ips"

interface SourcePlan {
  /** The caller holds the grant this source needs. */
  permitted: boolean
  /** Rows the caller may act on - or did, once `applied`. */
  count: number
  /** Rows the caller can see but not change. */
  skipped: number
  applied: boolean
}

export interface MacBulkRemoveResult {
  dry_run: boolean
  macs: number
  sources: Record<SourceKey, SourcePlan>
}

export type MacBulkOption = "remove_objects" | "clear_interfaces" | "unpair_ips"

const OPTION_SOURCES: Record<MacBulkOption, SourceKey[]> = {
  remove_objects: ["objects"],
  clear_interfaces: ["interfaces", "vm_interfaces"],
  unpair_ips: ["ips"],
}

const DEFAULTS: Record<MacBulkOption, boolean> = {
  remove_objects: true,
  clear_interfaces: false,
  unpair_ips: false,
}

/** One option's sources added up: may the caller use it, and on how many
 * rows. */
export function optionPlan(
  res: MacBulkRemoveResult | undefined,
  option: MacBulkOption
): { permitted: boolean; count: number; skipped: number } {
  const plans = OPTION_SOURCES[option].map((k) => res?.sources[k])
  return {
    permitted: plans.some((p) => p?.permitted),
    count: plans.reduce((n, p) => n + (p?.count ?? 0), 0),
    skipped: plans.reduce((n, p) => n + (p?.skipped ?? 0), 0),
  }
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

/** The toast after a removal: what was done, per option. */
export function removalSummary(res: MacBulkRemoveResult): string {
  const s = res.sources
  const parts: string[] = []
  if (s.objects.applied)
    parts.push(`deleted ${plural(s.objects.count, "MAC object")}`)
  if (s.interfaces.applied || s.vm_interfaces.applied)
    parts.push(
      `cleared ${plural(s.interfaces.count + s.vm_interfaces.count, "interface")}`
    )
  if (s.ips.applied) parts.push(`unpaired ${plural(s.ips.count, "IP")}`)
  if (parts.length === 0) return "Nothing to remove."
  const text = parts.join(", ")
  return text.charAt(0).toUpperCase() + text.slice(1) + "."
}

export interface MacBulkBarProps {
  /** The selected MAC values, as the list shows them. */
  selected: string[]
  onCleared: () => void
}

export function MacBulkBar({ selected, onCleared }: MacBulkBarProps) {
  const [removeOpen, setRemoveOpen] = useState(false)
  if (selected.length === 0) return null

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-destructive hover:text-destructive"
            onClick={() => setRemoveOpen(true)}
          >
            <Trash2 className="mr-1 h-3 w-3" /> Remove
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onCleared}
            title="Clear selection"
            aria-label="Clear selection"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <MacBulkRemoveDialog
        values={selected}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        onDone={onCleared}
      />
    </>
  )
}

export function MacBulkRemoveDialog({
  values,
  open,
  onOpenChange,
  onDone,
}: {
  values: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [checked, setChecked] = useState(DEFAULTS)

  const post = (body: object) =>
    api<MacBulkRemoveResult>("/api/macs/bulk-remove/", {
      method: "POST",
      body: JSON.stringify({ values, ...body }),
    })

  // Counts come from the server's dry run, so they are what this user may
  // change - never a guess from the rows on screen. Re-asked on every open.
  const preview = useQuery({
    queryKey: ["macs-bulk-remove", values],
    queryFn: () => post({ dry_run: true }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  })

  const plans = {
    remove_objects: optionPlan(preview.data, "remove_objects"),
    clear_interfaces: optionPlan(preview.data, "clear_interfaces"),
    unpair_ips: optionPlan(preview.data, "unpair_ips"),
  }
  const usable = (o: MacBulkOption) => plans[o].permitted && plans[o].count > 0
  const chosen = (Object.keys(DEFAULTS) as MacBulkOption[]).filter(
    (o) => checked[o] && usable(o)
  )

  const close = (next: boolean) => {
    if (!next) setChecked(DEFAULTS)
    onOpenChange(next)
  }

  const remove = useMutation({
    mutationFn: () =>
      post({
        remove_objects: chosen.includes("remove_objects"),
        clear_interfaces: chosen.includes("clear_interfaces"),
        unpair_ips: chosen.includes("unpair_ips"),
      }),
    onSuccess: (res) => {
      toast.success(removalSummary(res))
      for (const key of [
        "macs",
        "mac",
        "interfaces",
        "interface",
        "device-interfaces",
        "vm-interfaces",
        "ips",
        "ip",
      ])
        qc.invalidateQueries({ queryKey: [key] })
      close(false)
      onDone()
    },
    onError: (err) => apiErrorToast(err),
  })

  const sample = values.slice(0, 5)
  const extra = values.length - sample.length

  const option = (o: MacBulkOption, label: string) => {
    const p = plans[o]
    return (
      <FormCheckbox
        label={<span className="whitespace-nowrap">{label}</span>}
        checked={checked[o] && usable(o)}
        onChange={(v) => setChecked((c) => ({ ...c, [o]: v }))}
        disabled={!usable(o) || remove.isPending}
        hint={
          !p.permitted
            ? "No permission"
            : p.skipped > 0
              ? `${p.skipped} outside your permissions`
              : undefined
        }
      />
    )
  }

  const objects = plans.remove_objects.count
  const ifaces = plans.clear_interfaces.count
  const ips = plans.unpair_ips.count

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={close}
      title={`Remove ${plural(values.length, "MAC")}?`}
      description="This can't be undone."
      confirmLabel="Remove"
      pendingLabel="Removing…"
      pending={remove.isPending}
      confirmDisabled={!preview.data || chosen.length === 0}
      onConfirm={() => remove.mutate()}
    >
      <ul className="rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
        {sample.map((v) => (
          <li key={v}>{v}</li>
        ))}
        {extra > 0 && (
          <li className="font-sans text-muted-foreground">…and {extra} more</li>
        )}
      </ul>
      {preview.isLoading ? (
        <Loading className="min-h-20" />
      ) : preview.isError ? (
        <QueryError error={preview.error} />
      ) : (
        <div className="flex flex-col gap-2.5">
          {option("remove_objects", `Delete ${plural(objects, "MAC object")}`)}
          {option(
            "clear_interfaces",
            `Clear from ${plural(ifaces, "interface")}`
          )}
          {option(
            "unpair_ips",
            `Unpair from ${plural(ips, "IP address", "IP addresses")}`
          )}
          <p className="text-xs text-muted-foreground">
            MACs learned by an integration return on its next sync.
          </p>
        </div>
      )}
    </ConfirmDialog>
  )
}
