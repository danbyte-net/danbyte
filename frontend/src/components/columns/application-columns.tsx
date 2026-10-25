import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Application } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of applications" (#436). The tree
// reads as the path: "Payments › Checkout ›" muted before the name, and the
// name column sorts by the path so children follow their parent.

export type ApplicationColumnId =
  | "numid"
  | "name"
  | "parent"
  | "manufacturer"
  | "installs"
  | "flows"
  | "children"
  | "eol"
  | "description"
  | "updated"

const CANONICAL_ORDER: ApplicationColumnId[] = [
  "numid",
  "name",
  "parent",
  "manufacturer",
  "installs",
  "flows",
  "children",
  "eol",
  "description",
  "updated",
]

export interface ApplicationColumnOpts<T extends Application = Application> {
  omit?: ApplicationColumnId[]
  include?: ApplicationColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

/** "Payments › Checkout" - the ancestors of a path, without the name. */
export function applicationAncestors(path: string, name: string): string {
  const parts = path.split(" › ")
  if (parts.length < 2 || parts[parts.length - 1] !== name) return ""
  return parts.slice(0, -1).join(" › ")
}

export function buildApplicationColumns<T extends Application = Application>(
  opts: ApplicationColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: ApplicationColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<ApplicationColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid ?? null }),
    name: () => ({
      id: "name",
      accessorFn: (r) => r.path || r.name,
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => {
        const a = row.original
        const above = applicationAncestors(a.path, a.name)
        return (
          <span className="whitespace-nowrap">
            {above && <span className="text-muted-foreground">{above} › </span>}
            <Link
              to="/applications/$id"
              params={{ id: a.id }}
              className="link font-medium"
            >
              {a.name}
            </Link>
          </span>
        )
      },
      meta: { export: { value: (r: T) => r.path || r.name } },
    }),
    parent: () => ({
      id: "parent",
      accessorFn: (r) => r.parent?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Parent" />,
      cell: ({ row }) =>
        row.original.parent ? (
          <Link
            to="/applications/$id"
            params={{ id: row.original.parent.id }}
            className="link"
          >
            {row.original.parent.name}
          </Link>
        ) : (
          dash
        ),
      meta: {
        label: "Parent",
        defaultHidden: true,
        facet: {
          kind: "enum",
          label: "Parent",
          get: (r: T) => r.parent?.id ?? "__none__",
          formatValue: (_v, r) => ({ label: r.parent?.name ?? "No parent" }),
        },
      },
    }),
    manufacturer: () => ({
      id: "manufacturer",
      accessorFn: (r) => r.manufacturer?.name ?? "",
      header: ({ column }) => (
        <SortHeader column={column} label="Manufacturer" />
      ),
      cell: ({ row }) =>
        row.original.manufacturer ? (
          <Link
            to="/manufacturers/$id"
            params={{ id: row.original.manufacturer.id }}
            className="link"
          >
            {row.original.manufacturer.name}
          </Link>
        ) : (
          dash
        ),
      meta: {
        label: "Manufacturer",
        defaultHidden: true,
        facet: {
          kind: "enum",
          label: "Manufacturer",
          get: (r: T) => r.manufacturer?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.manufacturer?.name ?? "No manufacturer",
          }),
        },
      },
    }),
    installs: () => ({
      id: "installs",
      accessorKey: "install_count",
      header: ({ column }) => <SortHeader column={column} label="Installs" />,
      cell: ({ row }) => (
        <span className="num">{row.original.install_count}</span>
      ),
    }),
    flows: () => ({
      id: "flows",
      accessorKey: "flow_count",
      header: ({ column }) => <SortHeader column={column} label="Flows" />,
      cell: ({ row }) => <span className="num">{row.original.flow_count}</span>,
    }),
    children: () => ({
      id: "children",
      accessorKey: "child_count",
      header: ({ column }) => <SortHeader column={column} label="Children" />,
      cell: ({ row }) => (
        <span className="num">{row.original.child_count}</span>
      ),
      meta: { label: "Children", defaultHidden: true },
    }),
    eol: () => ({
      id: "eol",
      accessorFn: (r) => r.eol_product,
      header: ({ column }) => (
        <SortHeader column={column} label="End-of-life product" />
      ),
      cell: ({ row }) =>
        row.original.eol_product ? (
          <span className="font-mono text-xs">{row.original.eol_product}</span>
        ) : (
          dash
        ),
      meta: { label: "End-of-life product", defaultHidden: true },
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
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
