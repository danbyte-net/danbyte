import { useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowRight } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Prefix } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { ipToBigInt, parseCidr } from "@/lib/prefix-tree"
import { DataTable } from "@/components/data-table"
import { FormText } from "@/components/forms/text"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// POST /api/prefixes/<id>/renumber/ (api/renumber.py): a dry run returns
// this preview; the apply returns the same shape with applied=true.
export interface RenumberChange {
  kind: string
  id: string
  label: string
  field: string
  old: string
  new: string
}
export interface RenumberUnchanged {
  kind: string
  id: string
  label: string
  value: string
  reason: string
}
interface KindCount {
  kind: string
  label: string
  count: number
}
export interface RenumberPreview {
  prefix: { id: string; cidr: string }
  new_prefix: string
  dry_run: boolean
  applied: boolean
  counts: KindCount[]
  total: number
  truncated: boolean
  changes: RenumberChange[]
  unchanged_counts: KindCount[]
  unchanged_total: number
  unchanged: RenumberUnchanged[]
  linked: KindCount[]
}

/** Why `value` can't be the new network for `current`, or null when it can:
 * the same family and length, written as a network address, and not the
 * current one. Mirrors api/renumber.py parse_target. */
export function renumberTargetError(
  current: string,
  value: string
): string | null {
  const cur = parseCidr(current)
  const text = value.trim()
  if (!cur || !text) return null
  if (!text.includes("/")) return `Include the length, e.g. /${cur.prefixlen}.`
  const next = parseCidr(text)
  const addr = ipToBigInt(text.slice(0, text.indexOf("/")))
  if (!next || addr === null) return "Not a valid prefix."
  if (next.family !== cur.family) return `Must be IPv${cur.family}.`
  if (next.prefixlen !== cur.prefixlen) return `Must be a /${cur.prefixlen}.`
  if (addr !== next.start) return "Host bits are set."
  if (next.start === cur.start) return "That is the current network."
  return null
}

function labelOf(counts: KindCount[], kind: string): string {
  return counts.find((c) => c.kind === kind)?.label ?? kind
}

export function PrefixRenumberDialog({
  prefix,
  onOpenChange,
}: {
  prefix: Prefix
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [value, setValue] = useState("")
  const [preview, setPreview] = useState<RenumberPreview | null>(null)
  const [confirming, setConfirming] = useState(false)
  const error = renumberTargetError(prefix.cidr, value)
  const ready = !!value.trim() && !error

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<RenumberPreview>(`/api/prefixes/${prefix.id}/renumber/`, {
        method: "POST",
        body: JSON.stringify({ new_prefix: value.trim(), dry_run: dryRun }),
      }),
    onSuccess: (data) => {
      if (!data.applied) {
        setPreview(data)
        return
      }
      toast.success(`Renumbered ${data.prefix.cidr} to ${data.new_prefix}`)
      qc.invalidateQueries({ queryKey: ["prefix"] })
      qc.invalidateQueries({ queryKey: ["prefixes"] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      setConfirming(false)
      onOpenChange(false)
    },
    onError: (err) => {
      setConfirming(false)
      apiErrorToast(err)
    },
  })

  // The preview is for the value it was asked with; editing drops it.
  const current =
    preview && preview.new_prefix === value.trim() ? preview : null

  const changes = useMemo(
    () =>
      (current?.changes ?? []).map((c) => ({
        ...c,
        kind_label: labelOf(current!.counts, c.kind),
      })),
    [current]
  )
  const unchanged = useMemo(
    () =>
      (current?.unchanged ?? []).map((u) => ({
        ...u,
        kind_label: labelOf(current!.unchanged_counts, u.kind),
      })),
    [current]
  )

  const changeColumns = useMemo<
    ColumnDef<RenumberChange & { kind_label: string }, unknown>[]
  >(
    () => [
      { id: "kind_label", accessorKey: "kind_label", header: "Kind" },
      { id: "label", accessorKey: "label", header: "Object" },
      { id: "field", accessorKey: "field", header: "Field" },
      {
        id: "change",
        header: "Change",
        accessorFn: (r) => `${r.old} ${r.new}`,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 font-mono text-xs whitespace-nowrap">
            <span className="text-muted-foreground">
              {row.original.old || "-"}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span>{row.original.new}</span>
          </span>
        ),
      },
    ],
    []
  )
  const unchangedColumns = useMemo<
    ColumnDef<RenumberUnchanged & { kind_label: string }, unknown>[]
  >(
    () => [
      { id: "kind_label", accessorKey: "kind_label", header: "Kind" },
      { id: "label", accessorKey: "label", header: "Object" },
      {
        id: "value",
        accessorKey: "value",
        header: "Value",
        cell: ({ getValue }) => (
          <span className="font-mono text-xs">{String(getValue())}</span>
        ),
      },
      { id: "reason", accessorKey: "reason", header: "Reason" },
    ],
    []
  )

  const objects = current?.counts.reduce((n, c) => n + c.count, 0) ?? 0

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="4xl">
        <DialogHeader>
          <DialogTitle>Renumber {prefix.cidr}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-end gap-2">
            <div className="w-72">
              <FormText
                label="New prefix"
                value={value}
                onChange={setValue}
                placeholder={prefix.cidr}
                mono
                autoFocus
                error={error ?? undefined}
              />
            </div>
            <Button
              variant="outline"
              disabled={!ready || run.isPending}
              onClick={() => run.mutate(true)}
            >
              {run.isPending && !confirming ? "Previewing…" : "Preview"}
            </Button>
          </div>

          {current && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {current.counts.map((c) => (
                  <Badge key={c.kind} variant="secondary">
                    {c.label} {c.count}
                  </Badge>
                ))}
                {current.linked.map((c) => (
                  <Badge key={`l-${c.kind}`} variant="outline">
                    {c.label} {c.count} linked
                  </Badge>
                ))}
              </div>
              <DataTable
                data={changes}
                columns={changeColumns}
                groupBy="kind_label"
                initialColumnVisibility={{ kind_label: false }}
                total={current.total}
                tableId="prefix-renumber-changes"
                embedded
                flexColumn="label"
              />
              {current.unchanged_total > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">
                    Left unchanged ({current.unchanged_total})
                  </h3>
                  <DataTable
                    data={unchanged}
                    columns={unchangedColumns}
                    groupBy="kind_label"
                    initialColumnVisibility={{ kind_label: false }}
                    total={current.unchanged_total}
                    tableId="prefix-renumber-unchanged"
                    embedded
                    flexColumn="reason"
                  />
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!current || run.isPending}
            onClick={() => setConfirming(true)}
          >
            Renumber
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog
        open={confirming}
        onOpenChange={(o) => !run.isPending && setConfirming(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Renumber {prefix.cidr} to {current?.new_prefix}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {objects} object{objects === 1 ? "" : "s"} move in one change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={run.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={run.isPending}
              onClick={(e) => {
                e.preventDefault()
                run.mutate(false)
              }}
            >
              {run.isPending ? "Renumbering…" : "Renumber"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
