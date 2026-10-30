import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ApplicationFlow, FlowEnd } from "@/lib/api"
import { flowServiceLabel } from "@/lib/flows"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of application flows" (#163): the
// Flows tabs on applications, devices, VMs, addresses and prefixes build
// here.

export type ApplicationFlowColumnId =
  | "name"
  | "application"
  | "source"
  | "destination"
  | "service"
  | "direction"
  | "status"
  | "origin"
  | "linked_service"
  | "description"

const CANONICAL_ORDER: ApplicationFlowColumnId[] = [
  "name",
  "application",
  "source",
  "destination",
  "service",
  "direction",
  "status",
  "origin",
  "linked_service",
  "description",
]

export const FLOW_DIRECTION_LABELS: Record<string, string> = {
  "one-way": "One way",
  both: "Both ways",
}

export interface ApplicationFlowColumnOpts<
  T extends ApplicationFlow = ApplicationFlow,
> {
  omit?: ApplicationFlowColumnId[]
  include?: ApplicationFlowColumnId[]
  selection?: boolean
  actions?: ActionsColumnOpts<T>
}

/** An end's sort and search text: the address, range or prefix, then the
 * device or VM it is assigned to. */
export function flowEndText(e: FlowEnd): string {
  if (e.hidden) return "Hidden"
  const host = e.device?.name ?? e.vm?.name
  return host ? `${e.label} ${host}` : e.label
}

/** One end: the address, range or prefix linked to its page, and the
 * device or VM an address is assigned to after it; "Any" muted, and an end
 * the caller may not view (#453) a muted "Hidden". */
export function FlowEndCell({ end }: { end: FlowEnd }) {
  if (end.hidden)
    return <span className="text-xs text-muted-foreground">Hidden</span>
  if (end.kind === "any" || !end.id)
    return <span className="text-xs text-muted-foreground">Any</span>
  const label = <span className="font-mono text-xs">{end.label}</span>
  const target =
    end.kind === "ip" ? (
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
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      {target}
      {end.device ? (
        <Link
          to="/devices/$id"
          params={{ id: end.device.id }}
          className="link text-xs text-muted-foreground"
        >
          {end.device.name}
        </Link>
      ) : end.vm ? (
        <Link
          to="/virtual-machines/$id"
          params={{ id: end.vm.id }}
          className="link text-xs text-muted-foreground"
        >
          {end.vm.name}
        </Link>
      ) : null}
    </span>
  )
}

/** Where a flow came from: "Manual", or a "Generated" badge naming its
 * requirement, with "Edited" when someone overrode a field on it. */
export function flowOrigin(f: ApplicationFlow): string {
  if (!f.generated) return "Manual"
  return f.overridden_fields.length ? "Generated, edited" : "Generated"
}

export function FlowOriginCell({ flow }: { flow: ApplicationFlow }) {
  if (!flow.generated)
    return <span className="text-xs text-muted-foreground">Manual</span>
  const because = [flow.source_install, flow.destination_install]
    .filter((i) => i != null)
    .map((i) =>
      [i.application, i.version, "is on", i.host.name].filter(Boolean).join(" ")
    )
  return (
    <span className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Badge variant="info">Generated</Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent variant="panel" className="grid gap-0.5 text-xs">
          <span className="font-medium">
            {flow.requirement?.name ?? "Requirement"}
          </span>
          {because.map((b) => (
            <span key={b}>{b}</span>
          ))}
        </TooltipContent>
      </Tooltip>
      {flow.overridden_fields.length ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Badge variant="warning">Edited</Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent variant="panel" className="text-xs">
            {flow.overridden_fields.join(", ")}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}

export function buildApplicationFlowColumns<
  T extends ApplicationFlow = ApplicationFlow,
>(opts: ApplicationFlowColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: ApplicationFlowColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<ApplicationFlowColumnId, () => ColumnDef<T, unknown>> = {
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
      accessorFn: (r) => r.application.path || r.application.name,
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
      meta: {
        facet: {
          kind: "enum",
          label: "Application",
          get: (r: T) => r.application.id,
          formatValue: (_v, r) => ({ label: r.application.name }),
        },
      },
    }),
    source: () => ({
      id: "source",
      accessorFn: (r) => flowEndText(r.source),
      header: ({ column }) => <SortHeader column={column} label="Source" />,
      cell: ({ row }) => <FlowEndCell end={row.original.source} />,
    }),
    destination: () => ({
      id: "destination",
      accessorFn: (r) => flowEndText(r.destination),
      header: ({ column }) => (
        <SortHeader column={column} label="Destination" />
      ),
      cell: ({ row }) => <FlowEndCell end={row.original.destination} />,
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
      meta: {
        facet: {
          kind: "enum",
          label: "Protocol",
          get: (r: T) => r.protocol_display,
        },
      },
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
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => r.status?.name ?? "",
        },
      },
    }),
    origin: () => ({
      id: "origin",
      accessorFn: (r) => flowOrigin(r),
      header: ({ column }) => <SortHeader column={column} label="Origin" />,
      cell: ({ row }) => <FlowOriginCell flow={row.original} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Origin",
          get: (r: T) => (r.generated ? "Generated" : "Manual"),
        },
      },
    }),
    linked_service: () => ({
      id: "linked_service",
      accessorFn: (r) => r.service?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Service" />,
      cell: ({ row }) =>
        row.original.service ? (
          <Link
            to="/services/$id"
            params={{ id: row.original.service.id }}
            className="link"
          >
            {row.original.service.name}
          </Link>
        ) : (
          dash
        ),
      meta: { label: "Service", defaultHidden: true },
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
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
