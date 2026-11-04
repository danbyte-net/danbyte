import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type DhcpLease, type Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { buildDhcpLeaseColumns } from "@/components/columns/dhcp-lease-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { TableActions } from "@/components/table-actions"
import { useFacetRail } from "@/lib/use-facet-rail"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/dhcp-leases/")({
  component: DhcpLeasesPage,
})

/** Leases are synced from the server and read-only: a selection exports,
 * nothing more. */
function DhcpLeasesPage() {
  const [q, setQ] = useUrlSearch()
  const [selected, setSelected] = useState<DhcpLease[]>([])
  const { canDo } = useMe()
  const canView = canDo("dhcplease", "view")
  const query = useQuery({
    queryKey: ["dhcp-leases", "all", q],
    queryFn: () =>
      api<Paginated<DhcpLease>>(
        `/api/dhcp-leases/?${new URLSearchParams({ search: q })}&page_size=500`
      ),
  })
  const rows = query.data?.results ?? []

  const columns = useMemo(
    () => buildDhcpLeaseColumns<DhcpLease>({ selection: canView }),
    [canView]
  )

  const { rail, filtered } = useFacetRail(rows, [
    {
      key: "scope",
      label: "Scope",
      get: (r) => ({ value: r.scope_display, label: r.scope_display }),
    },
    {
      key: "state",
      label: "State",
      get: (r) =>
        r.address_state
          ? { value: r.address_state, label: r.address_state }
          : null,
    },
  ])

  return (
    <ListPageShell
      title="DHCP leases"
      count={query.data ? filtered.length : undefined}
      query={query}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "IP, MAC or hostname…" }}
      actions={<TableActions ioType="dhcplease" />}
    >
      {rows.length === 0 && query.data && !q ? (
        <EmptyState title="No leases synced.">
          Lease sync is opt-in per scope - turn it on for a scope on its Windows
          server's page, and its active leases appear here.
        </EmptyState>
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          tableId="dhcp-leases-all"
          onSelectedRowsChange={canView ? setSelected : undefined}
          selectedRows={canView ? selected : undefined}
        />
      )}
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/dhcp-leases/"
        noun={["lease", "leases"]}
        invalidate={[["dhcp-leases"]]}
        onCleared={() => setSelected([])}
        canEdit={false}
        canDelete={false}
        ioType="dhcplease"
      />
    </ListPageShell>
  )
}
