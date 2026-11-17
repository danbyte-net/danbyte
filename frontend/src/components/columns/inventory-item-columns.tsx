import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import {
  formatBytes,
  INVENTORY_KIND_OPTIONS,
  INVENTORY_MEDIA_OPTIONS,
} from "@/lib/api"
import type { InventoryItemRow, SnmpDriftItem } from "@/lib/api"
import { actionsColumn } from "@/components/columns/actions-column"
import { StatusBadge } from "@/components/status-badge"
import { DriftBadge } from "@/components/drift-detail"
import { formatMemory } from "@/lib/memory-size"

export const KIND_LABEL = Object.fromEntries(
  INVENTORY_KIND_OPTIONS.map((k) => [k.value, k.label])
)
export const MEDIA_LABEL = Object.fromEntries(
  INVENTORY_MEDIA_OPTIONS.map((m) => [m.value, m.label])
)

export const CORES_PREFIX = /^\s*(\d+)\s*[x×]\s/

/** The recorded core count, else the "36 x Xeon…" prefix a BMC or
 * hypervisor writes into the description. */
export function coresOf(item: InventoryItemRow): number {
  if (item.cores) return item.cores
  const m = CORES_PREFIX.exec(item.description)
  return m ? Number(m[1]) : 0
}

/** "NVMe · 1.92 TB · PCIe 4.0" - the composed hardware summary cell. RAM
 * reads in GB, like the spec sheet. */
export function hardwareSummary(it: InventoryItemRow): string {
  const cores = it.kind === "cpu" ? coresOf(it) : 0
  return [
    it.media ? MEDIA_LABEL[it.media] : "",
    it.kind === "ram"
      ? formatMemory(it.capacity_bytes)
      : formatBytes(it.capacity_bytes),
    it.speed,
    cores ? `${cores} cores` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** A serial-tracked part on a device - a disk, CPU, DIMM, PSU, fan, optic.
 * Children indent under their parent. */
// No sort headers: the rows are a tree (parts under their parent), and
// sorting would pull children away from it.
export type InventoryItemColumnId =
  | "name"
  | "slot"
  | "port"
  | "kind"
  | "hardware"
  | "status"
  | "manufacturer"
  | "part_id"
  | "serial_number"
  | "description"
  | "asset_tag"
  // The Transceivers list (docs/dcim/inventory.md → Transceivers list).
  | "device"
  | "site"
  | "standard"
  | "cabled"

export const INVENTORY_ITEM_COLUMNS: InventoryItemColumnId[] = [
  "name",
  "slot",
  "port",
  "kind",
  "hardware",
  "status",
  "manufacturer",
  "part_id",
  "serial_number",
  "description",
  "asset_tag",
]

/** The Transceivers list's columns: every transceiver in the tenant. */
export const TRANSCEIVER_COLUMNS: InventoryItemColumnId[] = [
  "part_id",
  "serial_number",
  "standard",
  "device",
  "port",
  "cabled",
  "site",
  "name",
]

export function buildInventoryItemColumns({
  include = INVENTORY_ITEM_COLUMNS,
  driftFor,
  linkTypes = false,
  facets = false,
  actions,
}: {
  include?: InventoryItemColumnId[]
  /** Observed health disagreeing with the set status, per part. */
  driftFor?: (id: string) => SnmpDriftItem[]
  /** A transceiver's part ID links to its part on the Pluggables page
   * (the reader may view module types). */
  linkTypes?: boolean
  /** Filter facets on part, standard, device, site, port and cabled (a
   * flat list; the device inventory is a tree). */
  facets?: boolean
  /** Row actions; omitted, the table is read-only. */
  actions?: {
    onEdit: (r: InventoryItemRow) => void
    onDelete: (r: InventoryItemRow) => void
  }
} = {}): ColumnDef<InventoryItemRow, unknown>[] {
  const muted = (id: InventoryItemColumnId, label: string, mono = false) =>
    ({
      id,
      accessorFn: (r) => String(r[id as keyof InventoryItemRow] ?? ""),
      header: label,
      cell: ({ getValue }) => (
        <span className={mono ? "font-mono text-xs" : "text-muted-foreground"}>
          {getValue<string>() || "-"}
        </span>
      ),
    }) satisfies ColumnDef<InventoryItemRow, unknown>
  const byId: Record<
    InventoryItemColumnId,
    () => ColumnDef<InventoryItemRow, unknown>
  > = {
    name: () => ({
      id: "name",
      header: "Name",
      accessorFn: (r) => r.name,
      cell: ({ row }) => (
        <span
          className={row.original.parent ? "pl-6 font-medium" : "font-medium"}
        >
          {row.original.parent && (
            <span className="mr-1 text-muted-foreground">└</span>
          )}
          {row.original.name}
        </span>
      ),
    }),
    slot: () => muted("slot", "Slot"),
    // A transceiver's port (docs/dcim/inventory.md → Transceivers).
    port: () => ({
      id: "port",
      header: "Port",
      accessorFn: (r) => r.interface?.name ?? "",
      ...(facets
        ? {
            meta: {
              facet: {
                kind: "enum",
                label: "In a port",
                get: (r: InventoryItemRow) => (r.interface ? "port" : "spare"),
                formatValue: (v: string) => ({
                  label: v === "port" ? "In a port" : "Spare",
                }),
              },
            },
          }
        : {}),
      cell: ({ row }) => {
        const i = row.original.interface
        return i ? (
          <Link
            to="/interfaces/$id"
            params={{ id: i.id }}
            className="link font-mono text-xs"
          >
            {i.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">-</span>
        )
      },
    }),
    kind: () => ({
      id: "kind",
      accessorFn: (r) =>
        r.kind !== "other" ? (KIND_LABEL[r.kind] ?? r.kind) : "",
      header: "Kind",
      cell: ({ getValue }) => (
        <span className="text-muted-foreground">
          {getValue<string>() || "-"}
        </span>
      ),
    }),
    hardware: () => ({
      id: "hardware",
      header: "Hardware",
      accessorFn: (r) => hardwareSummary(r),
      cell: ({ getValue }) => (
        <span className="text-muted-foreground">
          {getValue<string>() || "-"}
        </span>
      ),
    }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: "Status",
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          <StatusBadge status={row.original.status} />
          {/* Observed health disagreeing with the set status is a difference
              to review, not a silent overwrite - same treatment interfaces
              get. Accepting stays in the drift inbox. */}
          {driftFor && <DriftBadge items={driftFor(row.original.id)} />}
        </span>
      ),
    }),
    manufacturer: () => ({
      id: "manufacturer",
      accessorFn: (r) => r.manufacturer?.name ?? "",
      header: "Manufacturer",
      cell: ({ getValue }) => (
        <span className="text-muted-foreground">
          {getValue<string>() || "-"}
        </span>
      ),
    }),
    part_id: () => ({
      id: "part_id",
      accessorFn: (r) => r.part_id,
      header: "Part ID",
      cell: ({ row }) => {
        const r = row.original
        const t = r.pluggable
        if (!r.part_id && !t)
          return <span className="text-muted-foreground">-</span>
        return linkTypes && t ? (
          <Link
            to="/pluggables/$id"
            params={{ id: t.id }}
            className="link font-mono text-xs"
          >
            {r.part_id || t.name}
          </Link>
        ) : (
          <span className="font-mono text-xs">{r.part_id || "-"}</span>
        )
      },
      ...(facets
        ? {
            meta: {
              facet: {
                kind: "enum",
                label: "Part",
                get: (r: InventoryItemRow) => r.part_id || "__none__",
                formatValue: (v: string) => ({
                  label: v === "__none__" ? "None" : v,
                }),
              },
            },
          }
        : {}),
    }),
    standard: () => ({
      ...muted("standard", "Standard"),
      ...(facets
        ? {
            meta: {
              facet: {
                kind: "enum",
                label: "Standard",
                get: (r: InventoryItemRow) => r.standard || "__none__",
                formatValue: (v: string) => ({
                  label: v === "__none__" ? "None" : v,
                }),
              },
            },
          }
        : {}),
    }),
    device: () => ({
      id: "device",
      header: "Device",
      accessorFn: (r) => r.device.name,
      cell: ({ row }) => (
        <Link
          to="/devices/$id"
          params={{ id: row.original.device.id }}
          className="link font-medium"
        >
          {row.original.device.name}
        </Link>
      ),
      ...(facets
        ? {
            meta: {
              facet: {
                kind: "enum",
                label: "Device",
                get: (r: InventoryItemRow) => r.device.id,
                formatValue: (_v: string, s: InventoryItemRow) => ({
                  label: s.device.name,
                }),
              },
            },
          }
        : {}),
    }),
    site: () => ({
      id: "site",
      header: "Site",
      accessorFn: (r) => r.site?.name ?? "",
      cell: ({ row }) => {
        const s = row.original.site
        return s ? (
          <Link to="/sites/$id" params={{ id: s.id }} className="link text-xs">
            {s.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">-</span>
        )
      },
      ...(facets
        ? {
            meta: {
              facet: {
                kind: "enum",
                label: "Site",
                get: (r: InventoryItemRow) => r.site?.id ?? "__none__",
                formatValue: (v: string, s: InventoryItemRow) => ({
                  label: v === "__none__" ? "No site" : (s.site?.name ?? v),
                }),
              },
            },
          }
        : {}),
    }),
    cabled: () => ({
      id: "cabled",
      header: "Cabled",
      accessorFn: (r) =>
        r.interface ? (r.interface.cabled ? "Yes" : "No") : "",
      cell: ({ getValue }) => (
        <span className="text-xs text-muted-foreground">
          {getValue<string>() || "-"}
        </span>
      ),
    }),
    serial_number: () => muted("serial_number", "Serial", true),
    description: () => ({
      id: "description",
      header: "Description",
      accessorFn: (r) => r.description,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    }),
    asset_tag: () => muted("asset_tag", "Asset tag", true),
  }
  return [
    ...include.map((id) => byId[id]()),
    ...(actions
      ? [
          actionsColumn<InventoryItemRow>({
            onEdit: actions.onEdit,
            onDelete: actions.onDelete,
          }),
        ]
      : []),
  ]
}
