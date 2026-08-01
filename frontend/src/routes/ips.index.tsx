import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { IPAddress, Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { useTableFilters } from "@/components/table-filters"

export const Route = createFileRoute("/ips/")({
  component: IpsPage,
  // Deep-link filters from the dashboard "IPs by status / role" cards, e.g.
  // /ips?status=<id> or /ips?role=<id>. Keys optional so a plain /ips is valid.
  validateSearch: (
    s: Record<string, unknown>
  ): { status?: string; role?: string } => {
    const out: { status?: string; role?: string } = {}
    if (typeof s.status === "string") out.status = s.status
    if (typeof s.role === "string") out.role = s.role
    return out
  },
})

function IpsPage() {
  const { status, role } = Route.useSearch()
  const [q, setQ] = useState("")

  // Filter server-side (the address space can be very large): the status/role
  // deep-link and the search box narrow before rows are shipped. The facet rail
  // then refines the returned set client-side.
  const query = useQuery({
    queryKey: ["ips-list", q, status ?? "", role ?? ""],
    queryFn: () => {
      const p = new URLSearchParams({ page_size: "1000" })
      if (q) p.set("search", q)
      if (status) p.set("status", status)
      if (role) p.set("role", role)
      return api<Paginated<IPAddress>>(`/api/ips/?${p.toString()}`)
    },
  })
  const allRows = useMemo(() => query.data?.results ?? [], [query.data])

  const columns = useMemo<ColumnDef<IPAddress>[]>(
    () => buildIpColumns<IPAddress>({ copyButton: true }),
    []
  )
  // Seed the status / role facets from the URL so the active filter is visible
  // in the rail (the server already applied it — see the query above).
  const initialEnums = useMemo(() => {
    const seed: Record<string, string[]> = {}
    if (status) seed.status = [status]
    if (role) seed.role = [role]
    return seed
  }, [status, role])
  const { rail, filteredRows } = useTableFilters(columns, allRows, initialEnums)

  return (
    <ListPageShell
      title="IP addresses"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
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
