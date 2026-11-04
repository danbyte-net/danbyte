import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { Wand2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import type { AutomationTarget } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { useMe } from "@/lib/use-me"
import { ListPageShell } from "@/components/list-page-shell"
import { buildAutomationTargetColumns } from "@/components/columns/automation-target-columns"
import { AutomationTargetDeleteDialog } from "@/components/automation-target-delete-dialog"
import { AutomationExplainer } from "@/components/automation-explainer"
import { AutomationTargetTestButton } from "@/components/automation-target-test-button"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { BulkFlagActions } from "@/components/bulk-flag-actions"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/automation-targets/")({
  component: AutomationTargetsPage,
})

const ENDPOINT = "/api/automation-targets/"
const NOUN: [string, string] = ["target", "targets"]

function AutomationTargetsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("automationtarget", "add")
  const canEdit = canDo("automationtarget", "change")
  const canDelete = canDo("automationtarget", "delete")
  const selectable = canEdit || canDelete
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<AutomationTarget | null>(null)
  const [selected, setSelected] = useState<AutomationTarget[]>([])

  const query = useQuery({
    queryKey: ["automation-targets", q],
    queryFn: () =>
      apiAll<AutomationTarget>(
        `${ENDPOINT}?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((t: AutomationTarget) => setDeleting(t), [])
  const columns = useMemo(
    () =>
      buildAutomationTargetColumns({
        selection: selectable,
        actions: {
          editTo: "/automation-targets/$id/edit",
          editParams: (t) => ({ id: t.id }),
          canEdit: () => canEdit,
          onDelete,
          canDelete: () => canDelete,
          extra: (t) => <AutomationTargetTestButton target={t} />,
        },
      }),
    [onDelete, canEdit, canDelete, selectable]
  )
  const clear = () => setSelected([])

  return (
    <ListPageShell
      title="Automation targets"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter targets…",
      }}
      actions={
        <>
          <TableActions ioType="automationtarget" />
          <Button variant="outline" size="sm" asChild>
            <Link to="/automation-targets/setup">
              <Wand2 className="size-3.5" />
              Guided setup
            </Link>
          </Button>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/automation-targets/new">Add target</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <div className="space-y-4">
        <AutomationExplainer />
        <DataTable
          data={rows}
          total={query.data?.count}
          columns={columns}
          flexColumn="url"
          tableId="automation-targets"
          onSelectedRowsChange={selectable ? setSelected : undefined}
          selectedRows={selectable ? selected : undefined}
        />
      </div>
      <SafeBulkEditBar
        selected={selected}
        endpoint={ENDPOINT}
        noun={NOUN}
        invalidate={[["automation-targets"]]}
        onCleared={clear}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="automationtarget"
        actions={
          canEdit && (
            <BulkFlagActions
              endpoint={ENDPOINT}
              field="enabled"
              ids={selected.map((t) => t.id)}
              noun={NOUN}
              invalidate={[["automation-targets"]]}
              onDone={clear}
            />
          )
        }
      />
      <AutomationTargetDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
