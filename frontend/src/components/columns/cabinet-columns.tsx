import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { Cabinet } from "@/lib/api"
import { cabinetTypeLabel, outerSize, plateSize } from "@/lib/cabinets"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { locationColumn } from "@/components/cells/location-cell"
import { SiteCell, siteColumn } from "@/components/cells/site-cell"
import type { SiteVariant } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of cabinets". /cabinets and the
// embedded cabinet pane on a site / location / cabinet-type / cabinet-role
// page build their columns here, so a cabinet row reads the same everywhere.
// Page-specific columns are spliced around this factory's output; the shared
// cells are never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.

export type CabinetColumnId =
  | "numid"
  | "name"
  | "site"
  | "location"
  | "role"
  | "type"
  | "status"
  | "facility"
  | "size"
  | "plate"
  | "rails"
  | "tags"
  | "description"
  | "updated"

const CANONICAL_ORDER: CabinetColumnId[] = [
  "numid",
  "name",
  "site",
  "location",
  "role",
  "type",
  "status",
  "facility",
  "size",
  "plate",
  "rails",
  "tags",
  "description",
  "updated",
]

export interface CabinetColumnOpts<T extends Cabinet = Cabinet> {
  /** Drop columns (e.g. "site" on a site's own page). */
  omit?: CabinetColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: CabinetColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Site rendering - see {@link SiteVariant}. Defaults to "link". */
  siteVariant?: SiteVariant
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildCabinetColumns<T extends Cabinet = Cabinet>(
  opts: CabinetColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: CabinetColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<CabinetColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/cabinets/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.cabinet"
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
    location: () =>
      locationColumn<T>({ get: (r) => r.location, className: "text-xs" }),
    role: () => ({
      id: "role",
      header: ({ column }) => <SortHeader column={column} label="Role" />,
      accessorFn: (r) => r.role?.name ?? "",
      cell: ({ row }) =>
        row.original.role ? (
          <Link
            to="/cabinet-roles/$id"
            params={{ id: row.original.role.id }}
            className="link"
          >
            <ColorBadge
              name={row.original.role.name}
              color={row.original.role.color || undefined}
            />
          </Link>
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
    type: () => ({
      id: "type",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      accessorFn: (r) =>
        r.cabinet_type ? cabinetTypeLabel(r.cabinet_type) : "",
      cell: ({ row }) =>
        row.original.cabinet_type ? (
          <Link
            to="/cabinet-types/$id"
            params={{ id: row.original.cabinet_type.id }}
            className="link text-xs"
          >
            {cabinetTypeLabel(row.original.cabinet_type)}
          </Link>
        ) : (
          dash
        ),
      meta: {
        field: "cabinet_type",
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: T) => r.cabinet_type?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.cabinet_type
              ? cabinetTypeLabel(r.cabinet_type)
              : "No type",
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
    facility: () => ({
      id: "facility",
      accessorKey: "facility_id",
      header: ({ column }) => (
        <SortHeader column={column} label="Facility ID" />
      ),
      cell: ({ row }) =>
        row.original.facility_id ? (
          <span className="font-mono text-xs">{row.original.facility_id}</span>
        ) : (
          dash
        ),
    }),
    // The box, W×H×D - "600×700×210 mm", the way enclosure datasheets give it.
    size: () => ({
      id: "size",
      header: ({ column }) => <SortHeader column={column} label="Size" />,
      accessorFn: (r) => r.outer_width_mm ?? 0,
      cell: ({ row }) => {
        const size = outerSize(row.original)
        return size ? <span className="num text-xs">{size}</span> : dash
      },
      meta: {
        field: ["outer_width_mm", "outer_height_mm", "outer_depth_mm"],
        export: { value: (r: T) => outerSize(r) ?? "" },
      },
    }),
    // The mounting plate the rails sit on, W×H.
    plate: () => ({
      id: "plate",
      header: ({ column }) => <SortHeader column={column} label="Plate" />,
      accessorFn: (r) => r.inner_width_mm * r.inner_height_mm,
      cell: ({ row }) => (
        <span className="num text-xs">{plateSize(row.original)}</span>
      ),
      meta: {
        field: ["inner_width_mm", "inner_height_mm"],
        export: { value: (r: T) => plateSize(r) },
      },
    }),
    // How many DIN rails the plate carries.
    rails: () => ({
      id: "rails",
      header: ({ column }) => <SortHeader column={column} label="Rails" />,
      accessorFn: (r) => r.rails.length,
      cell: ({ row }) =>
        row.original.rails.length > 0 ? (
          <span className="num text-xs">{row.original.rails.length}</span>
        ) : (
          dash
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
