import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { FloorPlanLinkKind, FloorPlanTile } from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { dash } from "@/components/cells/dash"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { selectionColumn } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of placed floor-plan tiles" — the flat,
// tabular read of what the canvas draws. A tile has no detail page of its own
// (it is a cell on a plan), so the row links out to the plan it sits on and to
// whatever object it is linked to. Built for the floor-tile-type detail page's
// "Placed" tab ("where is this type actually used, before I edit or delete
// it"); any future tile pane must build here rather than inline a second copy.
//
// Facet meta (useTableFilters) is attached where it makes sense; panes that
// don't draw a facet rail simply ignore it.

/** The SPA detail route for each link kind a tile can point at. */
const LINK_ROUTES: Record<FloorPlanLinkKind, string> = {
  rack: "/racks/$id",
  device: "/devices/$id",
  powerpanel: "/power-panels/$id",
  powerfeed: "/power-feeds/$id",
  floorplan: "/floorplans/$id",
}

/** A tile's own type badge: exactly one of a floor tile type or a device role
 * (the model enforces it), both of which carry a name + colour. */
export function tileTypeName(t: FloorPlanTile): string {
  return t.tile_type?.name ?? t.role_type?.name ?? ""
}

export type FloorTileColumnId =
  | "plan"
  | "position"
  | "size"
  | "label"
  | "type"
  | "status"
  | "link"
  | "updated"

const CANONICAL_ORDER: FloorTileColumnId[] = [
  "plan",
  "position",
  "size",
  "label",
  "type",
  "status",
  "link",
  "updated",
]

export interface FloorTileColumnOpts<T extends FloorPlanTile = FloorPlanTile> {
  /** Drop columns (e.g. a tile type's own page omits "type"). */
  omit?: FloorTileColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: FloorTileColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildFloorTileColumns<T extends FloorPlanTile = FloorPlanTile>(
  opts: FloorTileColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: FloorTileColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<FloorTileColumnId, () => ColumnDef<T, unknown>> = {
    plan: () => ({
      id: "plan",
      accessorFn: (t) => t.floor_plan?.name ?? "",
      header: "Floor plan",
      cell: ({ row }) => {
        const plan = row.original.floor_plan
        return plan ? (
          <Link
            to="/floorplans/$id"
            params={{ id: plan.id }}
            className="font-medium hover:underline"
          >
            {plan.name}
          </Link>
        ) : (
          dash
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Floor plan",
          get: (r: T) => r.floor_plan?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.floor_plan?.name ?? "No plan",
          }),
        },
      },
    }),
    position: () => ({
      id: "position",
      // Sort by row then column — reading order on the grid, which is what the
      // canvas orders by too.
      accessorFn: (t) => t.y * 1000 + t.x,
      header: "Cell",
      cell: ({ row }) => (
        <span className="num text-xs">
          {row.original.x}, {row.original.y}
        </span>
      ),
    }),
    size: () => ({
      id: "size",
      accessorFn: (t) => t.width * t.height,
      header: "Size",
      cell: ({ row }) => (
        <span className="num text-xs">
          {row.original.width} × {row.original.height}
        </span>
      ),
    }),
    label: () => ({
      id: "label",
      accessorKey: "label",
      header: "Label",
      cell: ({ row }) =>
        row.original.label ? (
          <span className="line-clamp-1 block">{row.original.label}</span>
        ) : (
          dash
        ),
    }),
    type: () => ({
      id: "type",
      accessorFn: (t) => tileTypeName(t),
      header: "Type",
      cell: ({ row }) => {
        const t = row.original.tile_type ?? row.original.role_type
        return t ? <ColorBadge name={t.name} color={t.color} /> : dash
      },
    }),
    status: () => ({
      id: "status",
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.status ? (
          <span className="text-xs capitalize">{row.original.status}</span>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => r.status || "__none__",
          formatValue: (_v, sample) => ({
            label: sample.status || "No status",
          }),
        },
      },
    }),
    link: () => ({
      id: "link",
      accessorFn: (t) => t.linked?.name ?? "",
      header: "Linked to",
      enableSorting: false,
      // A tile's behaviour comes from what it links to, not what its type is
      // called — so this is the column that answers "is this tile doing
      // anything".
      cell: ({ row }) => {
        const l = row.original.linked
        if (!l) return dash
        return (
          <Link
            to={LINK_ROUTES[l.kind]}
            params={{ id: l.id }}
            className="text-xs hover:underline"
          >
            {l.name}
          </Link>
        )
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
