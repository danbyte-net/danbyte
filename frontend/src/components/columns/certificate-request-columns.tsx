import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { CertificateRequest } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { dash } from "@/components/cells/dash"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of certificate requests" (CSRs).
// /certificate-requests builds here.

export type CertificateRequestColumnId =
  "common_name" | "key" | "status" | "issued" | "created"

const CANONICAL_ORDER: CertificateRequestColumnId[] = [
  "common_name",
  "key",
  "status",
  "issued",
  "created",
]

const STATUS_VARIANT: Record<
  CertificateRequest["status"],
  "secondary" | "success" | "outline"
> = {
  generated: "secondary",
  issued: "success",
  cancelled: "outline",
}

export interface CertificateRequestColumnOpts<
  T extends CertificateRequest = CertificateRequest,
> {
  omit?: CertificateRequestColumnId[]
  include?: CertificateRequestColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildCertificateRequestColumns<
  T extends CertificateRequest = CertificateRequest,
>(opts: CertificateRequestColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: CertificateRequestColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<CertificateRequestColumnId, () => ColumnDef<T, unknown>> =
    {
      common_name: () => ({
        id: "common_name",
        accessorFn: (r) => r.common_name,
        header: ({ column }) => (
          <SortHeader column={column} label="Common name" />
        ),
        cell: ({ row }) => (
          <Link
            to="/certificate-requests/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.common_name}
          </Link>
        ),
      }),
      key: () => ({
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
            get: (r: T) => r.key_spec_display,
          },
        },
      }),
      status: () => ({
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
            get: (r: T) => r.status_display,
          },
        },
      }),
      issued: () => ({
        id: "issued",
        header: "Issued certificate",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.issued_certificate ? (
            <Link
              to="/certificates/$id"
              params={{ id: row.original.issued_certificate }}
              className="link text-xs font-medium"
            >
              {row.original.issued_certificate_subject_cn || "View"}
            </Link>
          ) : (
            dash
          ),
      }),
      created: () => ({
        id: "created",
        accessorFn: (r) => r.created_at,
        header: ({ column }) => <SortHeader column={column} label="Created" />,
        cell: ({ row }) => <TimeCell iso={row.original.created_at} />,
      }),
    }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
