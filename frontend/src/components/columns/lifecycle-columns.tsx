import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  CoverageStatus,
  EolStatus,
  LifecycleOverview,
  LifecycleRow,
  LifecycleSource,
  LifecycleWindow,
} from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { dash } from "@/components/cells/dash"
import { EOL_LABELS, EolBadge } from "@/components/cells/eol-cell"
import {
  COVERAGE_LABELS,
  CoverageBadge,
} from "@/components/cells/coverage-cell"
import { LifetimeBar } from "@/components/cells/lifecycle-cell"
import { siteColumn } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"

// The one source of truth for "a table of lifecycle rows" (#436): one row per
// device or VM per source - hardware, OS, coverage, installed software - each
// with its end date as the shared time bar. The Lifecycle page builds its columns here.

export const SOURCE_LABELS: Record<LifecycleSource, string> = {
  hardware: "Hardware",
  os: "OS",
  coverage: "Coverage",
  software: "Software",
}

export const WINDOW_ORDER: LifecycleWindow[] = [
  "past",
  "d90",
  "d180",
  "y1",
  "later",
  "none",
]

export const WINDOW_LABELS: Record<LifecycleWindow, string> = {
  past: "Past",
  d90: "≤ 90 d",
  d180: "≤ 180 d",
  y1: "≤ 1 y",
  later: "Later",
  none: "No date",
}

/** The Window facet's values, which are also its URL param:
 * `/lifecycle?source=coverage&window=90`. */
export const WINDOW_PARAMS: Record<LifecycleWindow, string> = {
  past: "past",
  d90: "90",
  d180: "180",
  y1: "365",
  later: "later",
  none: "none",
}

const WINDOW_BY_PARAM: Record<string, LifecycleWindow | undefined> =
  Object.fromEntries(WINDOW_ORDER.map((w) => [WINDOW_PARAMS[w], w]))

/** A window's count chip: destructive for Past, warning inside 180 days. */
export const WINDOW_VARIANT: Record<
  LifecycleWindow,
  "destructive" | "warning" | "secondary"
> = {
  past: "destructive",
  d90: "warning",
  d180: "warning",
  y1: "secondary",
  later: "secondary",
  none: "secondary",
}

const KIND_LABELS: Record<LifecycleRow["object"]["kind"], string> = {
  device: "Device",
  virtualmachine: "VM",
}

/** The row's status in its source's words. */
export function lifecycleStatusLabel(r: LifecycleRow): string {
  return r.source === "coverage"
    ? COVERAGE_LABELS[r.status as CoverageStatus]
    : EOL_LABELS[r.status as EolStatus]
}

/** Days left as a sort value: a passed end with no date before every dated
 * row; an open-ended or maintained row after them, then the undated. */
export function daysLeftSortValue(r: LifecycleRow): number {
  if (r.days_left !== null) return r.days_left
  if (r.window === "past") return -Infinity
  return r.window === "later" ? Number.MAX_VALUE : Infinity
}

function StatusPill({ row }: { row: LifecycleRow }) {
  return row.source === "coverage" ? (
    <CoverageBadge status={row.status as CoverageStatus} />
  ) : (
    <EolBadge info={{ status: row.status as EolStatus }} />
  )
}

function ItemCell({ row }: { row: LifecycleRow }) {
  const item = row.item
  if (!item) return dash
  if (item.type === "devicetype" && item.id)
    return (
      <Link to="/device-types/$id" params={{ id: item.id }} className="link">
        {item.name}
      </Link>
    )
  if (item.type === "platform" && item.id)
    return (
      <Link to="/platforms/$id" params={{ id: item.id }} className="link">
        {item.name}
      </Link>
    )
  if (item.type === "application" && item.id)
    return (
      <Link to="/applications/$id" params={{ id: item.id }} className="link">
        {item.name}
      </Link>
    )
  if (item.type === "supportcontract" && item.id)
    return (
      <Link
        to="/support-contracts/$id"
        params={{ id: item.id }}
        className="link font-mono text-xs"
      >
        {item.name}
      </Link>
    )
  // The warranty, or a contract the caller may not view.
  return <span className="text-muted-foreground">{item.name}</span>
}

function EndCell({ end }: { end: string | null }) {
  const { formatDate } = useDateFormat()
  if (!end) return dash
  return <span className="num whitespace-nowrap">{formatDate(end)}</span>
}

export interface LifecycleColumnOpts {
  /** Leading checkbox column - ticked rows are what Download exports. */
  selection?: boolean
  /** The response's warning windows, which colour the bars. */
  windows?: LifecycleOverview["windows"]
}

export function buildLifecycleColumns<T extends LifecycleRow = LifecycleRow>(
  opts: LifecycleColumnOpts = {}
): ColumnDef<T, unknown>[] {
  const windows = opts.windows
  const tags = tagsColumn<T>({ getTags: (r) => r.tags })
  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  cols.push(
    {
      id: "object",
      accessorFn: (r) => r.object.name,
      header: ({ column }) => <SortHeader column={column} label="Object" />,
      cell: ({ row }) => {
        const o = row.original.object
        return o.kind === "device" ? (
          <Link
            to="/devices/$id"
            params={{ id: o.id }}
            className="link font-mono font-medium"
          >
            {o.name}
          </Link>
        ) : (
          <Link
            to="/virtual-machines/$id"
            params={{ id: o.id }}
            className="link font-mono font-medium"
          >
            {o.name}
          </Link>
        )
      },
    },
    {
      id: "kind",
      accessorFn: (r) => KIND_LABELS[r.object.kind],
      header: ({ column }) => <SortHeader column={column} label="Kind" />,
      meta: {
        facet: {
          kind: "enum",
          label: "Kind",
          get: (r: T) => r.object.kind,
          formatValue: (v) => ({
            label: (KIND_LABELS as Record<string, string | undefined>)[v] ?? v,
          }),
        },
      },
    },
    {
      id: "source",
      accessorFn: (r) => SOURCE_LABELS[r.source],
      header: ({ column }) => <SortHeader column={column} label="Source" />,
      meta: {
        facet: {
          kind: "enum",
          label: "Source",
          get: (r: T) => r.source,
          formatValue: (v) => ({
            label:
              (SOURCE_LABELS as Record<string, string | undefined>)[v] ?? v,
          }),
        },
      },
    },
    {
      id: "item",
      accessorFn: (r) => r.item?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Item" />,
      cell: ({ row }) => <ItemCell row={row.original} />,
    },
    {
      id: "status",
      accessorFn: (r) => lifecycleStatusLabel(r),
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusPill row={row.original} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => r.status,
          formatValue: (_v, sample) => ({
            label: lifecycleStatusLabel(sample),
          }),
        },
        export: { value: (r: T) => lifecycleStatusLabel(r) },
      },
    },
    {
      id: "lifetime",
      accessorFn: (r) => daysLeftSortValue(r),
      header: ({ column }) => <SortHeader column={column} label="Lifetime" />,
      cell: ({ row }) => {
        const r = row.original
        const coverage = r.source === "coverage"
        return (
          <LifetimeBar
            start={r.start}
            end={r.end}
            label={coverage ? "coverage" : "eol"}
            warningDays={
              coverage
                ? windows?.coverage_warning_days
                : windows?.eol_warning_days
            }
            source={r.item?.date_source}
            fallback={
              r.window === "none" ? null : coverage ? (
                <Badge variant="secondary">Open-ended</Badge>
              ) : (
                <StatusPill row={r} />
              )
            }
          />
        )
      },
      meta: {
        export: { header: "End", value: (r: T) => r.end ?? "" },
      },
    },
    {
      id: "end",
      accessorFn: (r) => daysLeftSortValue(r),
      header: ({ column }) => <SortHeader column={column} label="End" />,
      cell: ({ row }) => <EndCell end={row.original.end} />,
      meta: { export: { value: (r: T) => r.end ?? "" } },
    },
    {
      id: "days_left",
      accessorFn: (r) => daysLeftSortValue(r),
      header: ({ column }) => <SortHeader column={column} label="Days left" />,
      cell: ({ row }) =>
        row.original.days_left === null ? (
          dash
        ) : (
          <span className="num">{row.original.days_left}</span>
        ),
      meta: {
        export: { value: (r: T) => r.days_left ?? "" },
      },
    },
    {
      id: "window",
      accessorFn: (r) => WINDOW_ORDER.indexOf(r.window),
      header: ({ column }) => <SortHeader column={column} label="Window" />,
      cell: ({ row }) => WINDOW_LABELS[row.original.window],
      meta: {
        label: "Window",
        defaultHidden: true,
        facet: {
          kind: "enum",
          label: "Window",
          get: (r: T) => WINDOW_PARAMS[r.window],
          formatValue: (v) => {
            const w = WINDOW_BY_PARAM[v]
            return { label: w ? WINDOW_LABELS[w] : v }
          },
        },
        export: { value: (r: T) => WINDOW_LABELS[r.window] },
      },
    },
    siteColumn<T>({ get: (r) => r.site }),
    {
      id: "tenant",
      accessorFn: (r) => r.tenant.name,
      header: ({ column }) => <SortHeader column={column} label="Tenant" />,
      // Every row is the active tenant's: there for the export, not the eye.
      meta: { label: "Tenant", defaultHidden: true },
    },
    {
      id: "role",
      accessorFn: (r) => r.role?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Role" />,
      cell: ({ row }) =>
        row.original.role ? (
          <ColorBadge
            name={row.original.role.name}
            color={row.original.role.color || undefined}
          />
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Role",
          get: (r: T) => r.role?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.role?.name ?? "No role",
            color: sample.role?.color || undefined,
          }),
        },
      },
    },
    {
      id: "manufacturer",
      accessorFn: (r) => r.manufacturer?.name ?? "",
      header: ({ column }) => (
        <SortHeader column={column} label="Manufacturer" />
      ),
      cell: ({ row }) =>
        row.original.manufacturer ? (
          <Link
            to="/manufacturers/$id"
            params={{ id: row.original.manufacturer.id }}
            className="link"
          >
            {row.original.manufacturer.name}
          </Link>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Manufacturer",
          get: (r: T) => r.manufacturer?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.manufacturer?.name ?? "No manufacturer",
          }),
        },
      },
    },
    // Offered in the Columns menu; its facet filters by tag either way.
    { ...tags, meta: { ...tags.meta, defaultHidden: true } }
  )
  return cols
}
