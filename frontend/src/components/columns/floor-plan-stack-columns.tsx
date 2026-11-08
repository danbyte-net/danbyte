import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { FloorPlanStack } from "@/lib/api"
import { WHOLE_SITE } from "@/lib/floor-plan-scope"
import { entryFloor } from "@/lib/floor-plan-stacks"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { locationColumn } from "@/components/cells/location-cell"
import { siteColumn } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of floor plans". A row is a floor plan
// as users see it (a FloorPlanStack: a building or hall); its name opens the
// floor last viewed in it in this browser, or its first floor.

export type FloorPlanStackColumnId =
  "name" | "floors" | "location" | "site" | "tags" | "description" | "updated"

const CANONICAL_ORDER: FloorPlanStackColumnId[] = [
  "name",
  "floors",
  "location",
  "site",
  "tags",
  "description",
  "updated",
]

export interface FloorPlanStackColumnOpts<
  T extends FloorPlanStack = FloorPlanStack,
> {
  omit?: FloorPlanStackColumnId[]
  include?: FloorPlanStackColumnId[]
  selection?: boolean
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  actions?: ActionsColumnOpts<T>
}

/** "View of <source>" when every floor of the stack is a live view (a
 * snapshot made as a floor plan of its own). */
export function stackViewOf(stack: FloorPlanStack): string | null {
  const floors = stack.floors
  if (!floors.length || !floors.every((f) => f.kind === "view")) return null
  return `View of ${floors[0].view_of?.name ?? "a deleted plan"}`
}

/** The name, linking to the floor the stack opens on. */
function StackName({ stack }: { stack: FloorPlanStack }) {
  const floor = entryFloor(stack)
  const viewOf = stackViewOf(stack)
  const link = !floor ? (
    <Link
      to="/floorplans/stacks/$id"
      params={{ id: stack.id }}
      className="link font-medium"
    >
      {stack.name}
    </Link>
  ) : (
    <Link
      to="/floorplans/$id"
      params={{ id: floor }}
      className="link font-medium"
    >
      {stack.name}
    </Link>
  )
  if (!viewOf) return link
  return (
    <span className="flex min-w-0 items-center gap-2">
      {link}
      <span className="truncate text-xs text-muted-foreground">{viewOf}</span>
    </span>
  )
}

export function buildFloorPlanStackColumns<
  T extends FloorPlanStack = FloorPlanStack,
>(opts: FloorPlanStackColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: FloorPlanStackColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<FloorPlanStackColumnId, () => ColumnDef<T, unknown>> = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => <StackName stack={row.original} />,
    }),
    floors: () => ({
      id: "floors",
      accessorFn: (r) => r.floor_count,
      header: ({ column }) => <SortHeader column={column} label="Floors" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.floor_count}</span>
      ),
      meta: { field: "floor_count" },
    }),
    location: () =>
      locationColumn<T>({
        get: (r) => r.location,
        className: "text-xs",
        emptyLabel: WHOLE_SITE,
      }),
    site: () => siteColumn<T>({ get: (r) => r.site, className: "text-xs" }),
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
      cell: ({ row }) =>
        row.original.description ? (
          <span className="line-clamp-1 block text-muted-foreground">
            {row.original.description}
          </span>
        ) : (
          dash
        ),
    }),
    updated: () =>
      timeAgoColumn<T>({
        id: "updated",
        header: "Last edited",
        get: (r) => r.last_edited ?? r.updated_at,
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
