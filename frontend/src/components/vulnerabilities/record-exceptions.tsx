import { useQuery } from "@tanstack/react-query"

import type { VulnException } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { EXCEPTIONS_ENDPOINT } from "@/components/vulnerabilities/exception-dialog"
import { useExceptionTable } from "@/components/vulnerabilities/exceptions-table"

// A record page's Exceptions tab (#451): every exception for the record,
// active and expired, with Edit and Delete as the role allows.

export function recordExceptionsUrl(vulnId: string): string {
  return `${EXCEPTIONS_ENDPOINT}?vuln_id=${encodeURIComponent(vulnId)}`
}

export function useRecordExceptions(vulnId: string) {
  return useQuery({
    queryKey: ["vulnerability-exceptions", "record", vulnId],
    queryFn: () => apiAll<VulnException>(recordExceptionsUrl(vulnId)),
  })
}

export function RecordExceptions({ vulnId }: { vulnId: string }) {
  const q = useRecordExceptions(vulnId)
  const { columns, selected, setSelected, overlays } = useExceptionTable({
    omit: ["record"],
  })
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  return (
    <>
      {rows.length === 0 ? (
        <EmptyState title="No exceptions">
          Add one from the Affected tab.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          onSelectedRowsChange={setSelected}
          selectedRows={selected}
          flexColumn="reason"
          tableId="vulnerability-record-exceptions"
          exportName="vulnerability-record-exceptions"
          embedded
          autoColumns={false}
        />
      )}
      {overlays}
    </>
  )
}
