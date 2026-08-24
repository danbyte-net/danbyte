import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import type { IPAddress, Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { useTableFilters } from "@/components/table-filters"

export const Route = createFileRoute("/ips/")({
  component: IpsPage,
  // Deep-link filters from the dashboard "IPs by status / role / scope" cards,
  // e.g. /ips?status=<id>, ?role=<id>, or ?scope=public. Keys optional so a
  // plain /ips is valid.
  validateSearch: (
    s: Record<string, unknown>
  ): { status?: string; role?: string; scope?: string } => {
    const out: { status?: string; role?: string; scope?: string } = {}
    if (typeof s.status === "string") out.status = s.status
    if (typeof s.role === "string") out.role = s.role
    if (typeof s.scope === "string") out.scope = s.scope
    return out
  },
})

function IpsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("ipaddress", "add")
  const { status, role, scope } = Route.useSearch()
  const [q, setQ] = useState("")

  // Filter server-side (the address space can be very large): the
  // status/role/scope deep-links and the search box narrow before rows are
  // shipped. The facet rail then refines the returned set client-side.
  const query = useQuery({
    queryKey: ["ips-list", q, status ?? "", role ?? "", scope ?? ""],
    queryFn: () => {
      const p = new URLSearchParams({ page_size: "1000" })
      if (q) p.set("search", q)
      if (status) p.set("status", status)
      if (role) p.set("role", role)
      if (scope) p.set("scope", scope)
      return api<Paginated<IPAddress>>(`/api/ips/?${p.toString()}`)
    },
  })
  const allRows = useMemo(() => query.data?.results ?? [], [query.data])

  const columns = useMemo<ColumnDef<IPAddress>[]>(
    () => buildIpColumns<IPAddress>({ copyButton: true }),
    []
  )
  // Seed the status / role / scope facets from the URL so the active filter is
  // visible in the rail (the server already applied it - see the query above).
  const initialEnums = useMemo(() => {
    const seed: Record<string, string[]> = {}
    if (status) seed.status = [status]
    if (role) seed.role = [role]
    if (scope) seed.scope = [scope]
    return seed
  }, [status, role, scope])
  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, allRows, initialEnums)

  return (
    <ListPageShell
      title="IP addresses"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "ipaddress",
        filters: { snapshot, restore, activeCount },
      }}
      actions={
        <>
          <TableActions ioType="ipaddress" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/ips/new">Add IP</Link>
            </Button>
          )}
        </>
      }
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by address or DNS name…",
      }}
      query={query}
    >
      {allRows.length === 0 ? (
        <EmptyState title="No IP addresses.">
          IPs appear here as they're created under a prefix, discovered, or
          imported. Open a prefix to see and manage the addresses inside it.
        </EmptyState>
      ) : (
        <DataTable
          data={filteredRows}
          columns={columns}
          flexColumn="description"
          tableId="ips"
        />
      )}
    </ListPageShell>
  )
}
