import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  bytesToUnit,
  formatBytes,
  INVENTORY_KIND_OPTIONS,
  INVENTORY_MEDIA_OPTIONS,
  inventorySpeedSuggestions,
  STORAGE_UNITS,
  unitToBytes,
  type InventoryItemKind,
  type InventoryItemRow,
  type InventoryMedia,
  type ManufacturerOption,
  type Paginated,
  type Status,
  type StorageUnit,
} from "@/lib/api"
import type { ColumnDef } from "@tanstack/react-table"
import { StatusBadge } from "@/components/status-badge"
import { DataTable, selectionColumn } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Section } from "@/components/ui/section"
import { useRegisterAddActions } from "@/components/device-add-actions"
import {
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

const KIND_LABEL = Object.fromEntries(
  INVENTORY_KIND_OPTIONS.map((k) => [k.value, k.label])
)
const MEDIA_LABEL = Object.fromEntries(
  INVENTORY_MEDIA_OPTIONS.map((m) => [m.value, m.label])
)

/** "NVMe · 1.92 TB · PCIe 4.0" — the composed hardware summary cell. */
function hardwareSummary(it: InventoryItemRow): string {
  return [
    it.media ? MEDIA_LABEL[it.media] : "",
    formatBytes(it.capacity_bytes),
    it.speed,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Serial-tracked physical parts on the device — disks, CPUs, RAM, PSUs,
 * fans, discrete SFPs. Parts can nest one level visually (children indent
 * under their parent). */
export function DeviceInventoryPane({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canWrite = canDo("device", "change")
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<InventoryItemRow | null>(null)
  // Bulk selection — tick rows, the shared bulk bar floats up.
  const [selected, setSelected] = useState<InventoryItemRow[]>([])

  const q = useQuery({
    queryKey: ["device-inventory", deviceId],
    queryFn: () =>
      api<Paginated<InventoryItemRow>>(
        `/api/inventory-items/?device=${deviceId}&page_size=500`
      ),
  })
  const del = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/inventory-items/${id}/`, { method: "DELETE" }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["device-inventory", deviceId] }),
    onError: (err) => apiErrorToast(err),
  })
  const delMutate = del.mutate

  // Roots first, children directly under their parent. Memoised: a fresh
  // array each render changes DataTable's `data` identity, which re-fires its
  // selection effect and locks the pane in a render loop.
  const items = q.data?.results ?? []
  const ordered = useMemo(() => {
    const rows = q.data?.results ?? []
    const roots = rows.filter((i) => !i.parent)
    return roots.flatMap((r) => [
      r,
      ...rows.filter((i) => i.parent?.id === r.id),
    ])
  }, [q.data])

  useRegisterAddActions(
    "inventory",
    canWrite
      ? [{ label: "Inventory part", onClick: () => setAdding(true) }]
      : []
  )

  // Shared column factory — same DataTable/selection/actions primitives every
  // other component pane uses, so Hardware reads and behaves identically.
  const columns = useMemo<ColumnDef<InventoryItemRow, unknown>[]>(
    () => [
      ...(canWrite ? [selectionColumn<InventoryItemRow>()] : []),
      {
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
      },
      {
        id: "kind",
        header: "Kind",
        accessorFn: (r) =>
          r.kind && r.kind !== "other" ? KIND_LABEL[r.kind] : "",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.kind && row.original.kind !== "other"
              ? (KIND_LABEL[row.original.kind] ?? row.original.kind)
              : "—"}
          </span>
        ),
      },
      {
        id: "hardware",
        header: "Hardware",
        accessorFn: (r) => hardwareSummary(r),
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {hardwareSummary(row.original) || "—"}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (r) => r.status?.name ?? "",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "manufacturer",
        header: "Manufacturer",
        accessorFn: (r) => r.manufacturer?.name ?? "",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.manufacturer?.name ?? "—"}
          </span>
        ),
      },
      {
        id: "part_id",
        header: "Part ID",
        accessorFn: (r) => r.part_id,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.part_id || "—"}
          </span>
        ),
      },
      {
        id: "serial_number",
        header: "Serial",
        accessorFn: (r) => r.serial_number,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.serial_number || "—"}
          </span>
        ),
      },
      {
        id: "asset_tag",
        header: "Asset tag",
        accessorFn: (r) => r.asset_tag,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.asset_tag || "—"}
          </span>
        ),
      },
      ...(canWrite
        ? [
            actionsColumn<InventoryItemRow>({
              onEdit: setEditing,
              onDelete: (r) => delMutate(r.id),
            }),
          ]
        : []),
      // Memoised: an inline array is a new identity every render, which makes
      // DataTable's selection effect loop and locks the pane up.
    ],
    [canWrite, delMutate]
  )

  return (
    <Section title="Inventory" count={items.length}>
      {q.isError ? (
        <QueryError error={q.error} />
      ) : q.isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No inventory items — serial-tracked parts (disks, PSUs, fans, CPUs,
          transceivers) live here.
        </p>
      ) : (
        <DataTable
          data={ordered}
          columns={columns}
          embedded
          searchable
          searchPlaceholder="Search parts…"
          onSelectedRowsChange={setSelected}
        />
      )}

      {canWrite && (
        <ComponentBulkBar
          endpoint="/api/inventory-items/"
          kindLabel="part"
          selected={selected}
          onCleared={() => setSelected([])}
          invalidate={[["device-inventory", deviceId]]}
          fields={[
            {
              key: "status_id",
              label: "Status",
              kind: "status",
              statusModel: "inventoryitem",
            },
            {
              key: "kind",
              label: "Kind",
              kind: "options",
              options: INVENTORY_KIND_OPTIONS,
            },
            {
              key: "media",
              label: "Media",
              kind: "options",
              options: INVENTORY_MEDIA_OPTIONS,
              hint: "disks only",
            },
            { key: "capacity_bytes", label: "Capacity", kind: "bytes" },
            {
              key: "speed",
              label: "Speed",
              kind: "text",
              // Mixed selections can span kinds, so offer every known value.
              suggestions: inventorySpeedSuggestions(),
            },
            { key: "part_id", label: "Part ID", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
          ]}
          tags
        />
      )}

      <InventoryItemDialog
        deviceId={deviceId}
        item={editing}
        siblings={items}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      />
    </Section>
  )
}

function InventoryItemDialog({
  deviceId,
  item,
  siblings,
  open,
  onOpenChange,
}: {
  deviceId: string
  item: InventoryItemRow | null
  siblings: InventoryItemRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState("")
  const [parentId, setParentId] = useState<string | null>(null)
  const [manufacturerId, setManufacturerId] = useState<string | null>(null)
  const [partId, setPartId] = useState("")
  const [serial, setSerial] = useState("")
  const [assetTag, setAssetTag] = useState("")
  const [kind, setKind] = useState<InventoryItemKind>("other")
  const [media, setMedia] = useState<InventoryMedia>("")
  const [capacity, setCapacity] = useState("")
  const [capacityUnit, setCapacityUnit] = useState<StorageUnit>("GB")
  const [speed, setSpeed] = useState("")
  const [statusId, setStatusId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(item?.name ?? "")
    setParentId(item?.parent?.id ?? null)
    setManufacturerId(item?.manufacturer?.id ?? null)
    setPartId(item?.part_id ?? "")
    setSerial(item?.serial_number ?? "")
    setAssetTag(item?.asset_tag ?? "")
    setKind(item?.kind ?? "other")
    setMedia(item?.media ?? "")
    const cap = bytesToUnit(item?.capacity_bytes ?? null)
    setCapacity(cap.value)
    setCapacityUnit(cap.unit)
    setSpeed(item?.speed ?? "")
    setStatusId(item?.status?.id ?? null)
    reset()
  }, [open, item, reset])

  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () =>
      api<Paginated<ManufacturerOption>>("/api/manufacturers/?picker=1"),
    enabled: open,
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "inventoryitem"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=inventoryitem&picker=1"
      ),
    enabled: open,
    staleTime: 5 * 60_000,
  })

  const editing = !!item
  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        device_id: deviceId,
        name: name.trim(),
        parent_id: parentId,
        manufacturer_id: manufacturerId,
        part_id: partId.trim(),
        serial_number: serial.trim(),
        asset_tag: assetTag.trim(),
        kind,
        media: kind === "disk" ? media : "",
        capacity_bytes: unitToBytes(capacity, capacityUnit),
        speed: speed.trim(),
        status_id: statusId,
      }
      if (editing)
        return api<InventoryItemRow>(`/api/inventory-items/${item!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<InventoryItemRow>("/api/inventory-items/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device-inventory", deviceId] })
      toast.success(editing ? "Part updated" : "Part added")
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const parentOptions = siblings
    .filter((s) => s.id !== item?.id && !s.parent) // one visual level
    .map((s) => ({ value: s.id, label: s.name }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit part" : "Add part"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <FormText
            label="Name"
            required
            autoFocus
            value={name}
            onChange={setName}
            placeholder="Disk 1"
            error={fieldErrors.name}
          />
          <div className="grid grid-cols-2 gap-3">
            <FormSelect
              label="Kind"
              value={kind}
              onChange={(v) => v && setKind(v as InventoryItemKind)}
              options={INVENTORY_KIND_OPTIONS}
              error={fieldErrors.kind}
            />
            <FormCombobox
              label="Status"
              value={statusId}
              onChange={setStatusId}
              noneLabel="No status"
              placeholder="Select a status…"
              options={(statuses.data?.results ?? []).map((s) => ({
                value: s.id,
                label: s.name,
              }))}
              error={fieldErrors.status_id}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            {kind === "disk" && (
              <FormSelect
                label="Media"
                value={media || null}
                onChange={(v) => setMedia((v ?? "") as InventoryMedia)}
                options={INVENTORY_MEDIA_OPTIONS}
                placeholder="—"
                error={fieldErrors.media}
              />
            )}
            <FormText
              label="Speed"
              value={speed}
              onChange={setSpeed}
              placeholder="7200 RPM / PCIe 4.0 x4"
              suggestions={inventorySpeedSuggestions(kind, media)}
              error={fieldErrors.speed}
            />
          </div>
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <FormText
              label="Capacity"
              type="number"
              value={capacity}
              onChange={setCapacity}
              error={fieldErrors.capacity_bytes}
            />
            <FormSelect
              label="Unit"
              value={capacityUnit}
              onChange={(v) => v && setCapacityUnit(v as StorageUnit)}
              options={STORAGE_UNITS.map((u) => ({
                value: u.value,
                label: u.value,
              }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormCombobox
              label="Parent part"
              hint="optional"
              value={parentId}
              onChange={setParentId}
              noneLabel="Top level"
              placeholder="Top level"
              searchPlaceholder="Search parts…"
              emptyText="No other parts."
              options={parentOptions}
              error={fieldErrors.parent_id}
            />
            <FormCombobox
              label="Manufacturer"
              hint="optional"
              value={manufacturerId}
              onChange={setManufacturerId}
              noneLabel="No manufacturer"
              placeholder="No manufacturer"
              searchPlaceholder="Search…"
              emptyText="No manufacturers."
              options={(manufacturers.data?.results ?? []).map((m) => ({
                value: m.id,
                label: m.name,
              }))}
              error={fieldErrors.manufacturer_id}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <FormText
              label="Part ID"
              value={partId}
              onChange={setPartId}
              mono
              error={fieldErrors.part_id}
            />
            <FormText
              label="Serial"
              value={serial}
              onChange={setSerial}
              mono
              error={fieldErrors.serial_number}
            />
            <FormText
              label="Asset tag"
              value={assetTag}
              onChange={setAssetTag}
              mono
              error={fieldErrors.asset_tag}
            />
          </div>
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={editing ? "Save changes" : "Add part"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
