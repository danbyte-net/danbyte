import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { VirtualMachine } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { PowerBadge } from "@/components/cells/power-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { ColorBadge } from "@/components/cells/color-badge"
import { platformColumn } from "@/components/cells/platform-cell"
import { siteColumn } from "@/components/cells/site-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of virtual machines". Every surface
// that lists VMs — /virtual-machines and the cluster detail page's VM pane —
// builds its columns here so a VM row reads identically everywhere.
// Page-specific columns are spliced around this factory's output; the shared
// cells are never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.

/** Memory in MB → "x GB" when an even multiple of 1024, else "x MB". */
export function formatMemory(mb: number): string {
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`
  return `${mb} MB`
}

export type VmColumnId =
  | "numid"
  | "name"
  | "cluster"
  | "status"
  | "power"
  | "vcpus"
  | "memory"
  | "disk"
  | "primary_ip"
  | "site"
  | "role"
  | "platform"
  | "tags"
  | "updated"

const CANONICAL_ORDER: VmColumnId[] = [
  "numid",
  "name",
  "cluster",
  "status",
  "power",
  "vcpus",
  "memory",
  "disk",
  "primary_ip",
  "site",
  "role",
  "platform",
  "tags",
  "updated",
]

export interface VmColumnOpts<T extends VirtualMachine = VirtualMachine> {
  /** Drop columns (e.g. the cluster page omits "cluster"). */
  omit?: VmColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: VmColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildVmColumns<T extends VirtualMachine = VirtualMachine>(
  opts: VmColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: VmColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<VmColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/virtual-machines/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.virtualmachine"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    cluster: () => ({
      id: "cluster",
      header: ({ column }) => <SortHeader column={column} label="Cluster" />,
      accessorFn: (r) => r.cluster.name,
      cell: ({ row }) => (
        <Link
          to="/clusters/$id"
          params={{ id: row.original.cluster.id }}
          className="link text-xs"
        >
          {row.original.cluster.name}
        </Link>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Cluster",
          get: (r: T) => r.cluster.name,
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
    power: () => ({
      id: "power",
      accessorFn: (r) => r.power_state ?? "",
      header: ({ column }) => <SortHeader column={column} label="Power" />,
      cell: ({ row }) =>
        row.original.power_state ? (
          <PowerBadge state={row.original.power_state} />
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Power",
          get: (r: T) => r.power_state ?? "__none__",
          formatValue: (v) => ({
            label:
              v === "running"
                ? "Powered on"
                : v === "stopped"
                  ? "Powered off"
                  : v === "__none__"
                    ? "Not tracked"
                    : String(v),
          }),
        },
      },
    }),
    vcpus: () => ({
      id: "vcpus",
      accessorKey: "vcpus",
      header: ({ column }) => <SortHeader column={column} label="vCPUs" />,
      cell: ({ row }) =>
        row.original.vcpus != null ? (
          <span className="num text-xs">{row.original.vcpus}</span>
        ) : (
          dash
        ),
    }),
    memory: () => ({
      id: "memory",
      accessorKey: "memory_mb",
      header: ({ column }) => <SortHeader column={column} label="Memory" />,
      cell: ({ row }) =>
        row.original.memory_mb != null ? (
          <span className="num text-xs">
            {formatMemory(row.original.memory_mb)}
          </span>
        ) : (
          dash
        ),
    }),
    disk: () => ({
      id: "disk",
      accessorKey: "disk_gb",
      header: ({ column }) => <SortHeader column={column} label="Disk" />,
      cell: ({ row }) =>
        row.original.disk_gb != null ? (
          <span className="num text-xs">{row.original.disk_gb} GB</span>
        ) : (
          dash
        ),
    }),
    primary_ip: () => ({
      id: "primary_ip",
      header: "Primary IP",
      accessorFn: (r) => r.primary_ip?.ip_address ?? "",
      cell: ({ row }) =>
        row.original.primary_ip ? (
          <Link
            to="/ips/$id"
            params={{ id: row.original.primary_ip.id }}
            className="link font-mono text-xs"
          >
            {row.original.primary_ip.ip_address}
          </Link>
        ) : (
          dash
        ),
    }),
    site: () => siteColumn<T>({ get: (r) => r.site, className: "text-xs" }),
    role: () => ({
      id: "role",
      header: ({ column }) => <SortHeader column={column} label="Role" />,
      accessorFn: (r) => r.role?.name ?? "",
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
          formatValue: (_v, r) => ({
            label: r.role?.name ?? "No role",
            color: r.role?.color,
          }),
        },
      },
    }),
    platform: () =>
      platformColumn<T>({ get: (r) => r.platform, className: "text-xs" }),
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
