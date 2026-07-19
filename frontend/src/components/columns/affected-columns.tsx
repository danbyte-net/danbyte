// Read-only column sets per object type, used to render the *real* table of
// objects a compliance rule currently fails (the genuine prefix/IP/device/…
// columns, all exportable). One module so the rule detail can dispatch on
// object_type. These mirror the list pages' display columns (no row actions /
// selection — the consumer adds those).
import { type ColumnDef } from "@tanstack/react-table"
import { dash } from "@/components/cells/dash"
import { Link } from "@tanstack/react-router"

import {
  type Device,
  type IPAddress,
  type Prefix,
  type Site,
  type VLAN,
  type VRF,
} from "@/lib/api"
import { SortHeader } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { StatusBadge } from "@/components/status-badge"
import { UtilCell } from "@/components/cells/util-cell"
import { VrfCell } from "@/components/cells/vrf-cell"
import { ColorBadge } from "@/components/cells/color-badge"
import { CatalogCell } from "@/components/cells/catalog-cell"
import { RoleChip } from "@/components/role-chip"

function descCol<T extends { description: string }>(): ColumnDef<T> {
  return {
    id: "description",
    accessorKey: "description",
    header: "Description",
    cell: ({ row }) => (
      <span className="line-clamp-1 block text-muted-foreground">
        {row.original.description || "—"}
      </span>
    ),
  }
}

const readonlyTags = <T extends { tags: { slug: string; name: string }[] }>() =>
  tagsColumn<T>({
    getTags: (r) => r.tags as never,
    activeSlugs: new Set<string>(),
    onToggle: () => {},
  })

const updated = <T extends { updated_at: string }>() =>
  timeAgoColumn<T>({
    id: "updated",
    header: "Updated",
    get: (r) => r.updated_at,
    align: "right",
  })

export function prefixColumns(): ColumnDef<Prefix>[] {
  return [
    {
      id: "cidr",
      accessorKey: "cidr",
      header: ({ column }) => <SortHeader column={column} label="Prefix" />,
      cell: ({ row }) => (
        <Link
          to="/prefixes/$id"
          params={{ id: row.original.id }}
          className="font-mono font-medium hover:underline"
        >
          {row.original.cidr}
        </Link>
      ),
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "utilisation",
      accessorKey: "utilisation_pct",
      header: ({ column }) => (
        <SortHeader column={column} label="Utilisation" />
      ),
      cell: ({ row }) => <UtilCell pct={row.original.utilisation_pct} />,
      meta: {
        export: {
          value: (r) =>
            r.utilisation_pct == null ? "" : `${r.utilisation_pct}%`,
        },
      },
    },
    {
      id: "site",
      accessorFn: (r) => r.site?.name ?? "",
      header: "Site",
      cell: ({ row }) => row.original.site?.name ?? dash,
    },
    {
      id: "vrf",
      accessorFn: (r) => r.vrf?.name ?? "Global",
      header: "VRF",
      cell: ({ row }) => <VrfCell vrf={row.original.vrf} />,
    },
    descCol<Prefix>(),
    readonlyTags<Prefix>(),
    updated<Prefix>(),
  ]
}

export function ipColumns(): ColumnDef<IPAddress>[] {
  return [
    {
      id: "ip_address",
      accessorKey: "ip_address",
      header: ({ column }) => <SortHeader column={column} label="IP address" />,
      cell: ({ row }) => (
        <Link
          to="/ips/$id"
          params={{ id: row.original.id }}
          className="font-mono font-medium hover:underline"
        >
          {row.original.ip_address}
        </Link>
      ),
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: "Status",
      cell: ({ row }) => <CatalogCell value={row.original.status} />,
    },
    {
      id: "role",
      accessorFn: (r) => r.role?.name ?? "",
      header: "Role",
      cell: ({ row }) =>
        row.original.role ? <RoleChip role={row.original.role} /> : dash,
    },
    {
      id: "dns_name",
      accessorKey: "dns_name",
      header: "DNS name",
      cell: ({ row }) =>
        row.original.dns_name ? (
          <span className="font-mono text-xs">{row.original.dns_name}</span>
        ) : (
          dash
        ),
    },
    {
      id: "device",
      accessorFn: (r) => r.assigned_device?.name ?? "",
      header: "Device",
      cell: ({ row }) => row.original.assigned_device?.name ?? dash,
    },
    descCol<IPAddress>(),
    readonlyTags<IPAddress>(),
    updated<IPAddress>(),
  ]
}

export function deviceColumns(): ColumnDef<Device>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/devices/$id"
          params={{ id: row.original.id }}
          className="font-mono font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: { export: { value: (r) => r.status?.name ?? "" } },
    },
    {
      id: "role",
      accessorFn: (r) => r.role?.name ?? "",
      header: "Role",
      cell: ({ row }) =>
        row.original.role ? (
          <ColorBadge
            name={row.original.role.name}
            color={row.original.role.color || undefined}
          />
        ) : (
          dash
        ),
    },
    {
      id: "site",
      accessorFn: (r) => r.site?.name ?? "",
      header: "Site",
      cell: ({ row }) => row.original.site?.name ?? dash,
    },
    {
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
    },
    descCol<Device>(),
    readonlyTags<Device>(),
    updated<Device>(),
  ]
}

export function vlanColumns(): ColumnDef<VLAN>[] {
  return [
    {
      id: "vlan_id",
      accessorKey: "vlan_id",
      header: ({ column }) => <SortHeader column={column} label="VLAN" />,
      cell: ({ row }) => (
        <Link
          to="/vlans/$id"
          params={{ id: row.original.id }}
          className="num font-mono font-medium hover:underline"
        >
          {row.original.vlan_id}
        </Link>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => row.original.name,
    },
    {
      id: "site",
      accessorFn: (r) => r.site?.name ?? "",
      header: "Site",
      cell: ({ row }) => row.original.site?.name ?? dash,
    },
    {
      id: "group",
      accessorFn: (r) => r.group?.name ?? "",
      header: "Group",
      cell: ({ row }) => row.original.group?.name ?? dash,
    },
    descCol<VLAN>(),
    readonlyTags<VLAN>(),
    updated<VLAN>(),
  ]
}

export function vrfColumns(): ColumnDef<VRF>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link to="/vrfs/$id" params={{ id: row.original.id }}>
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
        </Link>
      ),
    },
    {
      id: "rd",
      accessorKey: "rd",
      header: "RD",
      cell: ({ row }) =>
        row.original.rd ? (
          <span className="font-mono text-xs">{row.original.rd}</span>
        ) : (
          dash
        ),
    },
    {
      id: "prefixes",
      accessorKey: "prefix_count",
      header: ({ column }) => <SortHeader column={column} label="Prefixes" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.prefix_count}</span>
      ),
    },
    descCol<VRF>(),
    readonlyTags<VRF>(),
    updated<VRF>(),
  ]
}

export function siteColumns(): ColumnDef<Site>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) => (
        <Link
          to="/sites/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "location",
      accessorKey: "location",
      header: "Location",
      cell: ({ row }) => row.original.location || dash,
    },
    {
      id: "prefixes",
      accessorKey: "prefix_count",
      header: ({ column }) => <SortHeader column={column} label="Prefixes" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.prefix_count}</span>
      ),
    },
    descCol<Site>(),
    readonlyTags<Site>(),
    updated<Site>(),
  ]
}

// The serialized objects arrive loosely typed (Record<string, unknown>), so the
// dispatcher hands back columns typed to match — the per-type factories above
// are the real, typed source.
type LooseColumns = ColumnDef<Record<string, unknown>>[]
const loose = <T,>(c: ColumnDef<T>[]) => c as unknown as LooseColumns

// object_type slug → its real column set. Returns null for types without a
// dedicated table (the detail page falls back to the generic object list).
export function affectedColumnsFor(objectType: string): LooseColumns | null {
  switch (objectType) {
    case "prefix":
      return loose(prefixColumns())
    case "ipaddress":
      return loose(ipColumns())
    case "device":
      return loose(deviceColumns())
    case "vlan":
      return loose(vlanColumns())
    case "vrf":
      return loose(vrfColumns())
    case "site":
      return loose(siteColumns())
    default:
      return null
  }
}

export const AFFECTED_FLEX_COLUMN = "description"
