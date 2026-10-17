import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { decodeList, useListSearch, useUrlSearch } from "@/lib/url-filters"
import type { IPAddress, Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { buildIpColumns } from "@/components/columns/ip-columns"
import {
  AvailabilityFramePicker,
  useSlaStatus,
} from "@/components/monitoring/sla-status"
import { IpBulkBar } from "@/components/ip-bulk-bar"
import { useUrlTableFilters } from "@/components/table-filters"

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
  const [q, setQ] = useUrlSearch()
  // The Status / Role / Scope facets live in the URL. One value is sent to
  // the server too (the address space can be very large); several are
  // refined client-side over what arrived.
  const search = useListSearch()
  const single = (key: string) => {
    const v = decodeList(search[key])
    return v.length === 1 ? v[0] : undefined
  }
  const status = single("status")
  const role = single("role")
  const scope = single("scope")
  const [selectedRows, setSelectedRows] = useState<IPAddress[]>([])

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

  const ipIds = useMemo(() => allRows.map((r) => r.id), [allRows])
  const sla = useSlaStatus("ip", ipIds)
  const columns = useMemo<ColumnDef<IPAddress>[]>(
    () =>
      buildIpColumns<IPAddress>({
        copyButton: true,
        selection: true,
        sla: { entries: sla.entries, frame: sla.frame },
      }),
    [sla.entries, sla.frame]
  )
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, allRows)

  return (
    <>
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
            <AvailabilityFramePicker
              value={sla.frame}
              onChange={sla.setFrame}
            />
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
        page={query.data}
      >
        {allRows.length === 0 ? (
          <EmptyState title="No IP addresses.">
            IPs appear here as they're created under a prefix, discovered, or
            imported. Open a prefix to see and manage the addresses inside it.
          </EmptyState>
        ) : (
          <DataTable
            data={filteredRows}
            columns={wiredColumns}
            flexColumn="description"
            onSelectedRowsChange={setSelectedRows}
            tableId="ips"
          />
        )}
      </ListPageShell>
      {/* Bulk bar at root so the table can unmount without losing the
          selection mid-action (see /prefixes). */}
      <IpBulkBar
        selected={selectedRows}
        onCleared={() => setSelectedRows([])}
      />
    </>
  )
}
