import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { FileSignature } from "lucide-react"

import { api } from "@/lib/api"
import type { CertificateRequest, Paginated } from "@/lib/api"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { dash } from "@/components/cells/dash"
import { useTableFilters } from "@/components/table-filters"
import { RequestCertificateDialog } from "@/components/monitoring/request-certificate-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/certificate-requests/")({
  component: CertificateRequestsPage,
})

const STATUS_VARIANT: Record<
  CertificateRequest["status"],
  "secondary" | "success" | "outline"
> = {
  generated: "secondary",
  issued: "success",
  cancelled: "outline",
}

function CertificateRequestsPage() {
  const [requestOpen, setRequestOpen] = useState(false)
  const { canDo } = useMe()

  const query = useQuery({
    queryKey: ["certificate-requests"],
    queryFn: () =>
      api<Paginated<CertificateRequest>>(
        "/api/monitoring/certificate-requests/?page_size=500"
      ),
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])

  const columns = useMemo<ColumnDef<CertificateRequest>[]>(
    () => [
      {
        id: "common_name",
        accessorFn: (r) => r.common_name,
        header: ({ column }) => (
          <SortHeader column={column} label="Common name" />
        ),
        cell: ({ row }) => (
          <Link
            to="/certificate-requests/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.common_name}
          </Link>
        ),
      },
      {
        id: "key",
        accessorFn: (r) => r.key_spec_display,
        header: "Key",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.key_spec_display}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Key",
            get: (r: CertificateRequest) => r.key_spec_display,
          },
        },
      },
      {
        id: "status",
        accessorFn: (r) => r.status,
        header: "Status",
        cell: ({ row }) => (
          <Badge
            variant={STATUS_VARIANT[row.original.status]}
            className="text-xs"
          >
            {row.original.status_display}
          </Badge>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Status",
            get: (r: CertificateRequest) => r.status_display,
          },
        },
      },
      {
        id: "issued",
        header: "Issued certificate",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.issued_certificate ? (
            <Link
              to="/certificates/$id"
              params={{ id: row.original.issued_certificate }}
              className="text-xs font-medium hover:underline"
            >
              {row.original.issued_certificate_subject_cn || "View"}
            </Link>
          ) : (
            dash
          ),
      },
      {
        id: "created",
        accessorFn: (r) => r.created_at,
        header: ({ column }) => <SortHeader column={column} label="Created" />,
        cell: ({ row }) => <TimeCell iso={row.original.created_at} />,
      },
    ],
    []
  )

  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, rows)

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
          columns={columns}
          flexColumn="common_name"
          tableId="certificate-requests"
        />
      )}

      <RequestCertificateDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
      />
    </ListPageShell>
  )
}
