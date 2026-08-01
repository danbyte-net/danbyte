import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { BulkStatusEntry, ComplianceViolation, Device } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { MixedStatusBadge } from "@/components/monitoring/mixed-status-badge"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import {
  DeviceDriftMarker,
  type DeviceDriftRow,
} from "@/components/monitoring/device-drift-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { LifecycleFlag } from "@/components/cells/lifecycle-cell"
import { PlatformCell } from "@/components/cells/platform-cell"
import { siteColumn } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of devices". Every surface that lists
// devices — /devices, the embedded table on a related object's detail page, the
// rack devices pane, the monitoring configuration tab, the compliance
// affected-objects table — builds its columns here so a device row reads
// identically everywhere. Page-specific columns (rack position, monitoring
// bindings) are spliced around this factory's output; the shared cells are
// never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.

export type DeviceColumnId =
  | "numid"
  | "name"
  | "status"
  | "role"
  | "platform"
  | "type"
  | "manufacturer"
  | "site"
  | "serial"
  | "ips"
  | "monitoring"
  | "primary_ip"
  | "secondary_ip"
  | "oob_ip"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: DeviceColumnId[] = [
  "numid",
  "name",
  "status",
  "role",
  "platform",
  "type",
  "manufacturer",
  "site",
  "serial",
  "ips",
  "monitoring",
  "primary_ip",
  "secondary_ip",
  "oob_ip",
  "description",
  "tags",
  "updated",
]

export interface DeviceColumnOpts<T extends Device = Device> {
  /** Drop columns (e.g. the Site page omits "site"). */
  omit?: DeviceColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: DeviceColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Compliance violation badge next to the name. Pass a pre-resolved map to
   * avoid one lookup per row; `true` lets each badge subscribe itself (the
   * shared query is cached, so a table of rows still costs one fetch). */
  violations?: boolean | Map<string, ComplianceViolation[]>
  /** Fleet drift map from `useDriftMap()` — one request per table, shared by
   * every row. Omit on views that are already about drift. */
  drift?: Map<string, DeviceDriftRow>
  /** Monitoring status per device id — enables the "Monitoring" column. */
  monitoring?: Record<string, BulkStatusEntry>
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

/** A device IP designation (primary / secondary / management), linked to its
 * IP. Neutral link — in-cell links underline on hover, they are not blue. */
export function DeviceIpRef({
  ip,
}: {
  ip?: { id: string; ip_address: string; dns_name?: string } | null
}) {
  if (!ip) return dash
  return (
    <Link
      to="/ips/$id"
      params={{ id: ip.id }}
      className="font-mono text-xs hover:underline"
      title={ip.dns_name || undefined}
    >
      {ip.ip_address}
    </Link>
  )
}

function monitoringTooltip(e: BulkStatusEntry): string {
  const counts = e.counts ?? {}
  const parts = Object.entries(counts).map(([s, n]) => `${n} ${s}`)
  const head = `${e.monitored_ips ?? 0} monitored IP${
    e.monitored_ips === 1 ? "" : "s"
  }`
  return parts.length ? `${head} — ${parts.join(", ")}` : head
}

export function buildDeviceColumns<T extends Device = Device>(
  opts: DeviceColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids, and the
  // Monitoring column only where the page fetched bulk status.
  if (!opts.humanIds) omit.add("numid")
  if (!opts.monitoring) omit.add("monitoring")
  const keep = (id: DeviceColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const ipDesignation = (
    id: "primary_ip" | "secondary_ip" | "oob_ip",
    header: string,
    get: (row: T) => Device["secondary_ip"]
  ): ColumnDef<T, unknown> => ({
    id,
    accessorFn: (r) => get(r)?.ip_address ?? "",
    header,
    cell: ({ row }) => <DeviceIpRef ip={get(row.original)} />,
  })

  const byId: Record<DeviceColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/devices/$id"
            params={{ id: row.original.id }}
            className="font-mono font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          {opts.violations && (
            <ViolationBadge
              objectId={row.original.id}
              objectType="device"
              map={opts.violations === true ? undefined : opts.violations}
            />
          )}
          {/* Drift beside compliance: a rule you wrote failing and the device
              reporting something else are different problems, and the list was
              only ever showing the first. Distinct glyph, distinct tooltip. */}
          {opts.drift && (
            <DeviceDriftMarker deviceId={row.original.id} map={opts.drift} />
          )}
        </span>
      ),
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
          formatValue: (_v, sample) => ({
            label: sample.status?.name ?? "No status",
            color: sample.status?.color,
            textColor: sample.status?.text_color,
          }),
        },
        export: { value: (r) => r.status?.name ?? "" },
      },
    }),
    role: () => ({
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
            color: sample.role?.color,
          }),
        },
      },
    }),
    platform: () => ({
      id: "platform",
      accessorFn: (r) => r.platform?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Platform" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <PlatformCell platform={row.original.platform} />
          <LifecycleFlag state={row.original.platform?.lifecycle_state} />
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Platform",
          get: (r: T) => r.platform?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.platform?.name ?? "No platform",
          }),
        },
      },
    }),
    type: () => ({
      id: "type",
      accessorFn: (r) => r.device_type?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) =>
        row.original.device_type ? (
          <span className="inline-flex items-center gap-1.5">
            {row.original.device_type.name}
            <LifecycleFlag state={row.original.device_type.lifecycle_state} />
          </span>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: T) => r.device_type?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.device_type?.name ?? "No type",
          }),
        },
      },
    }),
    manufacturer: () => ({
      id: "manufacturer",
      accessorFn: (r) => r.device_type?.manufacturer ?? "",
      header: ({ column }) => (
        <SortHeader column={column} label="Manufacturer" />
      ),
      cell: ({ row }) => row.original.device_type?.manufacturer ?? dash,
      meta: {
        facet: {
          kind: "enum",
          label: "Manufacturer",
          // Rows carry the manufacturer NAME (not id), so the facet buckets by
          // name — matching the dashboard "Devices by manufacturer" deep-link.
          get: (r: T) => r.device_type?.manufacturer ?? "__none__",
          formatValue: (v) => ({ label: v }),
        },
      },
    }),
    site: () => siteColumn<T>({ get: (r) => r.site }),
    serial: () => ({
      id: "serial",
      accessorKey: "serial_number",
      header: "Serial",
      cell: ({ row }) =>
        row.original.serial_number ? (
          <span className="font-mono text-xs">
            {row.original.serial_number}
          </span>
        ) : (
          dash
        ),
    }),
    ips: () => ({
      id: "ips",
      accessorKey: "ip_count",
      header: "IPs",
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.ip_count}</span>
      ),
      meta: {
        facet: {
          kind: "range",
          label: "IPs",
          get: (r: T) => r.ip_count,
          min: 0,
        },
      },
    }),
    monitoring: () => ({
      id: "monitoring",
      header: "Monitoring",
      enableSorting: false,
      cell: ({ row }) => {
        const e = opts.monitoring?.[row.original.id]
        if (!e || !e.status) return dash
        return (
          <span title={monitoringTooltip(e)}>
            <MixedStatusBadge counts={e.counts} status={e.status} />
          </span>
        )
      },
    }),
    primary_ip: () =>
      ipDesignation("primary_ip", "Primary IP", (r) => r.primary_ip),
    secondary_ip: () =>
      ipDesignation("secondary_ip", "Secondary IP", (r) => r.secondary_ip),
    oob_ip: () => ipDesignation("oob_ip", "Management IP", (r) => r.oob_ip),
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
