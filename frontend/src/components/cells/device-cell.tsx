import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import { SortHeader } from "@/components/data-table"

// Canonical "render a Device reference" + "Device column" pair. Every
// table cell that surfaces a device MUST go through here so the name is a
// clickable link to /devices/$id (never plain text).
//
//   <DeviceCell device={...} />                  single inline render
//   <DeviceCell device={...} primary />          + primary-IP ★ marker
//   deviceColumn<MyRow>({ get: r => r.device })  drop into ColumnDef[]

export interface DeviceLike {
  id: string
  name: string
}

export interface DeviceCellProps {
  device: DeviceLike | null | undefined
  /** Wrap the name in a /devices/$id link. Default true. */
  linked?: boolean
  /** Render the trailing ★ marking this as the device's primary IP. */
  primary?: boolean
  /** Optional class on the wrapper (e.g. text sizing). */
  className?: string
}

export function DeviceCell({
  device,
  linked = true,
  primary,
  className,
}: DeviceCellProps) {
  if (!device) {
    return <span className="text-muted-foreground">—</span>
  }
  const name = linked ? (
    <Link
      to="/devices/$id"
      params={{ id: device.id }}
      className="hover:underline"
    >
      {device.name}
    </Link>
  ) : (
    <span>{device.name}</span>
  )
  if (!primary) {
    return className ? <span className={className}>{name}</span> : name
  }
  return (
    <span className={className}>
      {name}
      <span
        className="ml-1 text-[10px] text-emerald-700 dark:text-emerald-400"
        title="Primary IP for this device"
      >
        ★
      </span>
    </span>
  )
}

export interface DeviceColumnOpts<T> {
  id?: string
  header?: string
  get: (row: T) => DeviceLike | null | undefined
  linked?: boolean
}

export function deviceColumn<T>(
  opts: DeviceColumnOpts<T>
): ColumnDef<T, unknown> {
  const id = opts.id ?? "device"
  const header = opts.header ?? "Device"
  return {
    id,
    accessorFn: (r) => opts.get(r)?.name ?? "",
    header: ({ column }) => <SortHeader column={column} label={header} />,
    cell: ({ row }) => (
      <DeviceCell device={opts.get(row.original)} linked={opts.linked} />
    ),
    meta: {
      facet: {
        kind: "enum",
        label: header,
        get: (r: T) => opts.get(r)?.id ?? "__none__",
        formatValue: (_v, sample) => ({
          label: opts.get(sample)?.name ?? "None",
        }),
      },
    },
  }
}
