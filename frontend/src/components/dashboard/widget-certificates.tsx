import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Certificate, Paginated } from "@/lib/api"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { ExpiryBadge } from "@/components/columns/certificate-columns"

// Dashboard widget: certificates expiring within 30 days, already-expired
// included, most urgent first. `expiring_in_days=30` filters not_after within
// the window (past dates included), and the API orders by not_after ascending,
// so the list arrives exactly in urgency order - no client-side sort needed.
const COLUMNS: SimpleColumn<Certificate>[] = [
  {
    id: "subject",
    header: "Subject",
    flex: true,
    cell: (c) => (
      <Link
        to="/certificates/$id"
        params={{ id: c.id }}
        className="link truncate font-medium"
      >
        {c.subject_cn || c.subject || `${c.fingerprint_sha256.slice(0, 16)}…`}
      </Link>
    ),
  },
  {
    id: "endpoints",
    header: "Endpoints",
    align: "right",
    cell: (c) => (
      <span className="num text-muted-foreground">{c.binding_count}</span>
    ),
  },
  {
    id: "expiry",
    header: "Expiry",
    align: "right",
    cell: (c) => <ExpiryBadge cert={c} />,
  },
]

function CertList({
  queryKey,
  url,
  empty,
}: {
  queryKey: string
  url: string
  empty: string
}) {
  const q = useQuery({
    queryKey: [queryKey],
    queryFn: () => api<Paginated<Certificate>>(url),
  })

  if (q.isLoading)
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center text-center text-sm text-muted-foreground">
        {empty}
      </div>
    )
  return <SimpleTable columns={COLUMNS} data={rows} getRowKey={(c) => c.id} />
}

export function ExpiringCertsWidget() {
  return (
    <CertList
      queryKey="dashboard-expiring-certs"
      url="/api/monitoring/certificates/?expiring_in_days=30&page_size=25"
      empty="No certificates expiring in the next 30 days."
    />
  )
}

// Already-past-expiry only - the failures, not the warnings. `expired=1` filters
// to not_after ≤ now; the list still arrives soonest-first (most-overdue).
export function ExpiredCertsWidget() {
  return (
    <CertList
      queryKey="dashboard-expired-certs"
      url="/api/monitoring/certificates/?expired=1&page_size=25"
      empty="No expired certificates. 🎉"
    />
  )
}
