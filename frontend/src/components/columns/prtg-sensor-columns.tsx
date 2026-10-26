import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { ExternalLink } from "lucide-react"

import type { PrtgSensor } from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"

// Imported PRTG sensors as table rows - one factory for the /prtg page's
// Alarms and Sensors tabs. The state is Danbyte's pill (from the
// connection's map) with PRTG's own word in the tooltip; the sensor name
// opens its panel on the device's or VM's Sensors tab.

/** Worst highest, so a descending sort puts it first. Paused sorts last. */
const RANK: Record<string, number> = {
  down: 4,
  degraded: 3,
  unknown: 2,
  up: 1,
}

/** The facet bucket a sensor falls in: its state, or "paused". */
export function sensorBucket(r: PrtgSensor): string {
  return r.paused ? "paused" : r.state || "unknown"
}

/** When the sensor's current story started: its last down, else its last
 * check. */
export function sensorSince(r: PrtgSensor): string | null {
  return r.last_down_at ?? r.last_check_at
}

function ownerName(r: PrtgSensor): string {
  if (r.device) return r.device.name
  if (r.virtual_machine) return `VM ${r.virtual_machine.name}`
  return ""
}

function probeGroup(r: PrtgSensor): string {
  return [r.probe_name, r.group_path]
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .join(" / ")
}

/** A link to the sensor's panel on its device's or VM's Sensors tab. */
export function SensorLink({
  sensor,
  children,
}: {
  sensor: PrtgSensor
  children: React.ReactNode
}) {
  if (sensor.device)
    return (
      <Link
        to="/devices/$id"
        params={{ id: sensor.device.id }}
        search={{ tab: "sensors", sensor: sensor.id }}
        className="link font-medium"
      >
        {children}
      </Link>
    )
  if (sensor.virtual_machine)
    return (
      <Link
        to="/virtual-machines/$id"
        params={{ id: sensor.virtual_machine.id }}
        search={{ tab: "sensors", sensor: sensor.id }}
        className="link font-medium"
      >
        {children}
      </Link>
    )
  return <span className="font-medium">{children}</span>
}

export interface PrtgSensorColumnOpts {
  /** `alarms` leaves out the last value and uptime; `sensors` has them. */
  variant: "alarms" | "sensors"
}

export function buildPrtgSensorColumns(
  opts: PrtgSensorColumnOpts
): ColumnDef<PrtgSensor, unknown>[] {
  const extra: ColumnDef<PrtgSensor, unknown>[] =
    opts.variant === "sensors"
      ? [
          {
            id: "value",
            accessorFn: (r) => r.last_value_raw ?? -Infinity,
            header: ({ column }) => (
              <SortHeader column={column} label="Last value" />
            ),
            cell: ({ row }) =>
              row.original.last_value ? (
                <span className="num text-xs">{row.original.last_value}</span>
              ) : (
                dash
              ),
          },
          {
            id: "uptime",
            accessorFn: (r) => r.uptime_pct ?? -1,
            header: ({ column }) => (
              <SortHeader column={column} label="Uptime" />
            ),
            cell: ({ row }) =>
              row.original.uptime_pct != null ? (
                <span className="num text-xs">
                  {fmtPct(row.original.uptime_pct)}
                </span>
              ) : (
                dash
              ),
          },
        ]
      : []
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Sensor" />,
      cell: ({ row }) => (
        <SensorLink sensor={row.original}>{row.original.name}</SensorLink>
      ),
    },
    {
      id: "device",
      accessorFn: ownerName,
      header: ({ column }) => <SortHeader column={column} label="Device" />,
      cell: ({ row }) => {
        const r = row.original
        if (r.device)
          return (
            <Link
              to="/devices/$id"
              params={{ id: r.device.id }}
              className="link text-xs"
            >
              {r.device.name}
            </Link>
          )
        if (r.virtual_machine)
          return (
            <span className="inline-flex items-center gap-1.5">
              <Badge variant="outline">VM</Badge>
              <Link
                to="/virtual-machines/$id"
                params={{ id: r.virtual_machine.id }}
                className="link text-xs"
              >
                {r.virtual_machine.name}
              </Link>
            </span>
          )
        return dash
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Device",
          get: (r: PrtgSensor) => ownerName(r) || "__none__",
          formatValue: (v: string) => ({
            label: v === "__none__" ? "No device" : v,
          }),
        },
      },
    },
    {
      id: "kind",
      accessorKey: "kind_label",
      header: ({ column }) => <SortHeader column={column} label="Kind" />,
      cell: ({ row }) => (
        <span className="text-xs">
          {row.original.kind_label || row.original.kind || "-"}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Kind",
          get: (r: PrtgSensor) => r.kind_label || r.kind || "__none__",
          formatValue: (v: string) => ({
            label: v === "__none__" ? "Unknown" : v,
          }),
        },
      },
    },
    {
      id: "state",
      accessorFn: (r) => (r.paused ? 0 : (RANK[r.state] ?? 0)),
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => {
        const r = row.original
        const pill = <CheckStatusBadge status={r.state || "unknown"} />
        if (!r.status) return pill
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">{pill}</span>
            </TooltipTrigger>
            <TooltipContent variant="default">
              {r.status} in PRTG
            </TooltipContent>
          </Tooltip>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: sensorBucket,
          formatValue: (v: string) => ({
            label: v === "paused" ? "Paused" : v[0].toUpperCase() + v.slice(1),
          }),
        },
      },
    },
    {
      id: "message",
      accessorKey: "message",
      header: ({ column }) => <SortHeader column={column} label="Message" />,
      cell: ({ row }) =>
        row.original.message ? (
          <span className="block max-w-[28rem] truncate text-xs text-muted-foreground">
            {row.original.message}
          </span>
        ) : (
          dash
        ),
    },
    ...extra,
    {
      id: "since",
      accessorFn: (r) => sensorSince(r) ?? "",
      header: ({ column }) => <SortHeader column={column} label="Since" />,
      cell: ({ row }) => {
        const at = sensorSince(row.original)
        return at ? <TimeCell iso={at} /> : dash
      },
    },
    {
      id: "acknowledged",
      accessorFn: (r) => (r.acknowledged ? 1 : 0),
      header: ({ column }) => (
        <SortHeader column={column} label="Acknowledged" />
      ),
      cell: ({ row }) =>
        row.original.acknowledged ? (
          <Badge variant="secondary">Acknowledged</Badge>
        ) : (
          dash
        ),
    },
    {
      id: "probe",
      accessorFn: probeGroup,
      header: ({ column }) => (
        <SortHeader column={column} label="Probe / group" />
      ),
      cell: ({ row }) => {
        const v = probeGroup(row.original)
        return v ? <span className="text-xs">{v}</span> : dash
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Probe / group",
          get: (r: PrtgSensor) => probeGroup(r) || "__none__",
          formatValue: (v: string) => ({
            label: v === "__none__" ? "None" : v,
          }),
        },
      },
    },
    {
      id: "prtg",
      enableSorting: false,
      header: () => <span className="sr-only">PRTG</span>,
      cell: ({ row }) => (
        <a
          href={row.original.url}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground"
          aria-label={`Open ${row.original.name} in PRTG`}
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      ),
      meta: { label: "PRTG link" },
    },
  ]
}

function fmtPct(v: number): string {
  return `${v >= 99.995 ? "100" : v.toFixed(2)} %`
}
