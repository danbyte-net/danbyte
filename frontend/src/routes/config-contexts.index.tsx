import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type ConfigContext, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { numidColumn } from "@/components/cells/numid"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { ConfigContextDeleteDialog } from "@/components/config-context-delete-dialog"

function criteria(c: ConfigContext): string {
  const parts: string[] = []
  if (c.regions.length) parts.push(`${c.regions.length} region(s)`)
  if (c.sites.length) parts.push(`${c.sites.length} site(s)`)
  if (c.device_roles.length) parts.push(`${c.device_roles.length} role(s)`)
  if (c.platforms.length) parts.push(`${c.platforms.length} platform(s)`)
  return parts.join(" · ") || "All devices/VMs"
}

export const Route = createFileRoute("/config-contexts/")({
  component: ConfigContextsPage,
})

function ConfigContextsPage() {
  const { humanIds } = useMe()
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ConfigContext | null>(null)

  const query = useQuery({
    queryKey: ["config-contexts", q],
    queryFn: () =>
      api<Paginated<ConfigContext>>(
        `/api/config-contexts/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((c: ConfigContext) => setDeleting(c), [])
  const columns = useMemo<ColumnDef<ConfigContext>[]>(
    () => [
      ...(humanIds
        ? [numidColumn<ConfigContext>({ get: (r) => r.numid })]
        : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/config-contexts/$id/edit"
            params={{ id: row.original.id }}
            className="flex items-center gap-2 font-medium hover:underline"
          >
            {row.original.name}
            {!row.original.is_active && (
              <Badge variant="secondary" className="text-[10px]">
                inactive
              </Badge>
            )}
          </Link>
        ),
      },
      {
        id: "weight",
        accessorKey: "weight",
        header: ({ column }) => <SortHeader column={column} label="Weight" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.weight}</span>
        ),
      },
      {
        id: "criteria",
        header: "Applies to",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {criteria(row.original)}
          </span>
        ),
      },
      {
        id: "keys",
        header: "Data keys",
        cell: ({ row }) => {
          const keys = Object.keys(row.original.data ?? {})
          return (
            <span className="font-mono text-[11px] text-muted-foreground">
              {keys.length ? keys.join(", ") : "—"}
            </span>
          )
        },
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/config-contexts/$id/edit"
            editParams={{ id: row.original.id }}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [onDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Config contexts"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter contexts…",
      }}
      actions={
        <>
          <TableActions ioType="configcontext" />
          <Button size="sm" asChild>
            <Link to="/config-contexts/new">Add context</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="criteria"
        tableId="config-contexts"
      />
      <ConfigContextDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
