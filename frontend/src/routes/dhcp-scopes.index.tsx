import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api, type DhcpScope, type Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { buildDhcpScopeColumns } from "@/components/columns/dhcp-scope-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { TableActions } from "@/components/table-actions"
import { DhcpScopeDialog } from "@/components/integrations/dhcp-scope-dialog"
import { useFacetRail } from "@/lib/use-facet-rail"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/dhcp-scopes/")({
  component: DhcpScopesPage,
})

function DhcpScopesPage() {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [q, setQ] = useUrlSearch()
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<DhcpScope[]>([])
  const canManage = canDo("dhcpscope", "add")
  const canEdit = canDo("dhcpscope", "change")
  const canDelete = canDo("dhcpscope", "delete")
  const selectable = canEdit || canDelete
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

  const columns = useMemo(
    () =>
      buildDhcpScopeColumns<DhcpScope>({
        selection: selectable,
        actions: canDelete
          ? {
              onDelete: (r) => del.mutate(r),
              deleteLabel: "Delete scope (removes it on the server)",
            }
          : undefined,
      }),
    [selectable, canDelete, del]
  )

  const { rail, filtered } = useFacetRail(rows, [
    {
      key: "server",
      label: "Server",
      get: (r) => ({
        value: r.connection_name ?? "Local",
        label: r.connection_name ?? "Local",
      }),
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
        <>
          <TableActions ioType="dhcpscope" />
          {canManage && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> Add scope
            </Button>
          )}
        </>
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
          onSelectedRowsChange={selectable ? setSelected : undefined}
          selectedRows={selectable ? selected : undefined}
        />
      )}
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/dhcp-scopes/"
        noun={["scope", "scopes"]}
        invalidate={[["dhcp-scopes"], ["dhcp-reservations"], ["dhcp-leases"]]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="dhcpscope"
      />
      {creating && <DhcpScopeDialog onOpenChange={setCreating} />}
    </ListPageShell>
  )
}
