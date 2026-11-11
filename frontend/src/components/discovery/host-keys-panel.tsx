import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { HostKeyAcceptResult, PendingHostKey } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { InfoTip } from "@/components/ui/info-tip"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { useUrlTableFilters } from "@/components/table-filters"
import { buildPendingHostKeyColumns } from "@/components/columns/inventory-columns"

// Host keys waiting for review (#451): keys hosts presented that nobody
// has accepted yet, so a person can check fingerprints and accept many at
// once. A key that differs from one already accepted for its host is shown
// as such and is never accepted from here.

export function HostKeysPanel({
  endpoint,
  queryKey,
}: {
  /** `/api/discovery/profiles/<id>/host-keys/` or the run's. */
  endpoint: string
  queryKey: readonly unknown[]
}) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey,
    queryFn: () => api<{ results: PendingHostKey[]; count: number }>(endpoint),
  })
  const [selected, setSelected] = useState<PendingHostKey[]>([])
  const acceptable = selected.filter((k) => k.can_accept)
  const columns = useMemo(() => buildPendingHostKeyColumns(), [])
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const {
    rail,
    filteredRows,
    columns: wired,
  } = useUrlTableFilters(columns, rows)
  const accept = useMutation({
    mutationFn: () =>
      api<HostKeyAcceptResult>("/api/discovery/host-keys/accept/", {
        method: "POST",
        body: JSON.stringify({ ids: acceptable.map((k) => k.id) }),
      }),
    onSuccess: (r) => {
      const n = r.accepted.length
      toast.success(`${n} ${n === 1 ? "key" : "keys"} accepted`)
      if (r.refused.length)
        toast.warning(`${r.refused.length} refused: differs from accepted key`)
      setSelected([])
      qc.invalidateQueries({ queryKey })
      qc.invalidateQueries({ queryKey: ["discovery"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return (
      <EmptyState title="No host keys to review">
        Keys hosts present show here after a run.
      </EmptyState>
    )
  const n = acceptable.length
  return (
    <div className="flex min-w-0 overflow-hidden rounded-lg border border-border">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={n === 0 || accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending
              ? "Accepting…"
              : `Accept ${n} ${n === 1 ? "key" : "keys"}`}
          </Button>
          <InfoTip>
            Compare each fingerprint with the host's own (ssh-keygen -lf on the
            host) before accepting. A key that differs from one already accepted
            for its host may mean the host was reinstalled - or that something
            else answers in its place - and is never accepted from this list.
          </InfoTip>
        </div>
        <DataTable
          data={filteredRows}
          columns={wired}
          flexColumn="fingerprint"
          tableId="inventory-host-keys"
          searchable
          searchPlaceholder="Search hosts…"
          autoColumns={false}
          selectedRows={selected}
          onSelectedRowsChange={setSelected}
        />
      </div>
    </div>
  )
}
