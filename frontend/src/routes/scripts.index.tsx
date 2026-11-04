import { useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Play } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { Script } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe, objCan } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { BulkFlagActions } from "@/components/bulk-flag-actions"
import { buildScriptColumns } from "@/components/columns/script-columns"
import {
  ScriptCreateDialog,
  ScriptDeleteDialog,
} from "@/components/script-dialogs"
import { useUrlTableFilters } from "@/components/table-filters"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/scripts/")({
  component: ScriptsPage,
})

const ENDPOINT = "/api/scripts/"
const NOUN: [string, string] = ["script", "scripts"]

function ScriptsPage() {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [q, setQ] = useUrlSearch()
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Script | null>(null)

  const query = useQuery({
    queryKey: ["scripts", q],
    queryFn: () =>
      apiAll<Script>(
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

  const canEdit = canDo("script", "change")
  const canDelete = canDo("script", "delete")
  const selectable = canEdit || canDelete
  const [selected, setSelected] = useState<Script[]>([])
  const clear = () => setSelected([])
  const runScript = runNow.mutate
  const running = runNow.isPending
  const columns = useMemo(
    () =>
      buildScriptColumns({
        selection: selectable,
        actions: {
          editTo: "/scripts/$id",
          editParams: (s) => ({ id: s.id }),
          onDelete: setDeleting,
          canDelete: (s) => objCan(s, "delete", canDelete),
          extra: (s) =>
            s.permissions?.run && s.enabled ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                title="Run now"
                disabled={running}
                onClick={() => runScript(s)}
              >
                <Play className="h-3.5 w-3.5" />
                <span className="sr-only">Run now</span>
              </Button>
            ) : null,
        },
      }),
    [canDelete, selectable, runScript, running]
  )

  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wired,
  } = useUrlTableFilters(columns, rows)

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
          onSelectedRowsChange={selectable ? setSelected : undefined}
          selectedRows={selectable ? selected : undefined}
        />
      )}
      <SafeBulkEditBar
        selected={selected}
        endpoint={ENDPOINT}
        noun={NOUN}
        invalidate={[["scripts"]]}
        onCleared={clear}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="script"
        actions={
          canEdit && (
            <BulkFlagActions
              endpoint={ENDPOINT}
              field="enabled"
              ids={selected.map((s) => s.id)}
              noun={NOUN}
              invalidate={[["scripts"]]}
              onDone={clear}
            />
          )
        }
      />
      {creating && <ScriptCreateDialog onClose={() => setCreating(false)} />}
      <ScriptDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
