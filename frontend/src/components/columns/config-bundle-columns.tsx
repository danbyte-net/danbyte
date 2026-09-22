import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ConfigBundle } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of config bundles". The list page and
// any embedded bundle table build their columns here so a bundle row reads
// identically everywhere.

export type ConfigBundleColumnId =
  | "numid"
  | "name"
  | "files"
  | "roles"
  | "description"
  | "updated"

const CANONICAL_ORDER: ConfigBundleColumnId[] = [
  "numid",
  "name",
  "files",
  "roles",
  "description",
  "updated",
]

export interface ConfigBundleColumnOpts<T extends ConfigBundle = ConfigBundle> {
  /** Drop columns. */
  omit?: ConfigBundleColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: ConfigBundleColumnId[]
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildConfigBundleColumns<T extends ConfigBundle = ConfigBundle>(
  opts: ConfigBundleColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: ConfigBundleColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<ConfigBundleColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/config-bundles/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.configbundle"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    files: () => ({
      id: "files",
      accessorFn: (r) => r.templates.length,
      header: ({ column }) => <SortHeader column={column} label="Files" />,
      cell: ({ row }) => {
        const paths = row.original.templates.map((t) => t.bundle_path)
        return paths.length ? (
          <span className="inline-flex min-w-0 items-baseline gap-2">
            <span className="num text-xs">{paths.length}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {paths.join("  ")}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )
      },
    }),
    roles: () => ({
      id: "roles",
      accessorFn: (r) => r.roles.map((x) => x.name).join(", "),
      header: "Roles",
      cell: ({ row }) =>
        row.original.roles.length ? (
          <span className="flex flex-wrap gap-1">
            {row.original.roles.map((role) => (
              <Link
                key={role.id}
                to="/device-roles/$id"
                params={{ id: role.id }}
                className="hover:opacity-90"
              >
                <ColorBadge name={role.name} color={role.color} />
              </Link>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
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
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
