import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  NetworkPlan,
  NetworkPlanCable,
  NetworkPlanNic,
  NetworkPlanRef,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/kv-card"

// The rows of a Proxmox source's network plan (Network plan tab). One factory
// per row shape; the wrong-VNet and no-VNet sections share the NIC columns.

export type PlanVnet = NetworkPlan["vnets_to_create"][number]
export type PlanUnused = NetworkPlan["unused_vnets"][number]
export type PlanDuplicate = NetworkPlan["duplicates"][number]
export type PlanConflict = NetworkPlan["conflicts"][number]

function cableText(c: NetworkPlanCable) {
  return c.label || (c.numid != null ? `#${c.numid}` : "Cable")
}

function CableLink({ cable }: { cable: NetworkPlanCable }) {
  return (
    <Link
      to="/cables/$id"
      params={{ id: cable.id }}
      className="hover:underline"
    >
      {cableText(cable)}
    </Link>
  )
}

function Cables({ cables }: { cables: NetworkPlanCable[] }) {
  return (
    <span className="flex flex-wrap gap-x-2">
      {cables.map((c) => (
        <CableLink key={c.id} cable={c} />
      ))}
    </span>
  )
}

function Vnet({ name }: { name: string | null }) {
  return name ? <span className="font-mono">{name}</span> : dash
}

function DeviceLink({
  device,
  iface,
}: {
  device: NetworkPlanRef
  iface: NetworkPlanRef
}) {
  return (
    <Link
      to="/devices/$id"
      params={{ id: device.id }}
      className="hover:underline"
    >
      {device.name} <span className="text-muted-foreground">{iface.name}</span>
    </Link>
  )
}

export function buildPlanVnetColumns(): ColumnDef<PlanVnet, unknown>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="VNet" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <Vnet name={row.original.name} />
          {row.original.suggested && <Badge variant="outline">Suggested</Badge>}
        </span>
      ),
    },
    {
      id: "zone",
      accessorKey: "zone",
      header: ({ column }) => <SortHeader column={column} label="Zone" />,
      cell: ({ row }) => <Vnet name={row.original.zone || null} />,
    },
    {
      id: "tag",
      accessorKey: "tag",
      header: ({ column }) => <SortHeader column={column} label="Tag" />,
      cell: ({ row }) =>
        row.original.tag != null ? (
          <span className="num">{row.original.tag}</span>
        ) : (
          dash
        ),
    },
    {
      id: "cables",
      accessorFn: (r) => r.cables.map(cableText).join(" "),
      header: "Cables",
      cell: ({ row }) => <Cables cables={row.original.cables} />,
    },
  ]
}

export function buildPlanNicColumns(): ColumnDef<NetworkPlanNic, unknown>[] {
  return [
    {
      id: "vm",
      accessorFn: (r) => r.vm.name,
      header: ({ column }) => <SortHeader column={column} label="VM" />,
      cell: ({ row }) => (
        <Link
          to="/virtual-machines/$id"
          params={{ id: row.original.vm.id }}
          className="font-medium hover:underline"
        >
          {row.original.vm.name}
        </Link>
      ),
    },
    {
      id: "nic",
      accessorKey: "nic",
      header: ({ column }) => <SortHeader column={column} label="NIC" />,
      cell: ({ row }) => <Vnet name={row.original.nic} />,
    },
    {
      id: "interface",
      accessorFn: (r) => `${r.device.name} ${r.interface.name}`,
      header: ({ column }) => <SortHeader column={column} label="Interface" />,
      cell: ({ row }) => (
        <DeviceLink
          device={row.original.device}
          iface={row.original.interface}
        />
      ),
    },
    {
      id: "current",
      accessorKey: "current",
      header: ({ column }) => <SortHeader column={column} label="Current" />,
      cell: ({ row }) => <Vnet name={row.original.current} />,
    },
    {
      id: "wanted",
      accessorKey: "wanted",
      header: ({ column }) => <SortHeader column={column} label="Wanted" />,
      cell: ({ row }) => <Vnet name={row.original.wanted || null} />,
    },
    {
      id: "mac",
      accessorKey: "mac",
      header: "MAC",
      cell: ({ row }) =>
        row.original.mac ? (
          <span className="font-mono text-xs">{row.original.mac}</span>
        ) : (
          dash
        ),
    },
    {
      id: "cable",
      accessorFn: (r) => cableText(r.cable),
      header: "Cable",
      cell: ({ row }) => <CableLink cable={row.original.cable} />,
    },
  ]
}

export function buildPlanUnusedColumns(): ColumnDef<PlanUnused, unknown>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="VNet" />,
      cell: ({ row }) => <Vnet name={row.original.name} />,
    },
    {
      id: "alias",
      accessorKey: "alias",
      header: "Alias",
      cell: ({ row }) => row.original.alias || dash,
    },
    {
      id: "zone",
      accessorKey: "zone",
      header: ({ column }) => <SortHeader column={column} label="Zone" />,
      cell: ({ row }) => <Vnet name={row.original.zone} />,
    },
    {
      id: "tag",
      accessorKey: "tag",
      header: "Tag",
      cell: ({ row }) =>
        row.original.tag != null ? (
          <span className="num">{row.original.tag}</span>
        ) : (
          dash
        ),
    },
  ]
}

export function buildPlanDuplicateColumns(): ColumnDef<
  PlanDuplicate,
  unknown
>[] {
  return [
    {
      id: "vnet",
      accessorKey: "vnet",
      header: ({ column }) => <SortHeader column={column} label="VNet" />,
      cell: ({ row }) => <Vnet name={row.original.vnet} />,
    },
    {
      id: "cables",
      accessorFn: (r) => r.cables.map(cableText).join(" "),
      header: "Cables",
      cell: ({ row }) => <Cables cables={row.original.cables} />,
    },
  ]
}

const CONFLICT_LABELS: Record<string, string> = {
  no_nic: "No NIC",
  bad_name: "Bad name",
  tags_exhausted: "No tag",
  skipped: "Skipped",
}

export function buildPlanConflictColumns(): ColumnDef<PlanConflict, unknown>[] {
  return [
    {
      id: "kind",
      accessorKey: "kind",
      header: ({ column }) => <SortHeader column={column} label="Kind" />,
      cell: ({ row }) => (
        <Badge
          variant={row.original.kind === "skipped" ? "outline" : "warning"}
        >
          {CONFLICT_LABELS[row.original.kind] ?? row.original.kind}
        </Badge>
      ),
    },
    {
      id: "cable",
      accessorFn: (r) => (r.cable ? cableText(r.cable) : ""),
      header: "Cable",
      cell: ({ row }) =>
        row.original.cable ? <CableLink cable={row.original.cable} /> : dash,
    },
    {
      id: "detail",
      accessorKey: "detail",
      header: "Detail",
      cell: ({ row }) => (
        <span className="whitespace-normal">{row.original.detail}</span>
      ),
    },
  ]
}
