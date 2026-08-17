import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api, type DhcpScope, type Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { dash } from "@/components/kv-card"
import { DhcpScopeDialog } from "@/components/integrations/dhcp-scope-dialog"
import { useFacetRail } from "@/lib/use-facet-rail"

export const Route = createFileRoute("/dhcp-scopes/")({
  component: DhcpScopesPage,
})

function DhcpScopesPage() {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const canManage = canDo("dhcpscope", "add")
  const canDelete = canDo("dhcpscope", "delete")
  const query = useQuery({
    queryKey: ["dhcp-scopes", "all", q],
    queryFn: () =>
      api<Paginated<DhcpScope>>(
        `/api/dhcp-scopes/?${new URLSearchParams({ search: q })}&page_size=500`
      ),
  })
  const rows = query.data?.results ?? []

  const del = useMutation({
    mutationFn: (s: DhcpScope) =>
      api(`/api/dhcp-scopes/${s.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Scope removed from the server")
      qc.invalidateQueries({ queryKey: ["dhcp-scopes"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<DhcpScope>[]>(
    () => [
      {
        id: "scope",
        accessorKey: "scope_id",
        header: ({ column }) => <SortHeader column={column} label="Scope" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs font-medium">
            {row.original.scope_id}
          </span>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => row.original.name || dash,
      },
      {
        id: "prefix",
        header: "Prefix",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.prefix ? (
            <Link
              to="/prefixes/$id"
              params={{ id: row.original.prefix }}
              className="link font-mono text-xs"
            >
              {row.original.prefix_cidr}
            </Link>
          ) : (
            dash
          ),
      },
      {
        id: "range",
        header: "Range",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {row.original.start_range}–{row.original.end_range}
          </span>
        ),
      },
      {
        id: "server",
        accessorKey: "connection_name",
        header: ({ column }) => <SortHeader column={column} label="Server" />,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.connection_name}
          </span>
        ),
      },
      {
        id: "state",
        accessorKey: "state",
        header: ({ column }) => <SortHeader column={column} label="State" />,
        cell: ({ row }) => (
          <Badge
            variant={row.original.state === "Active" ? "success" : "secondary"}
            className="text-[10px]"
          >
            {row.original.state || "unknown"}
          </Badge>
        ),
      },
      {
        id: "reservations",
        accessorKey: "reservation_count",
        header: ({ column }) => (
          <SortHeader column={column} label="Reservations" />
        ),
        cell: ({ row }) =>
          row.original.reservation_count > 0 ? (
            <Link
              to="/dhcp-reservations"
              search={{ scope: row.original.id }}
              className="link"
            >
              <span className="num">{row.original.reservation_count}</span>
              {row.original.drift_count > 0 && (
                <Badge variant="destructive" className="ml-2 text-[10px]">
                  {row.original.drift_count} drift
                </Badge>
              )}
            </Link>
          ) : (
            <span className="num text-muted-foreground">0</span>
          ),
      },
      ...(canDelete
        ? [
            {
              id: "actions",
              header: "",
              enableSorting: false,
              cell: ({ row }) => (
                <RowActions
                  onDelete={() => del.mutate(row.original)}
                  deleteLabel="Delete scope (removes it on the server)"
                />
              ),
            } satisfies ColumnDef<DhcpScope>,
          ]
        : []),
    ],
    [canDelete, del]
  )

  const { rail, filtered } = useFacetRail(rows, [
    {
      key: "server",
      label: "Server",
      get: (r) => ({ value: r.connection_name, label: r.connection_name }),
    },
    {
      key: "state",
      label: "State",
      get: (r) => (r.state ? { value: r.state, label: r.state } : null),
    },
  ])

  return (
    <ListPageShell
      title="DHCP scopes"
      count={query.data ? filtered.length : undefined}
      query={query}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter scopes…" }}
      actions={
        canManage ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> Add scope
          </Button>
        ) : undefined
      }
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No DHCP scopes yet.">
          Connect a Windows DHCP server under Integrations → Windows servers to
          sync its scopes, or use <strong>Add scope</strong> to create one.
        </EmptyState>
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          tableId="dhcp-scopes-all"
        />
      )}
      {creating && <DhcpScopeDialog onOpenChange={setCreating} />}
    </ListPageShell>
  )
}
