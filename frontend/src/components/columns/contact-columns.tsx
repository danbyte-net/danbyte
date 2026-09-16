import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Contact } from "@/lib/api"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { dash } from "@/components/cells/dash"
import { PhoneLink } from "@/components/cells/phone-link"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of contacts". The /contacts list and
// the Contacts pane on a contact group's detail page both build their columns
// here, so a contact row reads identically in both places. `omit: ["group"]`
// drops the redundant Group column on a group's own page.

export type ContactColumnId =
  | "numid"
  | "name"
  | "title"
  | "email"
  | "phone"
  | "group"
  | "hours"
  | "available"
  | "assignments"
  | "tags"
  | "updated"

const CANONICAL_ORDER: ContactColumnId[] = [
  "numid",
  "name",
  "title",
  "email",
  "phone",
  "group",
  "hours",
  "available",
  "assignments",
  "tags",
  "updated",
]

export interface ContactColumnOpts<T extends Contact = Contact> {
  /** Drop columns (e.g. a group's own page omits "group"). */
  omit?: ContactColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: ContactColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildContactColumns<T extends Contact = Contact>(
  opts: ContactColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: ContactColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<ContactColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/contacts/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.contact"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    title: () => ({
      id: "title",
      accessorKey: "title",
      header: "Title",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.title || "-"}
        </span>
      ),
    }),
    email: () => ({
      id: "email",
      accessorKey: "email",
      header: ({ column }) => <SortHeader column={column} label="Email" />,
      cell: ({ row }) =>
        row.original.email ? (
          <a
            href={`mailto:${row.original.email}`}
            className="link font-mono text-xs"
          >
            {row.original.email}
          </a>
        ) : (
          dash
        ),
    }),
    phone: () => ({
      id: "phone",
      accessorKey: "phone",
      header: "Phone",
      cell: ({ row }) =>
        row.original.phone ? (
          <span className="text-xs">
            <PhoneLink phone={row.original.phone} />
          </span>
        ) : (
          dash
        ),
    }),
    group: () => ({
      id: "group",
      accessorFn: (c) => c.group?.name ?? "",
      header: "Group",
      cell: ({ row }) =>
        row.original.group ? (
          <Link
            to="/contact-groups/$id"
            params={{ id: row.original.group.id }}
            className="link text-xs"
          >
            {row.original.group.name}
          </Link>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Group",
          get: (r: T) => r.group?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.group?.name ?? "No group",
          }),
        },
      },
    }),
    // Both off by default on the list (Columns menu turns them on): the
    // hours string is long and most contacts have none set.
    hours: () => ({
      id: "hours",
      accessorKey: "business_hours_display",
      meta: { label: "Working hours" },
      header: ({ column }) => (
        <SortHeader column={column} label="Working hours" />
      ),
      cell: ({ row }) =>
        row.original.business_hours_display ? (
          <span className="text-xs">{row.original.business_hours_display}</span>
        ) : (
          dash
        ),
    }),
    available: () => ({
      id: "available",
      accessorFn: (r) => (r.open_now === null ? "" : r.open_now ? "1" : "0"),
      header: ({ column }) => <SortHeader column={column} label="Available" />,
      cell: ({ row }) => {
        const v = row.original.open_now
        if (v === null) return dash
        return (
          <Badge variant={v ? "success" : "secondary"}>
            {v ? "Available now" : "Outside hours"}
          </Badge>
        )
      },
    }),
    assignments: () => ({
      id: "assignments",
      accessorKey: "assignment_count",
      header: ({ column }) => <SortHeader column={column} label="Attached" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.assignment_count}</span>
      ),
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
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
