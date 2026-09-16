import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import type { NATRule, Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { buildNATRuleColumns } from "@/components/columns/nat-rule-columns"
import {
  NATRuleDeleteDialog,
  NATRuleFormDialog,
} from "@/components/nat-rule-dialogs"
import { ListPageShell } from "@/components/list-page-shell"
import { Button } from "@/components/ui/button"
import { useTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/nat-rules/")({ component: NATRulesPage })

function NATRulesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<NATRule | null>(null)
  const [adding, setAdding] = useState(false)
  const { canDo, humanIds } = useMe()
  const canDelete = canDo("natrule", "delete")
  const canAdd = canDo("natrule", "add")

  const query = useQuery({
    queryKey: ["nat-rules-list", q],
    queryFn: () =>
      api<Paginated<NATRule>>(
        `/api/nat-rules/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((r: NATRule) => setDeleting(r), [])

  const columns = useMemo<ColumnDef<NATRule>[]>(
    () =>
      buildNATRuleColumns<NATRule>({
        selection: true,
        humanIds,
        actions: { onDelete: handleDelete, canDelete: () => canDelete },
      }),
    [handleDelete, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="NAT rules"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "natrule",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, address, port…",
      }}
      actions={
        canAdd && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add NAT rule
          </Button>
        )
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        flexColumn="description"
        tableId="nat-rules"
      />
      <NATRuleFormDialog
        rule={null}
        open={adding}
        onOpenChange={(o) => !o && setAdding(false)}
        onSaved={() => {
          setAdding(false)
          void query.refetch()
        }}
      />
      <NATRuleDeleteDialog
        rule={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={() => void query.refetch()}
      />
    </ListPageShell>
  )
}
