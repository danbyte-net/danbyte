import { useEffect, useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DependencyConfirmResult, DependencySuggestion } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable } from "@/components/data-table"
import { DevicePicker } from "@/components/device-picker"
import { EmptyState } from "@/components/empty-state"
import { FormCheckbox, FormSelect, useFieldErrors } from "@/components/forms"
import { buildDependencyProposalColumns } from "@/components/columns/dependency-proposal-columns"
import type { ProposalRow } from "@/components/columns/dependency-proposal-columns"
import { DEVICE_DEPENDENCY_KEYS } from "@/components/device-dependencies/dependency-dialog"
import type { DeviceRef } from "@/components/device-dependencies/dependency-dialog"

// "Suggest from cables and LLDP" (#450): pick a core device, and the server
// proposes dependencies - each device depends on its neighbours one hop
// closer to the core, by cables (through patch panels) and LLDP. Nothing is
// saved until the rows ticked here are created; each goes through the
// ordinary create, so a cycle or a pair already related is refused on its
// own row and the others are saved.

const SUGGEST = "/api/device-dependencies/suggest/"
const CONFIRM = "/api/device-dependencies/suggest/confirm/"

/** A refused row's first field error ("This would make a cycle: …"). */
function firstMessage(errors: Record<string, unknown>): string {
  for (const v of Object.values(errors)) {
    const msg = Array.isArray(v) ? v[0] : v
    if (msg) return String(msg)
  }
  return "Refused."
}

const DEPTHS = ["1", "2", "3", "4", "6", "8", "12", "20"].map((v) => ({
  value: v,
  label: v,
}))

export function SuggestDependenciesDialog({
  open,
  onOpenChange,
  core: initialCore,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Opened from a device: the walk starts there. */
  core?: DeviceRef
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [core, setCore] = useState<string | null>(null)
  const [depth, setDepth] = useState("8")
  const [lldp, setLldp] = useState(true)
  const [answer, setAnswer] = useState<DependencySuggestion | null>(null)
  const [rows, setRows] = useState<ProposalRow[]>([])
  const [selected, setSelected] = useState<ProposalRow[]>([])
  const [refusals, setRefusals] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (!open) return
    setCore(initialCore?.id ?? null)
    setDepth("8")
    setLldp(true)
    setAnswer(null)
    setRows([])
    setSelected([])
    setRefusals(new Map())
    reset()
  }, [open, initialCore?.id, reset])

  const find = useMutation({
    mutationFn: () =>
      api<DependencySuggestion>(SUGGEST, {
        method: "POST",
        body: JSON.stringify({
          core_device: core,
          max_depth: Number(depth),
          use_lldp: lldp,
        }),
      }),
    onSuccess: (data) => {
      reset()
      setAnswer(data)
      setRows(data.proposals.map((p) => ({ ...p, id: p.key })))
      setSelected([])
      setRefusals(new Map())
    },
    onError: handleApiError,
  })

  const create = useMutation({
    mutationFn: (picked: ProposalRow[]) =>
      api<DependencyConfirmResult>(CONFIRM, {
        method: "POST",
        body: JSON.stringify({
          rows: picked.map((p) => ({
            upstream_id: p.upstream.id,
            downstream_id: p.downstream.id,
            medium_id: p.medium?.id ?? null,
            redundancy_group: p.redundancy_group,
          })),
        }),
      }),
    onSuccess: (data, picked) => {
      const made = new Set<string>()
      const refused = new Map(refusals)
      for (const r of data.results) {
        const key = picked[r.index].key
        if (r.ok) {
          made.add(key)
          refused.delete(key)
        } else refused.set(key, firstMessage(r.errors))
      }
      for (const queryKey of DEVICE_DEPENDENCY_KEYS)
        qc.invalidateQueries({ queryKey })
      if (data.created)
        toast.success(
          data.created === 1
            ? "Added a dependency"
            : `Added ${data.created} dependencies`
        )
      setRows((cur) => cur.filter((r) => !made.has(r.key)))
      setSelected([])
      setRefusals(refused)
      if (made.size && !refused.size && made.size === rows.length)
        onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  const columns = useMemo(
    () => buildDependencyProposalColumns({ refusals }),
    [refusals]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Suggest from cables and LLDP</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_auto_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            find.mutate()
          }}
        >
          <DevicePicker
            label="Core device"
            required
            value={core}
            onChange={setCore}
            error={fieldErrors.core_device}
          />
          <FormSelect
            label="Max hops"
            value={depth}
            onChange={(v) => setDepth(v || "8")}
            options={DEPTHS}
            error={fieldErrors.max_depth}
          />
          <FormCheckbox
            label="LLDP"
            info="Also follow LLDP neighbours that have no cable."
            checked={lldp}
            onChange={setLldp}
            className="items-center pb-2"
          />
          <Button type="submit" size="sm" disabled={!core || find.isPending}>
            {find.isPending ? "Finding…" : "Find"}
          </Button>
        </form>

        {answer && (
          <div className="grid min-h-0 gap-3">
            <p className="text-xs text-muted-foreground">
              {answer.reached} device{answer.reached === 1 ? "" : "s"} reached
              {answer.skipped_existing > 0 &&
                ` · ${answer.skipped_existing} already related`}
              {answer.truncated && ` · showing the first ${rows.length}`}
            </p>
            {rows.length === 0 ? (
              <EmptyState title="Nothing to suggest." />
            ) : (
              <div className="max-h-[55vh] overflow-auto">
                <DataTable
                  data={rows}
                  columns={columns}
                  tableId="dependency-proposals"
                  onSelectedRowsChange={setSelected}
                  selectedRows={selected}
                  embedded
                  unpaged
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
              <Button
                size="sm"
                disabled={selected.length === 0 || create.isPending}
                onClick={() => create.mutate(selected)}
              >
                {create.isPending
                  ? "Creating…"
                  : `Create selected (${selected.length})`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
