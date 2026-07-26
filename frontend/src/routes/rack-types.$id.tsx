import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  DeviceTypeOption,
  Paginated,
  Rack,
  RackMount,
  RackType,
  RackTypeAccessory,
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
import {
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { DataTable } from "@/components/data-table"
import { buildRackColumns } from "@/components/columns/rack-columns"
import { QueryError } from "@/components/query-error"
import { RackTypeDeleteDialog } from "@/routes/rack-types.index"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/rack-types/$id")({
  component: RackTypeDetail,
})

const MOUNTS: { value: RackMount; label: string }[] = [
  { value: "side_left", label: "Left rail" },
  { value: "side_right", label: "Right rail" },
]

export function mountLabel(mount: RackMount): string {
  return mount === "side_left" ? "Left rail" : "Right rail"
}

function RackTypeDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["rack-type", id],
    queryFn: () => api<RackType>(`/api/rack-types/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body rackType={q.data} />
}

function Body({ rackType: rt }: { rackType: RackType }) {
  const [tab, setTab] = useUrlTab<"overview" | "racks" | "journal" | "history">(
    "overview"
  )
  const { canDo } = useMe()
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<RackType | null>(null)

  const rows: KvRow[] = [
    {
      label: "Manufacturer",
      value: rt.manufacturer ? (
        <Link
          to="/manufacturers/$id"
          params={{ id: rt.manufacturer.id }}
          className="text-primary hover:underline"
        >
          {rt.manufacturer.name}
        </Link>
      ) : (
        dash
      ),
    },
    { label: "Rail width", value: `${rt.width}″` },
    { label: "Height", value: `${rt.u_height}U` },
    {
      label: "Unit numbering",
      value: rt.desc_units
        ? `descending from U${rt.starting_unit}`
        : `ascending from U${rt.starting_unit}`,
    },
    {
      label: "Outer width",
      value: rt.outer_width_mm != null ? `${rt.outer_width_mm} mm` : dash,
    },
    {
      label: "Outer depth",
      value: rt.outer_depth_mm != null ? `${rt.outer_depth_mm} mm` : dash,
    },
    {
      label: "Weight budget",
      value: rt.max_weight ? `${rt.max_weight} ${rt.max_weight_unit}` : dash,
    },
  ]

  return (
    <DetailShell
      backTo="/rack-types"
      backLabel="Rack types"
      title={rt.name}
      actions={
        <>
          {canDo("racktype", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/rack-types/$id/edit" params={{ id: rt.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("racktype", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(rt)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={<DetailHero title={rt.name} description={rt.description} />}
      tabs={[
        { value: "overview", label: "Overview", count: rt.accessories.length },
        { value: "racks", label: "Racks", count: rt.rack_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Cabinet model" rows={rows} />
        </div>
        <div className="mt-6">
          <AccessoriesPane rackTypeId={rt.id} />
        </div>
      </DetailTab>
      <DetailTab value="racks">
        <RacksOfTypePane rackTypeId={rt.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.racktype" objectId={rt.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.racktype" objectId={rt.id} />
      </DetailTab>

      <RackTypeDeleteDialog
        rackType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={() => nav({ to: "/rack-types" })}
      />
    </DetailShell>
  )
}

/** The factory-fitted 0U strips this model ships with — one side-mounted
 * device each when a new rack opts into stamping. */
function AccessoriesPane({ rackTypeId }: { rackTypeId: string }) {
  const { canDo } = useMe()
  const canWrite = canDo("racktypeaccessory", "change")
  const canAdd = canDo("racktypeaccessory", "add")
  const canRemove = canDo("racktypeaccessory", "delete")
  const qc = useQueryClient()
  const [editing, setEditing] = useState<RackTypeAccessory | null>(null)
  const [adding, setAdding] = useState(false)

  const q = useQuery({
    queryKey: ["rack-type-accessories", rackTypeId],
    queryFn: () =>
      api<Paginated<RackTypeAccessory>>(
        `/api/rack-type-accessories/?rack_type=${rackTypeId}`
      ),
  })
  const del = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/rack-type-accessories/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rack-type-accessories", rackTypeId] })
      qc.invalidateQueries({ queryKey: ["rack-type", rackTypeId] })
    },
    onError: (err) => apiErrorToast(err),
  })
  const rows = q.data?.results ?? []

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Accessories
        </h3>
        {canAdd && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        )}
      </div>
      {q.isError ? (
        <QueryError error={q.error} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No accessories. Add the strips this cabinet ships with — e.g. two
          vertical PDUs — and new racks of this type can stamp them as
          side-mounted devices automatically.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Device type</TableHead>
                <TableHead>Rail</TableHead>
                <TableHead>Offset</TableHead>
                <TableHead>Span</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono font-medium">
                    {a.label}
                  </TableCell>
                  <TableCell className="text-xs">
                    {a.device_type.manufacturer
                      ? `${a.device_type.manufacturer} ${a.device_type.name}`
                      : a.device_type.name}
                  </TableCell>
                  <TableCell className="text-xs">
                    {mountLabel(a.mount)}
                  </TableCell>
                  <TableCell className="num text-xs">
                    {a.mount_offset_mm != null
                      ? `${a.mount_offset_mm} mm`
                      : "—"}
                  </TableCell>
                  <TableCell className="num text-xs">
                    {a.mount_span_u != null ? `${a.mount_span_u}U` : "auto"}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {canWrite && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setEditing(a)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canRemove && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => del.mutate(a.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AccessoryDialog
        rackTypeId={rackTypeId}
        accessory={editing}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      />
    </section>
  )
}

function AccessoryDialog({
  rackTypeId,
  accessory,
  open,
  onOpenChange,
}: {
  rackTypeId: string
  accessory: RackTypeAccessory | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [label, setLabel] = useState("")
  const [deviceTypeId, setDeviceTypeId] = useState<string | null>(null)
  const [mount, setMount] = useState<RackMount>("side_left")
  const [offset, setOffset] = useState("")
  const [span, setSpan] = useState("")

  useEffect(() => {
    if (!open) return
    setLabel(accessory?.label ?? "")
    setDeviceTypeId(accessory?.device_type.id ?? null)
    setMount(accessory?.mount ?? "side_left")
    setOffset(
      accessory?.mount_offset_mm != null
        ? String(accessory.mount_offset_mm)
        : ""
    )
    setSpan(
      accessory?.mount_span_u != null ? String(accessory.mount_span_u) : ""
    )
    reset()
  }, [open, accessory, reset])

  // Accessories side-mount, so only 0U device types qualify.
  const deviceTypes = useQuery({
    queryKey: ["device-types-picker"],
    queryFn: () =>
      api<Paginated<DeviceTypeOption>>("/api/device-types/?picker=1"),
    staleTime: 10 * 60_000,
    enabled: open,
  })
  const zeroU = useMemo(
    () => (deviceTypes.data?.results ?? []).filter((dt) => dt.u_height === 0),
    [deviceTypes.data]
  )

  const editing = !!accessory
  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        rack_type_id: rackTypeId,
        device_type_id: deviceTypeId ?? "",
        label: label.trim(),
        mount,
        mount_offset_mm: offset.trim() === "" ? null : Number(offset),
        mount_span_u: span.trim() === "" ? null : Number(span),
      }
      if (editing)
        return api<RackTypeAccessory>(
          `/api/rack-type-accessories/${accessory.id}/`,
          { method: "PATCH", body: JSON.stringify(payload) }
        )
      return api<RackTypeAccessory>("/api/rack-type-accessories/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rack-type-accessories", rackTypeId] })
      qc.invalidateQueries({ queryKey: ["rack-type", rackTypeId] })
      toast.success(editing ? "Accessory updated" : "Accessory added")
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit accessory" : "Add accessory"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <FormText
            label="Label"
            required
            autoFocus
            value={label}
            onChange={setLabel}
            mono
            placeholder="PDU-A"
            hint="Stamped devices are named {rack}-{label}"
            error={fieldErrors.label}
          />
          <FormCombobox
            label="Device type"
            value={deviceTypeId}
            onChange={setDeviceTypeId}
            placeholder={
              zeroU.length === 0 && deviceTypes.data
                ? "No 0U device types yet"
                : "Pick a 0U device type"
            }
            searchPlaceholder="Search device types…"
            emptyText="No 0U device types — vertical strips need a 0U type."
            options={zeroU.map((dt) => ({ value: dt.id, label: dt.name }))}
            error={fieldErrors.device_type_id}
          />
          <div className="grid grid-cols-3 gap-3">
            <FormSelect
              label="Rail"
              value={mount}
              onChange={(v) => v && setMount(v as RackMount)}
              options={MOUNTS.map((m) => ({ value: m.value, label: m.label }))}
              error={fieldErrors.mount}
            />
            <FormText
              label="Offset (mm)"
              hint="optional — above the base"
              type="number"
              min={0}
              value={offset}
              onChange={setOffset}
              error={fieldErrors.mount_offset_mm}
            />
            <FormText
              label="Span (U)"
              hint="optional — blank ≈ ¾ rack"
              type="number"
              min={1}
              max={60}
              value={span}
              onChange={setSpan}
              error={fieldErrors.mount_span_u}
            />
          </div>
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={editing ? "Save changes" : "Add accessory"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Racks built as this model, and a one-click way to add another. */
function RacksOfTypePane({ rackTypeId }: { rackTypeId: string }) {
  const { canDo, humanIds } = useMe()
  const q = useQuery({
    queryKey: ["racks", { rack_type: rackTypeId }],
    queryFn: () => api<Paginated<Rack>>(`/api/racks/?rack_type=${rackTypeId}`),
  })
  const columns = useMemo(
    () =>
      buildRackColumns({
        humanIds,
        include: ["numid", "name", "site", "role", "height", "devices"],
      }),
    [humanIds]
  )
  const rows = q.data?.results ?? []
  // Lands on the rack form with this model already picked and its dims filled.
  const addButton = canDo("rack", "add") ? (
    <Button size="sm" asChild>
      <Link to="/racks/new" search={{ rack_type: rackTypeId }}>
        <Plus className="h-3.5 w-3.5" /> Add rack
      </Link>
    </Button>
  ) : null

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Racks of this type
        </h3>
        {addButton}
      </div>
      {q.isError ? (
        <QueryError error={q.error} />
      ) : q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No racks use this type yet — add one here, or pick the type on any
          rack's form.
        </p>
      ) : (
        <DataTable data={rows} columns={columns} tableId="rack-type-racks" />
      )}
    </section>
  )
}
