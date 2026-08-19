import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ComplianceViolation, VRF } from "@/lib/api"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { dash } from "@/components/cells/dash"
import { countCell } from "@/components/cells/count-cell"
import type { ZeroCounts } from "@/components/cells/count-cell"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of VRFs". Every surface that lists
// VRFs - /vrfs, the route-target detail pane, the compliance affected-objects
// table - builds its columns here so a VRF row reads identically everywhere.
// Page-specific columns (the route target's import/export direction) are
// spliced around this factory's output; the shared cells are never re-authored
// inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.

export type VrfColumnId =
  | "numid"
  | "name"
  | "rd"
  | "import_targets"
  | "export_targets"
  | "prefixes"
  | "ips"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: VrfColumnId[] = [
  "numid",
  "name",
  "rd",
  "import_targets",
  "export_targets",
  "prefixes",
  "ips",
  "description",
  "tags",
  "updated",
]

export interface VrfColumnOpts<T extends VRF = VRF> {
  /** Drop columns. */
  omit?: VrfColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: VrfColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Header for the name column: "Name" on general lists, "VRF" where the
   * surrounding page is about something else (the route-target detail pane). */
  nameHeader?: string
  /** Columns whose header stays plain text instead of a sortable SortHeader -
   * the embedded / read-only tables never offered sorting on them. */
  plainHeaders?: VrfColumnId[]
  /** Count columns render `-` for zero (the list page, which also facets on
   * "has prefixes") or print the 0 (embedded and read-only tables). */
  zeroCounts?: ZeroCounts
  /** Compliance violation badge next to the name. Pass a pre-resolved map to
   * avoid one lookup hook per row; `true` lets each badge subscribe itself. */
  violations?: boolean | Map<string, ComplianceViolation[]>
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

/** The import/export route targets of one VRF, as monospace chips. */
function RtCell({ rts }: { rts: VRF["import_targets"] }) {
  if (rts.length === 0) return dash
  return (
    <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
      {rts.map((rt) => (
        <span
          key={rt.id}
          className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
        >
          {rt.name}
        </span>
      ))}
    </div>
  )
}

export function buildVrfColumns<T extends VRF = VRF>(
  opts: VrfColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: VrfColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const plain = new Set(opts.plainHeaders ?? [])
  const head = (
    id: VrfColumnId,
    label: string
  ): ColumnDef<T, unknown>["header"] =>
    plain.has(id)
      ? label
      : ({ column }) => <SortHeader column={column} label={label} />

  const count = (n: number) => countCell(n, opts.zeroCounts)

  const byId: Record<VrfColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: head("name", opts.nameHeader ?? "Name"),
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/vrfs/$id"
            params={{ id: row.original.id }}
            className="hover:opacity-90"
          >
            <ColorBadge
              name={row.original.name}
              color={row.original.color || undefined}
            />
          </Link>
          {opts.violations && (
            <ViolationBadge
              objectId={row.original.id}
              map={opts.violations === true ? undefined : opts.violations}
            />
          )}
          <PlannedChangeMarker
            objectType="api.vrf"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    rd: () => ({
      id: "rd",
      accessorKey: "rd",
      header: head("rd", "RD"),
      cell: ({ row }) =>
        row.original.rd ? (
          <span className="font-mono text-xs">{row.original.rd}</span>
        ) : (
          dash
        ),
    }),
    import_targets: () => ({
      id: "import_targets",
      header: "Import",
      enableSorting: false,
      cell: ({ row }) => <RtCell rts={row.original.import_targets} />,
    }),
    export_targets: () => ({
      id: "export_targets",
      header: "Export",
      enableSorting: false,
      cell: ({ row }) => <RtCell rts={row.original.export_targets} />,
    }),
    prefixes: () => ({
      id: "prefixes",
      accessorKey: "prefix_count",
      header: head("prefixes", "Prefixes"),
      cell: ({ row }) => count(row.original.prefix_count),
    }),
    ips: () => ({
      id: "ips",
      accessorKey: "ip_count",
      header: head("ips", "IPs"),
      cell: ({ row }) => count(row.original.ip_count),
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
