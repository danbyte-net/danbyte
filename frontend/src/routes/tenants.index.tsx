import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { ArrowRightLeft } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api, type Paginated, type Tenant, type TenantPicker } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { TenantDeleteDialog } from "@/components/tenant-delete-dialog"
import { TenantBulkBar } from "@/components/tenant-bulk-bar"
import { TenantGroupsSection } from "@/components/tenant-groups-section"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/tenants/")({ component: TenantsPage })

function TenantsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Tenant | null>(null)
  const [selected, setSelected] = useState<Tenant[]>([])
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAdd = canDo("tenant", "add")
  const canEdit = canDo("tenant", "change")
  const canDelete = canDo("tenant", "delete")

  const query = useQuery({
    queryKey: ["tenants", q],
    queryFn: () =>
      api<Paginated<Tenant>>(
        `/api/tenants/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const active = useQuery({
    queryKey: ["tenant-active"],
    queryFn: () => api<TenantPicker | { id: null }>("/api/tenants/active/"),
    staleTime: 60_000,
  })
  const activeId = active.data && "id" in active.data ? active.data.id : null

  const switchMutation = useMutation({
    mutationFn: (id: string) =>
      api<TenantPicker>(`/api/tenants/${id}/switch/`, { method: "POST" }),
    onSuccess: (t) => {
      // Hard boundary: full document load so NO previous-tenant data survives.
      // invalidateQueries leaves mounted observers rendering stale rows until
      // each refetch resolves — a cross-tenant flash. (Same as the sidebar.)
      toast.success(`Switched to ${t.name}`)
      qc.clear()
      window.location.assign("/")
    },
    onError: (err) => apiErrorToast(err),
  })

  const handleDelete = useCallback((t: Tenant) => setDeleting(t), [])
  const handleSwitch = useCallback(
    (t: Tenant) => switchMutation.mutate(t.id),
    [switchMutation]
  )

  const columns = useMemo<ColumnDef<Tenant>[]>(
    () =>
      buildColumns({
        activeId,
        onDelete: handleDelete,
        onSwitch: handleSwitch,
        canEdit,
        canDelete,
      }),
    [activeId, handleDelete, handleSwitch, canEdit, canDelete]
  )

  const allRows = query.data?.results ?? []
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Tenants"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name or slug…",
      }}
      actions={
        <>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/tenants/new">Add Tenant</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="description"
        tableId="tenants"
        onSelectedRowsChange={canDelete || canEdit ? setSelected : undefined}
      />
      {(canDelete || canEdit) && (
        <TenantBulkBar selected={selected} onCleared={() => setSelected([])} />
      )}
      <TenantGroupsSection />
      <TenantDeleteDialog
        tenant={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

interface ColumnOpts {
  activeId: string | null
  onDelete: (t: Tenant) => void
  onSwitch: (t: Tenant) => void
  canEdit: boolean
  canDelete: boolean
}

function buildColumns({
  activeId,
  onDelete,
  onSwitch,
  canEdit,
  canDelete,
}: ColumnOpts): ColumnDef<Tenant>[] {
  return [
    selectionColumn<Tenant>(),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Tenant" />,
      cell: ({ row }) => {
        const isActive = row.original.id === activeId
        return (
          <div className="flex items-center gap-2">
            <Link
              to="/tenants/$id"
              params={{ id: row.original.id }}
              className="hover:opacity-90"
            >
              <ColorBadge
                name={row.original.name}
                color={row.original.color || undefined}
              />
            </Link>
            {isActive && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                active
              </Badge>
            )}
            {!row.original.is_active && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                inactive
              </Badge>
            )}
          </div>
        )
      },
    },
    {
      id: "slug",
      accessorKey: "slug",
      header: ({ column }) => <SortHeader column={column} label="Slug" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.slug}
        </span>
      ),
    },
    {
      id: "group",
      accessorFn: (t) => t.group?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Group" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.group?.name ?? "—"}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Group",
          get: (r: Tenant) => r.group?.name ?? "",
          formatValue: (v) => ({ label: v || "No group" }),
        },
      },
    },
    {
      id: "status",
      accessorFn: (t) => (t.is_active ? "active" : "inactive"),
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) =>
        row.original.is_active ? (
          <Badge variant="secondary">Active</Badge>
        ) : (
          <Badge variant="outline">Inactive</Badge>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: Tenant) => (r.is_active ? "active" : "inactive"),
          formatValue: (v) => ({
            label: v === "active" ? "Active" : "Inactive",
          }),
        },
      },
    },
    {
      id: "sites",
      accessorKey: "site_count",
      header: ({ column }) => <SortHeader column={column} label="Sites" />,
      cell: ({ row }) =>
        row.original.site_count > 0 ? (
          <span className="num text-xs">{row.original.site_count}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "prefixes",
      accessorKey: "prefix_count",
      header: ({ column }) => <SortHeader column={column} label="Prefixes" />,
      cell: ({ row }) =>
        row.original.prefix_count > 0 ? (
          <span className="num text-xs">{row.original.prefix_count}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "vlans",
      accessorKey: "vlan_count",
      header: ({ column }) => <SortHeader column={column} label="VLANs" />,
      cell: ({ row }) =>
        row.original.vlan_count > 0 ? (
          <span className="num text-xs">{row.original.vlan_count}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "ips",
      accessorKey: "ip_count",
      header: ({ column }) => <SortHeader column={column} label="IPs" />,
      cell: ({ row }) =>
        row.original.ip_count > 0 ? (
          <span className="num text-xs">{row.original.ip_count}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    },
    timeAgoColumn<Tenant>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => {
        const isActive = row.original.id === activeId
        return (
          <RowActions
            editTo={canEdit ? "/tenants/$id/edit" : undefined}
            editParams={{ id: row.original.id }}
            onDelete={canDelete ? () => onDelete(row.original) : undefined}
            extra={
              !isActive && row.original.is_active ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  title="Switch to this tenant"
                  onClick={() => onSwitch(row.original)}
                >
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  <span className="sr-only">Switch to this tenant</span>
                </Button>
              ) : undefined
            }
          />
        )
      },
    },
  ]
}
