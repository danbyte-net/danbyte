import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { PowerPanel } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { locationColumn } from "@/components/cells/location-cell"
import { numidColumn } from "@/components/cells/numid"
import { siteColumn } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of power panels", as
// power-feed-columns is for feeds: the /power-panels list builds its columns
// here, and so does any other table of panels.

export type PowerPanelColumnId =
  "numid" | "name" | "site" | "location" | "feeds" | "comments" | "tags"

const CANONICAL_ORDER: PowerPanelColumnId[] = [
  "numid",
  "name",
  "site",
  "location",
  "feeds",
  "comments",
  "tags",
]

export interface PowerPanelColumnOpts<T extends PowerPanel = PowerPanel> {
  /** Drop columns (e.g. a site's own page omits "site"). */
  omit?: PowerPanelColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: PowerPanelColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildPowerPanelColumns<T extends PowerPanel = PowerPanel>(
  opts: PowerPanelColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: PowerPanelColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<PowerPanelColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/power-panels/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.name}
        </Link>
      ),
    }),
    site: () => siteColumn<T>({ get: (r) => r.site, className: "text-xs" }),
    location: () =>
      locationColumn<T>({ get: (r) => r.location, className: "text-xs" }),
    feeds: () => ({
      id: "feeds",
      accessorKey: "feed_count",
      header: ({ column }) => <SortHeader column={column} label="Feeds" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.feed_count}</span>
      ),
    }),
    comments: () => ({
      id: "comments",
      accessorKey: "comments",
      header: "Comments",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.comments || "-"}
        </span>
      ),
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
