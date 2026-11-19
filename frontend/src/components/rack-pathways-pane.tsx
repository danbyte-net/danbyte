import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Eye, EyeOff, Plus, RotateCcw } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  AccessoryType,
  Device,
  RackPathwayKind,
  RackPathwayRow,
  ResolvedPathway,
  ResolvedPathways,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import {
  KIND_LABEL,
  SUBKINDS,
  SUBKIND_LABEL,
  changedPayload,
  formOf,
  fullPayload,
  isOwn,
  resetPayload,
} from "@/lib/rack-pathways"
import type { PathwayForm } from "@/lib/rack-pathways"
import { Button } from "@/components/ui/button"
import { IconTip } from "@/components/icon-tip"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCombobox,
  FormFooter,
  FormRow,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { DataTable } from "@/components/data-table"
import { buildRackPathwayColumns } from "@/components/columns/rack-pathway-columns"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

type Owner =
  | { rackId: string; rackTypeId?: never }
  | { rackTypeId: string; rackId?: never }

const ENDPOINT = "/api/rack-pathways/"

function send(id: string | null, body: Record<string, unknown>) {
  return api<RackPathwayRow>(id ? `${ENDPOINT}${id}/` : ENDPOINT, {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(body),
  })
}

function ownerBody(o: Owner): Record<string, string> {
  return o.rackId ? { rack_id: o.rackId } : { rack_type_id: o.rackTypeId ?? "" }
}

function ownerParams(o: Owner): string {
  return o.rackId ? `rack=${o.rackId}` : `rack_type=${o.rackTypeId}`
}

export function pathwaysKey(o: Owner) {
  return ["rack-pathways", o.rackId ?? o.rackTypeId]
}

/** A rack's or rack type's pathways (docs/dcim/racks.md → Pathways): what
 * it inherits from its kit, frame and type, and its own. */
export function RackPathwaysPane(owner: Owner) {
  const level = owner.rackId ? "rack" : "type"
  const { canDo } = useMe()
  const typeOk = level === "rack" || canDo("racktype", "change")
  const canAdd = canDo("rackpathway", "add") && typeOk
  const canChange = canDo("rackpathway", "change") && typeOk
  const canDelete = canDo("rackpathway", "delete") && typeOk
  const qc = useQueryClient()
  const [editing, setEditing] = useState<ResolvedPathway | null>(null)
  const [adding, setAdding] = useState(false)

  const q = useQuery({
    queryKey: pathwaysKey(owner),
    queryFn: () =>
      api<ResolvedPathways>(`${ENDPOINT}resolved/?${ownerParams(owner)}`),
  })
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: pathwaysKey(owner) })

  // An inherited pathway's row: patched when there is one, else made.
  const overlay = useMutation({
    mutationFn: ({
      p,
      body,
    }: {
      p: ResolvedPathway
      body: Record<string, unknown>
    }) =>
      p.id
        ? send(p.id, body)
        : send(null, { ...ownerBody(owner), key: p.key, ...body }),
    onSuccess: invalidate,
    onError: (err) => apiErrorToast(err),
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api<void>(`${ENDPOINT}${id}/`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError: (err) => apiErrorToast(err),
  })

  const columns = useMemo(
    () =>
      buildRackPathwayColumns({
        include:
          level === "rack"
            ? [
                "name",
                "source",
                "kind",
                "subkind",
                "where",
                "units",
                "size",
                "fill",
                "devices",
                "model",
              ]
            : [
                "name",
                "source",
                "kind",
                "subkind",
                "where",
                "units",
                "size",
                "fill",
                "model",
              ],
        actions: {
          onEdit: (p) => setEditing(p),
          canEdit: (p) =>
            canChange && !p.orphan && (isOwn(p, level) || canAdd || !!p.id),
          onDelete: (p) => p.id && remove.mutate(p.id),
          canDelete: (p) =>
            canDelete && !!p.id && (isOwn(p, level) || p.orphan),
          extra: (p) => {
            if (isOwn(p, level) || p.orphan || !(canChange && (canAdd || p.id)))
              return null
            return (
              <>
                {p.id && p.overridden.length > 0 && (
                  <IconTip label="Reset">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        overlay.mutate({ p, body: resetPayload() })
                      }
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </IconTip>
                )}
                <IconTip label={p.hidden ? "Show" : "Hide"}>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      overlay.mutate({ p, body: { hidden: !p.hidden } })
                    }
                  >
                    {p.hidden ? (
                      <Eye className="h-3.5 w-3.5" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </IconTip>
              </>
            )
          },
        },
      }),
    [level, canAdd, canChange, canDelete, overlay, remove]
  )

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const doc = q.data
  if (!doc) return null

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {doc.kit ? `Kit ${doc.kit.name}` : "No kit"} · U{doc.units[0]}-U
          {doc.units[1]}
        </p>
        {canAdd && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        )}
      </div>
      {doc.items.length === 0 ? (
        <EmptyState title="No pathways" />
      ) : (
        <DataTable
          data={doc.items}
          columns={columns}
          tableId={level === "rack" ? "rack-pathways" : "rack-type-pathways"}
          searchable={false}
          unpaged
          rowClassName={(p) => (p.hidden ? "text-muted-foreground" : undefined)}
        />
      )}
      <PathwayDialog
        owner={owner}
        level={level}
        pathway={editing}
        defaultFill={doc.fill_limit_pct}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
        onSaved={invalidate}
      />
    </section>
  )
}

const KINDS: RackPathwayKind[] = ["vertical", "horizontal", "entry", "channel"]

function PathwayDialog({
  owner,
  level,
  pathway,
  defaultFill,
  open,
  onOpenChange,
  onSaved,
}: {
  owner: Owner
  level: "rack" | "type"
  pathway: ResolvedPathway | null
  defaultFill: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [form, setForm] = useState<PathwayForm>(() => formOf(null))
  const [initial, setInitial] = useState<PathwayForm>(() => formOf(null))
  const [accessory, setAccessory] = useState<string | null>(null)
  const [device, setDevice] = useState<string | null>(null)
  const own = pathway ? isOwn(pathway, level) : true

  useEffect(() => {
    if (!open) return
    const f = formOf(pathway, defaultFill)
    if (!pathway) f.kind = "vertical"
    setForm(f)
    setInitial(f)
    setAccessory(pathway?.accessory_type?.id ?? null)
    setDevice(pathway?.device?.id ?? null)
    reset()
  }, [open, pathway, defaultFill, reset])

  const set = (k: keyof PathwayForm) => (v: string | null) =>
    setForm((f) => ({ ...f, [k]: v ?? "" }))
  const kind = (form.kind || "vertical") as RackPathwayKind

  const managers = useQuery({
    queryKey: ["accessory-types", "cable-manager"],
    queryFn: () =>
      apiAll<AccessoryType>("/api/accessory-types/?kind=cable-manager"),
    enabled: open && (kind === "vertical" || kind === "horizontal"),
    staleTime: 5 * 60_000,
  })
  const managerOptions = (managers.data?.results ?? [])
    .filter((a) => (kind === "vertical" ? !a.u_height : !!a.u_height))
    .map((a) => ({ value: a.id, label: a.name }))
  const devices = useQuery({
    queryKey: ["devices", { rack: owner.rackId, picker: "pathway" }],
    queryFn: () => apiAll<Device>(`/api/devices/?rack=${owner.rackId}`),
    enabled: open && !!owner.rackId && kind === "horizontal",
  })
  const deviceOptions = (devices.data?.results ?? [])
    .filter((d) => d.position != null)
    .map((d) => ({ value: d.id, label: `${d.name} · U${d.position}` }))

  const mutation = useMutation({
    mutationFn: () => {
      const refs = {
        accessory_type_id: accessory,
        ...(owner.rackId
          ? { device_id: kind === "horizontal" ? device : null }
          : {}),
      }
      if (pathway && !own) {
        const body: Record<string, unknown> = changedPayload(initial, form)
        if (accessory !== (pathway.accessory_type?.id ?? null))
          body.accessory_type_id = accessory
        if (owner.rackId && device !== (pathway.device?.id ?? null))
          body.device_id = device
        return pathway.id
          ? send(pathway.id, body)
          : send(null, { ...ownerBody(owner), key: pathway.key, ...body })
      }
      const body = { ...fullPayload(form), ...refs }
      return pathway?.id
        ? send(pathway.id, body)
        : send(null, { ...ownerBody(owner), ...body })
    },
    onSuccess: () => {
      onSaved()
      toast.success(pathway ? "Pathway saved" : "Pathway added")
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const sided =
    kind === "vertical" || kind === "channel" || form.surface === "side"
  const faces =
    kind === "channel"
      ? [
          { value: "front", label: "Front" },
          { value: "rear", label: "Rear" },
        ]
      : [
          { value: "front", label: "Front" },
          { value: "rear", label: "Rear" },
          { value: "full", label: "Full depth" },
        ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {pathway ? `Edit ${pathway.label}` : "Add pathway"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <FormRow>
            <FormSelect
              label="Kind"
              value={kind}
              disabled={!!pathway}
              onChange={(v) =>
                v && setForm((f) => ({ ...f, kind: v, subkind: "" }))
              }
              options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
              error={fieldErrors.kind}
            />
            <FormText
              label="Name"
              value={form.name}
              onChange={set("name")}
              placeholder={pathway?.label}
              error={fieldErrors.name}
            />
          </FormRow>
          <FormRow>
            {SUBKINDS[kind].length > 0 && (
              <FormSelect
                label="Type"
                value={form.subkind || null}
                onChange={set("subkind")}
                noneLabel="None"
                options={SUBKINDS[kind].map((s) => ({
                  value: s,
                  label: SUBKIND_LABEL[s],
                }))}
                error={fieldErrors.subkind}
              />
            )}
            {kind === "entry" && (
              <FormSelect
                label="Surface"
                value={form.surface || null}
                onChange={set("surface")}
                options={[
                  { value: "top", label: "Roof" },
                  { value: "bottom", label: "Floor" },
                  { value: "side", label: "Side panel" },
                ]}
                error={fieldErrors.surface}
              />
            )}
          </FormRow>
          <FormRow>
            {sided && (
              <FormSelect
                label="Side"
                value={form.side || null}
                onChange={set("side")}
                options={[
                  { value: "left", label: "Left" },
                  { value: "right", label: "Right" },
                ]}
                error={fieldErrors.side}
              />
            )}
            {kind !== "entry" && (
              <FormSelect
                label="Face"
                value={form.face || null}
                onChange={set("face")}
                options={faces}
                error={fieldErrors.face}
              />
            )}
          </FormRow>
          {kind !== "entry" && (
            <FormRow>
              <FormText
                label="From"
                hint="U"
                type="number"
                min={1}
                value={form.u_from}
                onChange={set("u_from")}
                error={fieldErrors.u_from}
              />
              <FormText
                label="To"
                hint="U"
                type="number"
                min={1}
                value={form.u_to}
                onChange={set("u_to")}
                error={fieldErrors.u_to}
              />
            </FormRow>
          )}
          {kind === "channel" ? (
            <FormRow>
              <FormText
                label="Offset"
                hint="mm"
                type="number"
                min={0}
                value={form.offset_mm}
                onChange={set("offset_mm")}
                error={fieldErrors.offset_mm}
              />
              <FormText
                label="Depth"
                hint="mm"
                type="number"
                min={0}
                value={form.depth_mm}
                onChange={set("depth_mm")}
                error={fieldErrors.depth_mm}
              />
            </FormRow>
          ) : (
            <FormRow cols={3}>
              <FormText
                label="Width"
                hint="mm"
                type="number"
                min={1}
                value={form.inner_w_mm}
                onChange={set("inner_w_mm")}
                error={fieldErrors.inner_w_mm}
              />
              <FormText
                label={kind === "entry" ? "Height" : "Depth"}
                hint="mm"
                type="number"
                min={1}
                value={form.inner_d_mm}
                onChange={set("inner_d_mm")}
                error={fieldErrors.inner_d_mm}
              />
              <FormText
                label="Fill limit"
                hint="%"
                type="number"
                min={1}
                max={100}
                placeholder={String(defaultFill)}
                value={form.fill_limit_pct}
                onChange={set("fill_limit_pct")}
                error={fieldErrors.fill_limit_pct}
              />
            </FormRow>
          )}
          {kind === "entry" && (
            <FormRow>
              <FormText
                label="Across"
                hint="mm"
                type="number"
                value={form.x_mm}
                onChange={set("x_mm")}
                error={fieldErrors.x_mm}
              />
              <FormText
                label="Back"
                hint="mm"
                type="number"
                min={0}
                value={form.y_mm}
                onChange={set("y_mm")}
                error={fieldErrors.y_mm}
              />
            </FormRow>
          )}
          {(kind === "vertical" || kind === "horizontal") && (
            <FormCombobox
              label="Model"
              value={accessory}
              onChange={setAccessory}
              noneLabel="None"
              placeholder="No model"
              searchPlaceholder="Search cable managers…"
              emptyText="No cable managers"
              options={managerOptions}
              error={fieldErrors.accessory_type_id}
            />
          )}
          {kind === "horizontal" && owner.rackId && (
            <FormCombobox
              label="Device"
              value={device}
              onChange={setDevice}
              noneLabel="None"
              placeholder="No device"
              searchPlaceholder="Search devices…"
              emptyText="No devices in units"
              options={deviceOptions}
              error={fieldErrors.device_id}
            />
          )}
          <FormTextarea
            label="Description"
            value={form.description}
            onChange={(v) => set("description")(v)}
            rows={2}
            error={fieldErrors.description}
          />
          {(fieldErrors.key || fieldErrors.rack_id) && (
            <p className="text-sm text-destructive">
              {fieldErrors.key || fieldErrors.rack_id}
            </p>
          )}
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={pathway ? "Save changes" : "Add pathway"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
