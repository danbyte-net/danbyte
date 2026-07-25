import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ComplianceViolation, VLAN } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { siteColumn } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of VLANs". Every surface that lists
// VLANs — /vlans, the Site / VLAN group / Zone detail panes, the compliance
// affected-objects table — builds its columns here so a VLAN row reads
// identically everywhere. Page-specific columns are spliced around this
// factory's output; the shared cells are never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.

export type VlanColumnId =
  | "numid"
  | "vlan_id"
  | "name"
  | "site"
  | "group"
  | "zone"
  | "prefixes"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: VlanColumnId[] = [
  "numid",
  "vlan_id",
  "name",
  "site",
  "group",
  "zone",
  "prefixes",
  "description",
  "tags",
  "updated",
]

export interface VlanColumnOpts<T extends VLAN = VLAN> {
  /** Drop columns (e.g. the Site page omits "site"). */
  omit?: VlanColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: VlanColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Header for the VID column: "VLAN" on general lists, "VID" where the
   * surrounding page is already about VLANs (the VLAN group detail pane). */
  vidHeader?: string
  /** Compliance violation badge next to the name. Pass a pre-resolved map to
   * avoid one lookup hook per row; `true` lets each badge subscribe itself. */
  violations?: boolean | Map<string, ComplianceViolation[]>
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildVlanColumns<T extends VLAN = VLAN>(
  opts: VlanColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: VlanColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<VlanColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    vlan_id: () => ({
      id: "vlan_id",
      accessorKey: "vlan_id",
      header: ({ column }) => (
        <SortHeader column={column} label={opts.vidHeader ?? "VLAN"} />
      ),
      cell: ({ row }) => (
        <Link
          to="/vlans/$id"
          params={{ id: row.original.id }}
          className="num font-mono text-xs font-medium hover:underline"
        >
          {row.original.vlan_id}
        </Link>
      ),
      meta: {
        facet: {
          kind: "range",
          label: "VLAN ID",
          get: (r: T) => r.vlan_id,
          min: 1,
          max: 4094,
          placeholder: { min: "1", max: "4094" },
        },
      },
    }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/vlans/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          {opts.violations && (
            <ViolationBadge
              objectId={row.original.id}
              map={opts.violations === true ? undefined : opts.violations}
            />
          )}
        </span>
      ),
    }),
    site: () => siteColumn<T>({ get: (r) => r.site }),
    group: () => ({
      id: "group",
      accessorFn: (r) => r.group?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Group" />,
      cell: ({ row }) => {
        const g = row.original.group
        return g ? (
          <Link
            to="/vlan-groups/$id"
            params={{ id: g.id }}
            className="hover:underline"
          >
            {g.name}
          </Link>
        ) : (
          dash
        )
      },
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
    zone: () => ({
      id: "zone",
      accessorFn: (r) => r.zone?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Zone" />,
      cell: ({ row }) =>
        row.original.zone ? (
          <ColorBadge
            name={row.original.zone.name}
            color={row.original.zone.color || undefined}
          />
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Zone",
          get: (r: T) => r.zone?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.zone?.name ?? "No zone",
          }),
        },
      },
    }),
    prefixes: () => ({
      id: "prefixes",
      accessorKey: "prefix_count",
      header: ({ column }) => <SortHeader column={column} label="Prefixes" />,
      cell: ({ row }) =>
        row.original.prefix_count > 0 ? (
          <span className="num text-xs">{row.original.prefix_count}</span>
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
