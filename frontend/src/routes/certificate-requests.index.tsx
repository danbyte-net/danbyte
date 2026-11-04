import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { FileSignature } from "lucide-react"

import { api } from "@/lib/api"
import type { CertificateRequest, Paginated } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { buildCertificateRequestColumns } from "@/components/columns/certificate-request-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { useUrlTableFilters } from "@/components/table-filters"
import { RequestCertificateDialog } from "@/components/monitoring/request-certificate-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/certificate-requests/")({
  component: CertificateRequestsPage,
})

function CertificateRequestsPage() {
  const [requestOpen, setRequestOpen] = useState(false)
  const [selected, setSelected] = useState<CertificateRequest[]>([])
  const { canDo } = useMe()
  const canEdit = canDo("certificaterequest", "change")
  const canDelete = canDo("certificaterequest", "delete")
  const selectable = canEdit || canDelete

  const query = useQuery({
    queryKey: ["certificate-requests"],
    queryFn: () =>
      api<Paginated<CertificateRequest>>(
        "/api/monitoring/certificate-requests/?page_size=500"
      ),
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])

  const columns = useMemo(
    () =>
      buildCertificateRequestColumns<CertificateRequest>({
        selection: selectable,
      }),
    [selectable]
  )

  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Certificate requests"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "certificaterequest",
        filters: { snapshot, restore, activeCount },
      }}
      actions={
        canDo("certificaterequest", "add") ? (
          <Button size="sm" onClick={() => setRequestOpen(true)}>
            <FileSignature className="h-3.5 w-3.5" /> Request certificate
          </Button>
        ) : undefined
      }
      query={query}
    >
      {rows.length === 0 ? (
        <EmptyState title="No certificate requests yet.">
          Request a certificate to have Danbyte generate a key pair and CSR to
          hand to a certificate authority. Requires a secret store to be enabled
          (Settings → Security).
        </EmptyState>
      ) : (
        <DataTable
          data={filteredRows}
          columns={wiredColumns}
          flexColumn="common_name"
          tableId="certificate-requests"
          onSelectedRowsChange={selectable ? setSelected : undefined}
          selectedRows={selectable ? selected : undefined}
        />
      )}
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/monitoring/certificate-requests/"
        noun={["certificate request", "certificate requests"]}
        invalidate={[["certificate-requests"]]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="certificaterequest"
      />

      <RequestCertificateDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
      />
    </ListPageShell>
  )
}
