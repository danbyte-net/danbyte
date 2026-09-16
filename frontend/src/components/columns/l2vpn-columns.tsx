import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { L2VPN } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of L2VPNs": the /l2vpns list and the
// L2VPNs pane on a VLAN build their columns here. A VLAN page omits
// "terminations" - the VLAN you are looking at is one of them.

export type L2VPNColumnId =
  | "numid"
  | "name"
  | "type"
  | "identifier"
  | "vrf"
  | "status"
  | "terminations"
  | "vteps"
  | "import_targets"
  | "export_targets"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: L2VPNColumnId[] = [
  "numid",
  "name",
  "type",
  "identifier",
  "vrf",
  "status",
  "terminations",
  "vteps",
  "import_targets",
  "export_targets",
  "description",
  "tags",
  "updated",
]

export interface L2VPNColumnOpts<T extends L2VPN = L2VPN> {
  omit?: L2VPNColumnId[]
  include?: L2VPNColumnId[]
  selection?: boolean
  humanIds?: boolean
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  actions?: ActionsColumnOpts<T>
}

/** Import/export route-target names as muted text, or a dash. */
function RtCell({ rts }: { rts: { id: string; name: string }[] }) {
  if (rts.length === 0) return dash
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      {rts.map((rt) => rt.name).join(", ")}
    </span>
  )
}

function countCell(n: number) {
  return n > 0 ? <span className="num text-xs">{n}</span> : dash
}

export function buildL2VPNColumns<T extends L2VPN = L2VPN>(
  opts: L2VPNColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: L2VPNColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<L2VPNColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/l2vpns/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.name}
        </Link>
      ),
    }),
    type: () => ({
      id: "type",
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => (
        <Badge variant="secondary">{row.original.type_display}</Badge>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: T) => r.type,
          formatValue: (_v, sample) => ({ label: sample.type_display }),
        },
      },
    }),
    identifier: () => ({
      id: "identifier",
      accessorKey: "identifier",
      header: ({ column }) => <SortHeader column={column} label="ID" />,
      cell: ({ row }) =>
        row.original.identifier != null ? (
          <span className="num font-mono text-xs">
            {row.original.identifier}
          </span>
        ) : (
          dash
        ),
    }),
    vrf: () => ({
      id: "vrf",
      accessorFn: (r) => r.vrf?.name ?? "",
      header: "VRF",
      cell: ({ row }) =>
        row.original.vrf ? (
          <Link
            to="/vrfs/$id"
            params={{ id: row.original.vrf.id }}
            className="inline-flex"
          >
            <ColorBadge
              name={row.original.vrf.name}
              color={row.original.vrf.color}
            />
          </Link>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "VRF",
          get: (r: T) => r.vrf?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.vrf?.name ?? "None",
            color: sample.vrf?.color,
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
    terminations: () => ({
      id: "terminations",
      accessorKey: "termination_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Terminations" />
      ),
      cell: ({ row }) => countCell(row.original.termination_count),
    }),
    vteps: () => ({
      id: "vteps",
      accessorKey: "vtep_count",
      header: ({ column }) => <SortHeader column={column} label="VTEPs" />,
      cell: ({ row }) => countCell(row.original.vtep_count),
    }),
    import_targets: () => ({
      id: "import_targets",
      accessorFn: (r) => r.import_targets.map((t) => t.name).join(", "),
      header: "Import RTs",
      cell: ({ row }) => <RtCell rts={row.original.import_targets} />,
    }),
    export_targets: () => ({
      id: "export_targets",
      accessorFn: (r) => r.export_targets.map((t) => t.name).join(", "),
      header: "Export RTs",
      cell: ({ row }) => <RtCell rts={row.original.export_targets} />,
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
