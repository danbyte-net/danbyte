import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ContactGroup } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of contact groups". The /contact-groups
// list and the Child groups pane on a group's own detail page both build their
// columns here, so a group row reads identically in both places.
//
// ContactGroup self-nests, so the "parent" column is what makes the hierarchy
// legible on the flat list — and exactly the column a parent's own page omits.

export type ContactGroupColumnId =
  | "numid"
  | "name"
  | "parent"
  | "description"
  | "contacts"
  | "children"
  | "updated"

const CANONICAL_ORDER: ContactGroupColumnId[] = [
  "numid",
  "name",
  "parent",
  "description",
  "contacts",
  "children",
  "updated",
]

export interface ContactGroupColumnOpts<T extends ContactGroup = ContactGroup> {
  /** Drop columns (e.g. a parent's own page omits "parent"). */
  omit?: ContactGroupColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: ContactGroupColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildContactGroupColumns<T extends ContactGroup = ContactGroup>(
  opts: ContactGroupColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: ContactGroupColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<ContactGroupColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/contact-groups/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    }),
    parent: () => ({
      id: "parent",
      accessorFn: (g) => g.parent?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Parent" />,
      cell: ({ row }) =>
        row.original.parent ? (
          <Link
            to="/contact-groups/$id"
            params={{ id: row.original.parent.id }}
            className="text-xs hover:underline"
          >
            {row.original.parent.name}
          </Link>
        ) : (
          dash
        ),
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    }),
    contacts: () => ({
      id: "contacts",
      accessorKey: "contact_count",
      header: ({ column }) => <SortHeader column={column} label="Contacts" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.contact_count}</span>
      ),
    }),
    children: () => ({
      id: "children",
      accessorKey: "child_count",
      header: ({ column }) => <SortHeader column={column} label="Subgroups" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.child_count}</span>
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
