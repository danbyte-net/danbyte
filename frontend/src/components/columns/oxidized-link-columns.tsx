import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { OxidizedNodeLink } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of Oxidized linked nodes" - the
// Linked nodes section of /oxidized builds here.

export type OxidizedLinkColumnId =
  "device" | "node" | "ip" | "model" | "matched_by" | "note" | "seen"

const CANONICAL_ORDER: OxidizedLinkColumnId[] = [
  "device",
  "node",
  "ip",
  "model",
  "matched_by",
  "note",
  "seen",
]

export interface OxidizedLinkColumnOpts {
  omit?: OxidizedLinkColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** The last sync's warning per node full name, for the Note column. */
  notes?: Map<string, string>
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<OxidizedNodeLink>
}

/** The device or virtual machine a node backs, linked to its Config tab. */
export function LinkTarget({ link }: { link: OxidizedNodeLink }) {
  if (link.virtual_machine)
    return (
      <span className="inline-flex items-center gap-2">
        <Link
          to="/virtual-machines/$id"
          params={{ id: link.virtual_machine.id }}
          search={{ tab: "config" }}
          className="link font-medium"
        >
          {link.virtual_machine.name}
        </Link>
        <Badge variant="secondary">VM</Badge>
      </span>
    )
  if (!link.device) return null
  return (
    <Link
      to="/devices/$id"
      params={{ id: link.device.id }}
      search={{ tab: "config" }}
      className="link font-medium"
    >
      {link.device.name}
    </Link>
  )
}

export function buildOxidizedLinkColumns(
  opts: OxidizedLinkColumnOpts = {}
): ColumnDef<OxidizedNodeLink, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const notes = opts.notes ?? new Map<string, string>()

  const byId: Record<
    OxidizedLinkColumnId,
    () => ColumnDef<OxidizedNodeLink, unknown>
  > = {
    device: () => ({
      id: "device",
      accessorFn: (r) => (r.device ?? r.virtual_machine)?.name ?? "",
      header: ({ column }) => (
        <SortHeader column={column} label="Device or VM" />
      ),
      cell: ({ row }) => <LinkTarget link={row.original} />,
    }),
    node: () => ({
      id: "node",
      accessorKey: "full_name",
      header: ({ column }) => <SortHeader column={column} label="Node" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.full_name}</span>
      ),
    }),
    ip: () => ({
      id: "ip",
      accessorKey: "node_ip",
      header: ({ column }) => <SortHeader column={column} label="Address" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.node_ip || "-"}</span>
      ),
    }),
    model: () => ({
      id: "model",
      accessorKey: "node_model",
      header: ({ column }) => <SortHeader column={column} label="Model" />,
    }),
    matched_by: () => ({
      id: "matched_by",
      accessorKey: "matched_by",
      header: ({ column }) => <SortHeader column={column} label="Matched by" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-2">
          <Badge
            variant={
              row.original.matched_by === "manual" ? "info" : "secondary"
            }
          >
            {row.original.matched_by === "manual"
              ? "Pinned"
              : row.original.matched_by === "address"
                ? "Address"
                : "Name"}
          </Badge>
          {row.original.proposed && <Badge variant="warning">Proposed</Badge>}
        </span>
      ),
    }),
    note: () => ({
      id: "note",
      accessorFn: (r) => notes.get(r.full_name) ?? "",
      header: ({ column }) => <SortHeader column={column} label="Note" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {notes.get(row.original.full_name) ?? ""}
        </span>
      ),
    }),
    seen: () => ({
      id: "seen",
      accessorKey: "last_seen_at",
      header: ({ column }) => <SortHeader column={column} label="Last seen" />,
      cell: ({ row }) =>
        row.original.last_seen_at ? (
          <TimeCell iso={row.original.last_seen_at} />
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    }),
  }

  const cols: ColumnDef<OxidizedNodeLink, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<OxidizedNodeLink>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<OxidizedNodeLink>(opts.actions))
  return cols
}
