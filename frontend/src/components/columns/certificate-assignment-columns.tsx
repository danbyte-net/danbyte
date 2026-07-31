import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { CertificateAssignment } from "@/lib/api"
import {
  CERTIFICATE_OBJECT_TYPES,
  certificateObjectLabel,
} from "@/lib/certificate-objects"
import { dash } from "@/components/cells/dash"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { selectionColumn } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of certificate assignments" — the
// generic (certificate → object) intent rows. Two surfaces read the same list
// from opposite ends: a certificate's "Assignments" tab (omit "certificate")
// and an object's "Certificates" section (omit "object"/"type"). Both build here
// so the rows read identically instead of drifting apart in two inline arrays.
//
// An assignment has no detail page of its own; the row's links point at the
// object it attaches to and the certificate it declares.

export type CertificateAssignmentColumnId =
  | "certificate"
  | "object"
  | "type"
  | "notes"
  | "updated"

const CANONICAL_ORDER: CertificateAssignmentColumnId[] = [
  "certificate",
  "object",
  "type",
  "notes",
  "updated",
]

export interface CertificateAssignmentColumnOpts<
  T extends CertificateAssignment = CertificateAssignment,
> {
  /** Drop columns (a cert's own tab omits "certificate"). */
  omit?: CertificateAssignmentColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: CertificateAssignmentColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column (the unassign affordance). */
  actions?: ActionsColumnOpts<T>
}

export function buildCertificateAssignmentColumns<
  T extends CertificateAssignment = CertificateAssignment,
>(opts: CertificateAssignmentColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: CertificateAssignmentColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<
    CertificateAssignmentColumnId,
    () => ColumnDef<T, unknown>
  > = {
    certificate: () => ({
      id: "certificate",
      accessorFn: (a) => a.certificate_subject_cn ?? a.certificate_fingerprint,
      header: "Certificate",
      cell: ({ row }) => (
        <Link
          to="/certificates/$id"
          params={{ id: row.original.certificate }}
          className="font-medium hover:underline"
        >
          {row.original.certificate_subject_cn ||
            `${(row.original.certificate_fingerprint ?? "").slice(0, 16)}…`}
        </Link>
      ),
    }),
    object: () => ({
      id: "object",
      header: "Object",
      enableSorting: false,
      // The server resolves the generic (object_type, object_id) pair to a
      // human label (an IP's address, a device's name) and a short context (an
      // IP's VRF, a device's site), so the row reads without a per-row fetch.
      // Falls back to the short id for a target that no longer resolves.
      cell: ({ row }) => {
        const t = CERTIFICATE_OBJECT_TYPES[row.original.object_type]
        const label =
          row.original.object_label || row.original.object_id.slice(0, 8)
        const context = row.original.object_context
        const inner = t?.route ? (
          <Link
            to={t.route}
            params={{ id: row.original.object_id }}
            className="font-medium hover:underline"
          >
            {label}
          </Link>
        ) : (
          <span className="font-medium">{label}</span>
        )
        return (
          <span className="flex items-baseline gap-1.5">
            {inner}
            {context && (
              <span className="text-xs text-muted-foreground">{context}</span>
            )}
          </span>
        )
      },
    }),
    type: () => ({
      id: "type",
      accessorFn: (a) => certificateObjectLabel(a.object_type),
      header: "Type",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {certificateObjectLabel(row.original.object_type)}
        </span>
      ),
    }),
    notes: () => ({
      id: "notes",
      accessorFn: (a) => a.notes,
      header: "Notes",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.notes ? (
          <span className="text-xs">{row.original.notes}</span>
        ) : (
          dash
        ),
    }),
    updated: () =>
      timeAgoColumn<T>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
