import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Wand2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type AutomationTarget, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { useMe } from "@/lib/use-me"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { AutomationTargetDeleteDialog } from "@/components/automation-target-delete-dialog"
import { AutomationExplainer } from "@/components/automation-explainer"
import { AutomationTargetTestButton } from "@/components/automation-target-test-button"

export const Route = createFileRoute("/automation-targets/")({
  component: AutomationTargetsPage,
})

function AutomationTargetsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("automationtarget", "add")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<AutomationTarget | null>(null)

  const query = useQuery({
    queryKey: ["automation-targets", q],
    queryFn: () =>
      api<Paginated<AutomationTarget>>(
        `/api/automation-targets/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((t: AutomationTarget) => setDeleting(t), [])
  const columns = useMemo<ColumnDef<AutomationTarget>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/automation-targets/$id"
            params={{ id: row.original.id }}
            className="flex items-center gap-2 font-medium hover:underline"
          >
            {row.original.name}
            {!row.original.enabled && (
              <Badge variant="secondary" className="text-[10px]">
                disabled
              </Badge>
            )}
          </Link>
        ),
      },
      {
        id: "kind",
        accessorKey: "kind_display",
        header: "Kind",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.kind_display}
          </span>
        ),
      },
      {
        id: "url",
        accessorKey: "base_url",
        header: "Endpoint",
        cell: ({ row }) => (
          <span className="line-clamp-1 block font-mono text-[11px] text-muted-foreground">
            {row.original.base_url}
            {row.original.kind === "awx" && row.original.job_template_id
              ? ` · JT ${row.original.job_template_id}`
              : ""}
          </span>
        ),
      },
      {
        id: "auto",
        header: "On change",
        cell: ({ row }) =>
          row.original.auto_on_change ? (
            <Badge variant="secondary" className="text-[10px]">
              auto
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">manual</span>
          ),
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/automation-targets/$id/edit"
            editParams={{ id: row.original.id }}
            onDelete={() => onDelete(row.original)}
            extra={<AutomationTargetTestButton target={row.original} />}
          />
        ),
      },
    ],
    [onDelete]
  )

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
          columns={columns}
          flexColumn="url"
          tableId="automation-targets"
        />
      </div>
      <AutomationTargetDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
