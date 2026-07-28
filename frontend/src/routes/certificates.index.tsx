import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import { Upload } from "lucide-react"

import { api } from "@/lib/api"
import type { Certificate, Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { buildCertificateColumns } from "@/components/columns/certificate-columns"
import { useTableFilters } from "@/components/table-filters"
import { UploadCertificateDialog } from "@/components/monitoring/upload-certificate-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/certificates/")({
  component: CertificatesPage,
})

function CertificatesPage() {
  const [q, setQ] = useState("")
  const [uploadOpen, setUploadOpen] = useState(false)
  const { canDo } = useMe()

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
      actions={
        canDo("certificate", "add") ? (
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="h-3.5 w-3.5" /> Upload certificate
          </Button>
        ) : undefined
      }
      query={query}
    >
      {allRows.length === 0 ? (
        <EmptyState title="No certificates yet.">
          Upload a public certificate to declare what an object should present,
          or wait for a <span className="font-mono">tls_cert</span> check to
          observe what an endpoint is actually serving. Either way the row is
          keyed by its fingerprint, so an uploaded certificate and its
          observation collapse into one.
        </EmptyState>
      ) : (
        <DataTable
          data={filteredRows}
          columns={columns}
          flexColumn="issuer"
          tableId="certificates"
        />
      )}

      <UploadCertificateDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </ListPageShell>
  )
}
