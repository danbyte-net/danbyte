import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { FlowRequirement, RequirementEnd } from "@/lib/api"
import { flowServiceLabel } from "@/lib/flows"
import { REQUIREMENT_STATE, requirementEndText } from "@/lib/flow-requirements"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"
import { FLOW_DIRECTION_LABELS } from "@/components/columns/application-flow-columns"

// The one source of truth for "a table of application flow requirements":
// the application page's Requirements tab builds here.

export type FlowRequirementColumnId =
  | "name"
  | "application"
  | "source"
  | "destination"
  | "service"
  | "direction"
  | "status"
  | "state"
  | "generated"
  | "description"

const CANONICAL_ORDER: FlowRequirementColumnId[] = [
  "name",
  "application",
  "source",
  "destination",
  "service",
  "direction",
  "status",
  "state",
  "generated",
  "description",
]

export interface FlowRequirementColumnOpts<
  T extends FlowRequirement = FlowRequirement,
> {
  omit?: FlowRequirementColumnId[]
  selection?: boolean
  actions?: ActionsColumnOpts<T>
  /** The generated count opens the requirement's flows. */
  onShowFlows?: (r: T) => void
}

/** One end: "This application", "Hosts of Broker" with the application
 * linked, an address, range or prefix, "Any" muted, or a muted "Hidden"
 * for a fixed end the caller may not view (#453). */
export function RequirementEndCell({ end }: { end: RequirementEnd }) {
  if (end.hidden)
    return <span className="text-xs text-muted-foreground">Hidden</span>
  if (end.kind === "any")
    return <span className="text-xs text-muted-foreground">Any</span>
  if (end.kind === "self")
    return <span className="whitespace-nowrap">This application</span>
  if (end.kind === "app")
    return (
      <span className="whitespace-nowrap">
        Hosts of{" "}
        {end.application ? (
          <Link
            to="/applications/$id"
            params={{ id: end.application.id }}
            className="link"
          >
            {end.application.name}
          </Link>
        ) : (
          "?"
        )}
      </span>
    )
  const label = <span className="font-mono text-xs">{end.label}</span>
  if (!end.id) return label
  return end.kind === "ip" ? (
    <Link to="/ips/$id" params={{ id: end.id }} className="link">
      {label}
    </Link>
  ) : end.kind === "prefix" ? (
    <Link to="/prefixes/$id" params={{ id: end.id }} className="link">
      {label}
    </Link>
  ) : (
    <Link to="/ip-ranges/$id" params={{ id: end.id }} className="link">
      {label}
    </Link>
  )
}

/** The resolver's state as one squarish badge. */
export function RequirementStateBadge({
  state,
}: {
  state: FlowRequirement["state"]
}) {
  const s = REQUIREMENT_STATE[state]
  return <Badge variant={s.variant}>{s.label}</Badge>
}

export function buildFlowRequirementColumns<
  T extends FlowRequirement = FlowRequirement,
>(opts: FlowRequirementColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])

  const byId: Record<FlowRequirementColumnId, () => ColumnDef<T, unknown>> = {
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="font-medium">{row.original.name}</span>
      ),
    }),
    application: () => ({
      id: "application",
      accessorFn: (r) => r.application.name,
      header: ({ column }) => (
        <SortHeader column={column} label="Application" />
      ),
      cell: ({ row }) => (
        <Link
          to="/applications/$id"
          params={{ id: row.original.application.id }}
          className="link"
        >
          {row.original.application.name}
        </Link>
      ),
    }),
    source: () => ({
      id: "source",
      accessorFn: (r) => requirementEndText(r.source),
      header: ({ column }) => <SortHeader column={column} label="Source" />,
      cell: ({ row }) => <RequirementEndCell end={row.original.source} />,
    }),
    destination: () => ({
      id: "destination",
      accessorFn: (r) => requirementEndText(r.destination),
      header: ({ column }) => (
        <SortHeader column={column} label="Destination" />
      ),
      cell: ({ row }) => <RequirementEndCell end={row.original.destination} />,
    }),
    service: () => ({
      id: "service",
      accessorFn: (r) => flowServiceLabel(r),
      header: ({ column }) => <SortHeader column={column} label="Ports" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs whitespace-nowrap">
          {flowServiceLabel(row.original)}
        </span>
      ),
    }),
    direction: () => ({
      id: "direction",
      accessorFn: (r) => FLOW_DIRECTION_LABELS[r.direction] ?? r.direction,
      header: ({ column }) => <SortHeader column={column} label="Direction" />,
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {FLOW_DIRECTION_LABELS[row.original.direction] ??
            row.original.direction}
        </span>
      ),
    }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    }),
    state: () => ({
      id: "state",
      accessorFn: (r) => REQUIREMENT_STATE[r.state].label,
      header: ({ column }) => <SortHeader column={column} label="State" />,
      cell: ({ row }) => <RequirementStateBadge state={row.original.state} />,
      meta: {
        facet: {
          kind: "enum",
          label: "State",
          get: (r: T) => REQUIREMENT_STATE[r.state].label,
        },
      },
    }),
    generated: () => ({
      id: "generated",
      accessorKey: "generated_count",
      header: ({ column }) => <SortHeader column={column} label="Flows" />,
      cell: ({ row }) => {
        const n = row.original.generated_count
        if (!opts.onShowFlows || n === 0)
          return <span className="num">{n}</span>
        return (
          <button
            type="button"
            className="link num"
            onClick={(e) => {
              e.stopPropagation()
              opts.onShowFlows!(row.original)
            }}
          >
            {n}
          </button>
        )
      },
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
