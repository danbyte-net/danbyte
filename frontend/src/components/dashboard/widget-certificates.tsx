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
// so the list arrives exactly in urgency order — no client-side sort needed.
const COLUMNS: SimpleColumn<Certificate>[] = [
  {
    id: "subject",
    header: "Subject",
    flex: true,
    cell: (c) => (
      <Link
        to="/certificates/$id"
        params={{ id: c.id }}
        className="truncate font-medium hover:underline"
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

export function ExpiringCertsWidget() {
  const q = useQuery({
    queryKey: ["dashboard-expiring-certs"],
    queryFn: () =>
      api<Paginated<Certificate>>(
        "/api/monitoring/certificates/?expiring_in_days=30&page_size=25"
      ),
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
        No certificates expiring in the next 30 days.
      </div>
    )
  return <SimpleTable columns={COLUMNS} data={rows} getRowKey={(c) => c.id} />
}
