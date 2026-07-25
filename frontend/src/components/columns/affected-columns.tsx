// Read-only column sets per object type, used to render the *real* table of
// objects a compliance rule currently fails (the genuine prefix/IP/device/…
// columns, all exportable). One module so the rule detail can dispatch on
// object_type.
//
// These are not a second definition of those columns: each set is the entity's
// own `components/columns/*` factory with the interactive bits left off (no
// selection, no row actions, no tag filter to drive), so an affected row reads
// exactly like the same object on its list page.
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
import { ColorBadge } from "@/components/cells/color-badge"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { buildVlanColumns } from "@/components/columns/vlan-columns"

function descCol<T extends { description: string }>(): ColumnDef<T> {
  return {
    id: "description",
    accessorKey: "description",
    header: "Description",
    cell: ({ row }) => (
      <span className="block whitespace-nowrap text-muted-foreground">
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
  return buildPrefixColumns({
    // This table leads with utilisation, so it spells the sequence out.
    order: [
      "cidr",
      "status",
      "utilisation",
      "site",
      "vrf",
      "description",
      "tags",
      "updated",
    ],
  })
}

export function ipColumns(): ColumnDef<IPAddress>[] {
  return buildIpColumns<IPAddress>({
    include: [
      "ip",
      "status",
      "role",
      "dns",
      "assigned",
      "description",
      "tags",
      "updated",
    ],
  })
}

export function deviceColumns(): ColumnDef<Device>[] {
  return buildDeviceColumns({
    include: [
      "name",
      "status",
      "role",
      "site",
      "serial",
      "description",
      "tags",
      "updated",
    ],
  })
}

export function vlanColumns(): ColumnDef<VLAN>[] {
  return buildVlanColumns({
    include: [
      "vlan_id",
      "name",
      "site",
      "group",
      "description",
      "tags",
      "updated",
    ],
  })
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
