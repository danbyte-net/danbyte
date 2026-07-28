import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Certificate, Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { buildCertificateColumns } from "@/components/columns/certificate-columns"
import { useTableFilters } from "@/components/table-filters"

export const Route = createFileRoute("/certificates/")({
  component: CertificatesPage,
})

function CertificatesPage() {
  const [q, setQ] = useState("")

  // Server-side search over subject / issuer / fingerprint. The list arrives
  // ordered by not_after (soonest to expire first), so the default view leads
  // with what needs attention; the facet rail below refines client-side.
  const query = useQuery({
    queryKey: ["certificates", q],
    queryFn: () =>
      api<Paginated<Certificate>>(
        `/api/monitoring/certificates/?${new URLSearchParams({
          search: q,
          page_size: "500",
        }).toString()}`
      ),
  })
  const allRows = useMemo(() => query.data?.results ?? [], [query.data])

  // The rail carries the facets the factory declares — expiry urgency, key
  // algorithm and trust (self-signed vs CA-issued). The facet-source columns
  // and the render columns are the same set here.
  const columns = useMemo<ColumnDef<Certificate>[]>(
    () => buildCertificateColumns<Certificate>(),
    []
  )
  const { rail, filteredRows } = useTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Certificates"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by subject, issuer, fingerprint…",
      }}
      query={query}
    >
      {allRows.length === 0 ? (
        <EmptyState title="No certificates yet.">
          Certificates appear here once a{" "}
          <span className="font-mono">tls_cert</span> check observes what an
          endpoint is serving. Nothing is authored here — the inventory only
          records what was actually presented.
        </EmptyState>
      ) : (
        <DataTable
          data={filteredRows}
          columns={columns}
          flexColumn="issuer"
          tableId="certificates"
        />
      )}
    </ListPageShell>
  )
}
