import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { CoolingIntake, CoolingOutflow } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import { fmtDecimal } from "@/components/columns/cooling-feed-columns"

/** Cooling intakes and outflows (#434): where coolant enters and leaves a
 * device. One factory per kind, shared by the device's Cooling pane and any
 * embedded table. */

export interface CoolingRowActions<T> {
  canEdit: boolean
  canDelete: boolean
  onEdit: (row: T) => void
  onDelete: (row: T) => void
}

type Shared =
  "name" | "label" | "connector" | "diameter" | "flow" | "description"

export type CoolingIntakeColumnId = Shared | "fed_from"
export type CoolingOutflowColumnId = Shared | "fed_by" | "serves"

export const COOLING_INTAKE_COLUMNS: CoolingIntakeColumnId[] = [
  "name",
  "label",
  "connector",
  "diameter",
  "flow",
  "fed_from",
  "description",
]

export const COOLING_OUTFLOW_COLUMNS: CoolingOutflowColumnId[] = [
  "name",
  "label",
  "connector",
  "diameter",
  "flow",
  "fed_by",
  "serves",
  "description",
]

const dash = <span className="text-muted-foreground">-</span>

type Row = CoolingIntake | CoolingOutflow

function shared<T extends Row>(
  noun: string
): Record<Shared, () => ColumnDef<T>> {
  return {
    name: () => ({
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label={noun} />,
      meta: { label: noun },
      cell: ({ row }) => (
        <span className="font-mono font-medium">{row.original.name}</span>
      ),
    }),
    label: () => ({
      id: "label",
      accessorFn: (r) => r.label,
      header: "Label",
      cell: ({ row }) =>
        row.original.label ? (
          <span className="text-xs">{row.original.label}</span>
        ) : (
          dash
        ),
    }),
    connector: () => ({
      id: "connector",
      accessorFn: (r) => r.connector_display,
      header: ({ column }) => <SortHeader column={column} label="Connector" />,
      meta: { label: "Connector" },
      cell: ({ row }) =>
        row.original.connector ? (
          <span className="text-xs">{row.original.connector_display}</span>
        ) : (
          dash
        ),
    }),
    diameter: () => ({
      id: "diameter",
      accessorFn: (r) => r.diameter_mm ?? -1,
      header: ({ column }) => <SortHeader column={column} label="Diameter" />,
      meta: { label: "Diameter" },
      cell: ({ row }) =>
        row.original.diameter_mm != null ? (
          <span className="num text-xs">{row.original.diameter_mm} mm</span>
        ) : (
          dash
        ),
    }),
    flow: () => ({
      id: "flow",
      accessorFn: (r) => (r.max_flow_lpm == null ? -1 : Number(r.max_flow_lpm)),
      header: ({ column }) => <SortHeader column={column} label="Max flow" />,
      meta: { label: "Max flow" },
      cell: ({ row }) =>
        row.original.max_flow_lpm != null ? (
          <span className="num text-xs">
            {fmtDecimal(row.original.max_flow_lpm, "L/min")}
          </span>
        ) : (
          dash
        ),
    }),
    description: () => ({
      id: "description",
      accessorFn: (r) => r.description,
      header: "Description",
      cell: ({ row }) =>
        row.original.description ? (
          <span className="text-xs">{row.original.description}</span>
        ) : (
          dash
        ),
    }),
  }
}

function DeviceRef({
  device,
  name,
}: {
  device: { id: string; name: string }
  name: string
}) {
  return (
    <span className="text-xs">
      <Link to="/devices/$id" params={{ id: device.id }} className="link">
        {device.name}
      </Link>
      <span className="font-mono text-muted-foreground"> {name}</span>
    </span>
  )
}

const hidden = <span className="text-xs text-muted-foreground">Hidden</span>

/** Where an intake takes coolant from, as text: the feed, or the device and
 * outflow; "Hidden" when the caller may not view it (#453); "" when
 * connected to nothing. */
export function intakeUpstreamText(r: CoolingIntake): string {
  if (r.upstream_hidden) return "Hidden"
  if (r.cooling_feed) return r.cooling_feed.name
  if (r.outflow) return `${r.outflow.device.name} ${r.outflow.name}`
  return ""
}

export function buildCoolingIntakeColumns({
  include = COOLING_INTAKE_COLUMNS,
  actions,
}: {
  include?: CoolingIntakeColumnId[]
  actions?: CoolingRowActions<CoolingIntake>
} = {}): ColumnDef<CoolingIntake>[] {
  const byId: Record<CoolingIntakeColumnId, () => ColumnDef<CoolingIntake>> = {
    ...shared<CoolingIntake>("Intake"),
    fed_from: () => ({
      id: "fed_from",
      accessorFn: intakeUpstreamText,
      header: ({ column }) => <SortHeader column={column} label="Fed from" />,
      meta: { label: "Fed from" },
      cell: ({ row }) => {
        const r = row.original
        if (r.upstream_hidden) return hidden
        if (r.cooling_feed)
          return (
            <Link
              to="/cooling-feeds/$id"
              params={{ id: r.cooling_feed.id }}
              className="link text-xs"
            >
              {r.cooling_feed.name}
            </Link>
          )
        if (r.outflow)
          return <DeviceRef device={r.outflow.device} name={r.outflow.name} />
        return dash
      },
    }),
  }
  return [
    ...include.map((id) => byId[id]()),
    ...(actions ? [rowActions(actions)] : []),
  ]
}

export function buildCoolingOutflowColumns({
  include = COOLING_OUTFLOW_COLUMNS,
  actions,
}: {
  include?: CoolingOutflowColumnId[]
  actions?: CoolingRowActions<CoolingOutflow>
} = {}): ColumnDef<CoolingOutflow>[] {
  const byId: Record<CoolingOutflowColumnId, () => ColumnDef<CoolingOutflow>> =
    {
      ...shared<CoolingOutflow>("Outflow"),
      fed_by: () => ({
        id: "fed_by",
        accessorFn: (r) => r.intake?.name ?? "",
        header: ({ column }) => <SortHeader column={column} label="Fed by" />,
        meta: { label: "Fed by" },
        cell: ({ row }) =>
          row.original.intake ? (
            <span className="font-mono text-xs">
              {row.original.intake.name}
            </span>
          ) : (
            dash
          ),
      }),
      serves: () => ({
        id: "serves",
        accessorFn: (r) => r.served.length,
        header: ({ column }) => <SortHeader column={column} label="Serves" />,
        meta: { label: "Serves" },
        cell: ({ row }) =>
          row.original.served.length ? (
            <span className="flex flex-col gap-0.5">
              {row.original.served.map((i, n) =>
                i.hidden ? (
                  <span key={`hidden-${n}`}>{hidden}</span>
                ) : (
                  <DeviceRef key={i.id} device={i.device} name={i.name} />
                )
              )}
            </span>
          ) : (
            dash
          ),
      }),
    }
  return [
    ...include.map((id) => byId[id]()),
    ...(actions ? [rowActions(actions)] : []),
  ]
}

function rowActions<T>(a: CoolingRowActions<T>): ColumnDef<T> {
  return actionsColumn<T>({
    onEdit: a.onEdit,
    onDelete: a.onDelete,
    canEdit: () => a.canEdit,
    canDelete: () => a.canDelete,
  })
}
