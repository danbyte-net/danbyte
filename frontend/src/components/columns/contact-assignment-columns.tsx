import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ContactAssignment } from "@/lib/api"
import { CONTACT_OBJECT_TYPES, contactObjectLabel } from "@/lib/contact-objects"
import { dash } from "@/components/cells/dash"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { selectionColumn } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of contact assignments" — the generic
// (contact → object, in a role, at a priority) rows. Two surfaces read the same
// list from opposite ends: a contact's "Attached to" tab (omit "contact") and a
// contact role's "Assignments" tab (omit "role"). Both build here so the rows
// read identically instead of drifting apart in two inline ColumnDef arrays.
//
// An assignment has no detail page of its own; the row's links point at the
// object it attaches to, the contact, and the role.

export type ContactAssignmentColumnId =
  | "contact"
  | "object"
  | "type"
  | "role"
  | "priority"
  | "updated"

const CANONICAL_ORDER: ContactAssignmentColumnId[] = [
  "contact",
  "object",
  "type",
  "role",
  "priority",
  "updated",
]

export interface ContactAssignmentColumnOpts<
  T extends ContactAssignment = ContactAssignment,
> {
  /** Drop columns (a contact's own page omits "contact", a role's "role"). */
  omit?: ContactAssignmentColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: ContactAssignmentColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildContactAssignmentColumns<
  T extends ContactAssignment = ContactAssignment,
>(opts: ContactAssignmentColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: ContactAssignmentColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<ContactAssignmentColumnId, () => ColumnDef<T, unknown>> = {
    contact: () => ({
      id: "contact",
      accessorFn: (a) => a.contact.name,
      header: "Contact",
      cell: ({ row }) => (
        <Link
          to="/contacts/$id"
          params={{ id: row.original.contact.id }}
          className="font-medium hover:underline"
        >
          {row.original.contact.name}
        </Link>
      ),
    }),
    object: () => ({
      id: "object",
      header: "Object",
      enableSorting: false,
      // The target is a generic (object_type, object_id) pair, so there is no
      // name to show without a second fetch per row — the short id is the
      // stable, honest label, and the link resolves it.
      cell: ({ row }) => {
        const t = CONTACT_OBJECT_TYPES[row.original.object_type]
        return t?.route ? (
          <Link
            to={t.route}
            params={{ id: row.original.object_id }}
            className="font-mono font-medium hover:underline"
          >
            {row.original.object_id.slice(0, 8)}
          </Link>
        ) : (
          <span className="font-mono">
            {row.original.object_id.slice(0, 8)}
          </span>
        )
      },
    }),
    type: () => ({
      id: "type",
      accessorFn: (a) => contactObjectLabel(a.object_type),
      header: "Type",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {contactObjectLabel(row.original.object_type)}
        </span>
      ),
    }),
    role: () => ({
      id: "role",
      accessorFn: (a) => a.role?.name ?? "",
      header: "Role",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.role ? (
          <Link
            to="/contact-roles/$id"
            params={{ id: row.original.role.id }}
            className="text-xs hover:underline"
          >
            {row.original.role.name}
          </Link>
        ) : (
          dash
        ),
    }),
    priority: () => ({
      id: "priority",
      accessorKey: "priority",
      header: "Priority",
      cell: ({ row }) => (
        <span className="text-xs capitalize">
          {row.original.priority_display}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Priority",
          get: (r: T) => r.priority,
          formatValue: (_v, sample) => ({ label: sample.priority_display }),
        },
      },
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
