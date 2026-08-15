import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Rack } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { SiteCell, siteColumn } from "@/components/cells/site-cell"
import type { SiteVariant } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of racks". Every surface that lists
// racks — /racks and the embedded rack pane on a location / rack-role / site
// detail page — builds its columns here so a rack row reads identically
// everywhere. Page-specific columns are spliced around this factory's output;
// the shared cells are never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.
//
// "height"/"devices"/"utilisation" are the list page's capacity trio;
// "width"/"used" are the compact pair the embedded pane shows instead. Both
// live here so either surface can ask for what it needs.

export type RackColumnId =
  | "numid"
  | "name"
  | "site"
  | "role"
  | "status"
  | "height"
  | "width"
  | "devices"
  | "utilisation"
  | "used"
  | "tags"
  | "description"
  | "updated"

const CANONICAL_ORDER: RackColumnId[] = [
  "numid",
  "name",
  "site",
  "role",
  "status",
  "height",
  "width",
  "devices",
  "utilisation",
  "used",
  "tags",
  "description",
  "updated",
]

export interface RackColumnOpts<T extends Rack = Rack> {
  /** Drop columns (e.g. the list omits the embedded pane's "width"/"used"). */
  omit?: RackColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: RackColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Site rendering — see {@link SiteVariant}. Defaults to "link". */
  siteVariant?: SiteVariant
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

/** Rack occupancy: a thin bar plus the raw "used/height" U counts. Rack's own
 * cell — the shared `UtilCell` prints a percentage instead. */
function RackUtilCell({ rack }: { rack: Rack }) {
  const pct = rack.u_height
    ? Math.round((rack.used_units / rack.u_height) * 100)
    : 0
  const tone =
    pct > 95 ? "bg-red-500" : pct > 80 ? "bg-amber-500" : "bg-emerald-500"
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={tone}
          style={{ width: `${Math.min(100, pct)}%`, height: "100%" }}
        />
      </div>
      <span className="num text-[11px] text-muted-foreground">
        {rack.used_units}/{rack.u_height}
      </span>
    </div>
  )
}

export function buildRackColumns<T extends Rack = Rack>(
  opts: RackColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: RackColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<RackColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/racks/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.rack"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    site: () =>
      opts.siteVariant === "plain"
        ? {
            id: "site",
            accessorFn: (r) => r.site.name,
            header: "Site",
            cell: ({ row }) => (
              <SiteCell
                site={row.original.site}
                linked={false}
                className="text-xs text-muted-foreground"
              />
            ),
          }
        : siteColumn<T>({ get: (r) => r.site, className: "text-xs" }),
    role: () => ({
      id: "role",
      header: ({ column }) => <SortHeader column={column} label="Role" />,
      accessorFn: (r) => r.role?.name ?? "",
      cell: ({ row }) =>
        row.original.role ? (
          <ColorBadge
            name={row.original.role.name}
            color={row.original.role.color || undefined}
          />
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Role",
          get: (r: T) => r.role?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.role?.name ?? "No role",
            color: r.role?.color,
          }),
        },
      },
    }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
          }),
        },
      },
    }),
    height: () => ({
      id: "height",
      accessorKey: "u_height",
      header: ({ column }) => <SortHeader column={column} label="Height" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.u_height}U</span>
      ),
    }),
    width: () => ({
      id: "width",
      header: "Width",
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.width}″</span>
      ),
    }),
    devices: () => ({
      id: "devices",
      accessorKey: "device_count",
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) =>
        row.original.device_count > 0 ? (
          <span className="num text-xs">{row.original.device_count}</span>
        ) : (
          dash
        ),
    }),
    utilisation: () => ({
      id: "utilisation",
      header: ({ column }) => <SortHeader column={column} label="Used" />,
      accessorFn: (r) => (r.u_height ? r.used_units / r.u_height : 0),
      cell: ({ row }) => <RackUtilCell rack={row.original} />,
    }),
    used: () => ({
      id: "used",
      header: ({ column }) => <SortHeader column={column} label="Used" />,
      accessorFn: (r) => r.used_units,
      cell: ({ row }) => (
        <span className="num text-xs">
          {row.original.used_units} / {row.original.u_height} U
        </span>
      ),
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
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
