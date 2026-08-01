import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import { FileUp, Upload } from "lucide-react"

import { api } from "@/lib/api"
import type { Certificate, Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { buildCertificateColumns } from "@/components/columns/certificate-columns"
import { useTableFilters } from "@/components/table-filters"
import { UploadCertificateDialog } from "@/components/monitoring/upload-certificate-dialog"
import { ImportCertificatesDialog } from "@/components/monitoring/import-certificates-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/certificates/")({
  component: CertificatesPage,
  // Deep-link filters from the monitoring cert-health tiles, e.g.
  // /certificates?expiry=healthy or ?self_signed=self. Keys are optional so
  // plain links to /certificates (no filter) stay valid.
  validateSearch: (
    s: Record<string, unknown>
  ): { expiry?: string; self_signed?: string } => {
    const out: { expiry?: string; self_signed?: string } = {}
    if (typeof s.expiry === "string") out.expiry = s.expiry
    if (typeof s.self_signed === "string") out.self_signed = s.self_signed
    return out
  },
})

function CertificatesPage() {
  const { expiry, self_signed } = Route.useSearch()
  const [q, setQ] = useState("")
  const [uploadOpen, setUploadOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
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
  // Seed the expiry / trust facets from the URL so a cert-health tile lands on
  // the pre-filtered list. Facet ids: "expiry" (expired|critical|warning|
  // healthy) and "self_signed" (self|ca) — see certificate-columns.tsx.
  const initialEnums = useMemo(() => {
    const seed: Record<string, string[]> = {}
    if (
      expiry &&
      ["expired", "critical", "warning", "healthy"].includes(expiry)
    )
      seed.expiry = [expiry]
    if (self_signed && ["self", "ca"].includes(self_signed))
      seed.self_signed = [self_signed]
    return seed
  }, [expiry, self_signed])
  const { rail, filteredRows } = useTableFilters(columns, allRows, initialEnums)

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
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setImportOpen(true)}
            >
              <FileUp className="h-3.5 w-3.5" /> Import bundle
            </Button>
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <Upload className="h-3.5 w-3.5" /> Upload certificate
            </Button>
          </div>
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
      <ImportCertificatesDialog
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </ListPageShell>
  )
}
