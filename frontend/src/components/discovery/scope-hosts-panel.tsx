import { useCallback, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { InventoryScopeHost } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  BatchFailure,
  batchStoppedToast,
  runBatches,
  sumOf,
} from "@/lib/bulk-batches"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"
import { useUrlTableFilters } from "@/components/table-filters"
import { buildInventoryScopeHostColumns } from "@/components/columns/inventory-columns"
import {
  EXEMPT_PER_CALL,
  setScanExempt,
  setScanExemptMany,
} from "./scan-exempt-field"

// A profile's Hosts (Addresses on a service scan) tab (#451): the scope as
// it resolves now, nothing contacted. Each row's Exempt/Include sets the
// object's "Do not scan" flag; the selection bar does it for many at once.

const SLUG: Record<InventoryScopeHost["kind"], string> = {
  device: "device",
  virtual_machine: "virtualmachine",
  ipaddress: "ipaddress",
}

const plural = (n: number) => `${n} ${n === 1 ? "host" : "hosts"}`

export function ScopeHostsPanel({ id }: { id: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const queryKey = useMemo(() => ["discovery", "profile", id, "hosts"], [id])
  const q = useQuery({
    queryKey,
    queryFn: () =>
      api<{ results: InventoryScopeHost[]; count: number; truncated: boolean }>(
        `/api/discovery/profiles/${id}/hosts/`
      ),
  })
  const canChange = useCallback(
    (h: InventoryScopeHost) =>
      h.permissions?.change ?? canDo(SLUG[h.kind], "change"),
    [canDo]
  )
  const [selected, setSelected] = useState<InventoryScopeHost[]>([])
  const exempt = useMutation({
    mutationFn: (h: InventoryScopeHost) =>
      setScanExempt(h.kind, h.id, !h.scan_exempt),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
    onError: (err) => apiErrorToast(err),
  })
  const anyChangeable = (q.data?.results ?? []).some(canChange)
  const columns = useMemo(
    () =>
      buildInventoryScopeHostColumns({
        selection: anyChangeable,
        exemptAction: (h) =>
          canChange(h) ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={exempt.isPending && exempt.variables.id === h.id}
              onClick={() => exempt.mutate(h)}
            >
              {h.scan_exempt ? "Include" : "Exempt"}
            </Button>
          ) : null,
      }),
    [canChange, exempt, anyChangeable]
  )
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const {
    rail,
    filteredRows,
    columns: wired,
  } = useUrlTableFilters(columns, rows)
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return (
      <EmptyState title="No hosts in scope">
        Add sites, prefixes, devices or VMs.
      </EmptyState>
    )
  const clear = () => setSelected([])
  return (
    <div className="flex min-w-0 overflow-hidden rounded-lg border border-border">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        {q.data?.truncated && (
          <p className="text-xs text-muted-foreground">
            Only the first 4,096 hosts are read.
          </p>
        )}
        <DataTable
          data={filteredRows}
          columns={wired}
          flexColumn="host"
          tableId="inventory-scope-hosts"
          searchable
          searchPlaceholder="Search hosts…"
          autoColumns={false}
          selectedRows={selected}
          onSelectedRowsChange={setSelected}
        />
      </div>
      <SafeBulkDeleteBar
        selected={selected}
        endpoint="/api/discovery/exempt/"
        noun={["host", "hosts"]}
        invalidate={[queryKey]}
        onCleared={clear}
        canDelete={false}
        actions={
          <ExemptActions
            selected={selected}
            canChange={canChange}
            onDone={() => {
              clear()
              qc.invalidateQueries({ queryKey })
            }}
          />
        }
      />
    </div>
  )
}

/** The bar's Exempt N / Include N: only rows the caller may change are
 * sent, and the label says "N of M" when some of the selection cannot be. */
export function ExemptActions({
  selected,
  canChange,
  onDone,
}: {
  selected: InventoryScopeHost[]
  canChange: (h: InventoryScopeHost) => boolean
  onDone: () => void
}) {
  const allowed = selected.filter(canChange)
  const n = allowed.length
  const of = n < selected.length ? ` of ${selected.length}` : ""
  const m = useMutation({
    mutationFn: async (value: boolean) => {
      const seen = new Set<string>()
      const objects = allowed
        .map((h) => ({ kind: h.kind, id: h.id }))
        .filter((o) => {
          const k = `${o.kind}:${o.id}`
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
      const answers = await runBatches(objects, EXEMPT_PER_CALL, (part) =>
        setScanExemptMany(part, value)
      )
      return sumOf(answers, (a) => a.updated.length)
    },
    onSuccess: (done, value) => {
      toast.success(`${value ? "Exempted" : "Included"} ${plural(done)}`)
      onDone()
    },
    onError: (err, value) => {
      if (!(err instanceof BatchFailure)) {
        apiErrorToast(err)
        return
      }
      const went: { updated: unknown[] }[] = err.results
      batchStoppedToast(
        `${value ? "Exempted" : "Included"} ${sumOf(went, (r) => r.updated.length)} of ${plural(n)}.`,
        err
      )
    },
  })
  const busy = m.isPending ? m.variables : undefined
  return (
    <>
      {([true, false] as const).map((value) => (
        <Button
          key={String(value)}
          size="sm"
          variant="ghost"
          className="h-7 px-2 whitespace-nowrap"
          disabled={n === 0 || m.isPending}
          onClick={() => m.mutate(value)}
        >
          {busy === value
            ? value
              ? "Exempting…"
              : "Including…"
            : `${value ? "Exempt" : "Include"} ${n}${of}`}
        </Button>
      ))}
    </>
  )
}
