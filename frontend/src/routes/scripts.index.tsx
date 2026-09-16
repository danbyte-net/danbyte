import { useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Play } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, Script } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe, objCan } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { RowActions } from "@/components/row-actions"
import { buildScriptColumns } from "@/components/columns/script-columns"
import {
  ScriptCreateDialog,
  ScriptDeleteDialog,
} from "@/components/script-dialogs"
import { useTableFilters } from "@/components/table-filters"

export const Route = createFileRoute("/scripts/")({
  component: ScriptsPage,
})

function ScriptsPage() {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Script | null>(null)

  const query = useQuery({
    queryKey: ["scripts", q],
    queryFn: () =>
      api<Paginated<Script>>(
        `/api/scripts/?${new URLSearchParams(q ? { search: q } : {})}`
      ),
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])

  const runNow = useMutation({
    mutationFn: (s: Script) =>
      api<{ id: string }>(`/api/scripts/${s.id}/run/`, {
        method: "POST",
        body: JSON.stringify({ params: {} }),
      }),
    onSuccess: (run) => {
      toast.success("Run queued")
      void qc.invalidateQueries({ queryKey: ["scripts"] })
      void navigate({ to: "/scripts/runs/$runId", params: { runId: run.id } })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo(() => {
    const base = buildScriptColumns()
    return [
      ...base,
      {
        id: "actions",
        header: "",
        enableHiding: false,
        cell: ({ row }: { row: { original: Script } }) => (
          <RowActions
            editTo="/scripts/$id"
            editParams={{ id: row.original.id }}
            onDelete={
              objCan(row.original, "delete", canDo("script", "delete"))
                ? () => setDeleting(row.original)
                : undefined
            }
            extra={
              row.original.permissions?.run && row.original.enabled ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  title="Run now"
                  disabled={runNow.isPending}
                  onClick={() => runNow.mutate(row.original)}
                >
                  <Play className="h-3.5 w-3.5" />
                  <span className="sr-only">Run now</span>
                </Button>
              ) : null
            }
          />
        ),
      },
    ]
  }, [canDo, runNow])

  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wired,
  } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Scripts"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "script",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Search scripts" }}
      actions={
        canDo("script", "add") ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            New script
          </Button>
        ) : null
      }
      query={query}
    >
      {rows.length === 0 && !q ? (
        <EmptyState title="No scripts yet">
          A script is Python that reads and writes Danbyte through the API as
          you, on a button or on a schedule.
        </EmptyState>
      ) : (
        <DataTable
          data={filteredRows}
          columns={wired}
          flexColumn="description"
          tableId="scripts"
        />
      )}
      {creating && <ScriptCreateDialog onClose={() => setCreating(false)} />}
      <ScriptDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
