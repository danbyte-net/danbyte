import { createFileRoute, Navigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type DnsRecord } from "@/lib/api"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/dns-records/$id")({
  component: DnsRecordRedirect,
})

/** An id-shaped URL for a record, resolved to its name page.
 *
 * The page for a DNS record is the page for its *name* - round robin means one
 * name owns several rows, and the sync keys rows on `(zone, name, type, data)`
 * so a row's id changes whenever its value does. This route exists so links and
 * bookmarks that already carry an id still land somewhere correct. */
function DnsRecordRedirect() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["dns-record", id],
    queryFn: () => api<DnsRecord>(`/api/dns-records/${id}/`),
    retry: false,
  })

  if (q.isLoading)
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return (
    <Navigate
      to="/dns-names/$name"
      params={{ name: q.data.name.replace(/\.$/, "") }}
      search={{ zone: q.data.zone }}
      replace
    />
  )
}
