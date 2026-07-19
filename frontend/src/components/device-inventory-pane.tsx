import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type InventoryItemRow,
  type ManufacturerOption,
  type Paginated,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Section } from "@/components/ui/section"
import { useRegisterAddActions } from "@/components/device-add-actions"
import {
  FormCombobox,
  FormFooter,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

/** Serial-tracked physical parts on the device — PSUs, fans, CPUs, discrete
 * SFPs. Parts can nest one level visually (children indent under their
 * parent). */
export function DeviceInventoryPane({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canWrite = canDo("device", "change")
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<InventoryItemRow | null>(null)

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

  // Roots first, children directly under their parent.
  const items = q.data?.results ?? []
  const roots = items.filter((i) => !i.parent)
  const childrenOf = (id: string) => items.filter((i) => i.parent?.id === id)
  const ordered = roots.flatMap((r) => [r, ...childrenOf(r.id)])

  useRegisterAddActions(
    "inventory",
    canWrite
      ? [{ label: "Inventory part", onClick: () => setAdding(true) }]
      : []
  )

  return (
    <Section title="Inventory" count={items.length}>
      {q.isError ? (
        <QueryError error={q.error} />
      ) : q.isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No inventory items — serial-tracked parts (PSUs, fans, CPUs,
          transceivers) live here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Manufacturer</TableHead>
                <TableHead>Part ID</TableHead>
                <TableHead>Serial</TableHead>
                <TableHead>Asset tag</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordered.map((it) => (
                <TableRow key={it.id}>
                  <TableCell
                    className={it.parent ? "pl-8 font-medium" : "font-medium"}
                  >
                    {it.parent && (
                      <span className="mr-1 text-muted-foreground">└</span>
                    )}
                    {it.name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {it.manufacturer?.name ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {it.part_id || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {it.serial_number || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {it.asset_tag || "—"}
                  </TableCell>
                  <TableCell>
                    {canWrite && (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setEditing(it)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => del.mutate(it.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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

  useEffect(() => {
    if (!open) return
    setName(item?.name ?? "")
    setParentId(item?.parent?.id ?? null)
    setManufacturerId(item?.manufacturer?.id ?? null)
    setPartId(item?.part_id ?? "")
    setSerial(item?.serial_number ?? "")
    setAssetTag(item?.asset_tag ?? "")
    reset()
  }, [open, item, reset])

  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () =>
      api<Paginated<ManufacturerOption>>("/api/manufacturers/?picker=1"),
    enabled: open,
    staleTime: 10 * 60_000,
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
            placeholder="PSU 1"
            error={fieldErrors.name}
          />
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
