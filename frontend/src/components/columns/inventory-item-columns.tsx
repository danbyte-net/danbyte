import type { ColumnDef } from "@tanstack/react-table"

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
  | "kind"
  | "hardware"
  | "status"
  | "manufacturer"
  | "part_id"
  | "serial_number"
  | "description"
  | "asset_tag"

export const INVENTORY_ITEM_COLUMNS: InventoryItemColumnId[] = [
  "name",
  "slot",
  "kind",
  "hardware",
  "status",
  "manufacturer",
  "part_id",
  "serial_number",
  "description",
  "asset_tag",
]

export function buildInventoryItemColumns({
  include = INVENTORY_ITEM_COLUMNS,
  driftFor,
  actions,
}: {
  include?: InventoryItemColumnId[]
  /** Observed health disagreeing with the set status, per part. */
  driftFor?: (id: string) => SnmpDriftItem[]
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
    part_id: () => muted("part_id", "Part ID", true),
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
