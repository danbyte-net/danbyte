import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  bytesToUnit,
  INVENTORY_KIND_OPTIONS,
  INVENTORY_MEDIA_OPTIONS,
  inventorySpeedSuggestions,
  STORAGE_UNITS,
  unitToBytes,
  type StorageUnit,
} from "@/lib/api"
import type {
  ComponentTemplateBase,
  ComponentTemplateWritePayload,
  DcimChoice,
  FrontPortTemplate,
  InterfaceTemplate,
  InventoryItemKind,
  InventoryMedia,
  Paginated,
  PowerOutletTemplate,
  PowerPortTemplate,
  RearPortTemplate,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { expandNameRange } from "@/lib/name-range"
import { useDcimChoices } from "@/lib/use-dcim-choices"

/** The nine device-type component-template kinds, one dialog for all. */
export type TemplateKind =
  | "interface"
  | "console-port"
  | "console-server-port"
  | "power-port"
  | "power-outlet"
  | "rear-port"
  | "front-port"
  | "aux-port"
  | "module-bay"
  | "device-bay"
  | "inventory-item"

export const TEMPLATE_ENDPOINT: Record<TemplateKind, string> = {
  interface: "interface-templates",
  "console-port": "console-port-templates",
  "console-server-port": "console-server-port-templates",
  "power-port": "power-port-templates",
  "power-outlet": "power-outlet-templates",
  "rear-port": "rear-port-templates",
  "front-port": "front-port-templates",
  "aux-port": "aux-port-templates",
  "module-bay": "module-bay-templates",
  "device-bay": "device-bay-templates",
  "inventory-item": "inventory-item-templates",
}

export const TEMPLATE_QUERY_KEY: Record<TemplateKind, string> = {
  interface: "dt-interface-templates",
  "console-port": "dt-console-port-templates",
  "console-server-port": "dt-console-server-port-templates",
  "power-port": "dt-power-port-templates",
  "power-outlet": "dt-power-outlet-templates",
  "rear-port": "dt-rear-port-templates",
  "front-port": "dt-front-port-templates",
  "aux-port": "dt-aux-port-templates",
  "module-bay": "dt-module-bay-templates",
  "device-bay": "dt-device-bay-templates",
  "inventory-item": "dt-inventory-item-templates",
}

export const TEMPLATE_NOUN: Record<TemplateKind, string> = {
  interface: "interface template",
  "console-port": "console port template",
  "console-server-port": "console server port template",
  "power-port": "power port template",
  "power-outlet": "power outlet template",
  "rear-port": "rear port template",
  "front-port": "front port template",
  "aux-port": "aux port template",
  "module-bay": "module bay template",
  "device-bay": "device bay template",
  "inventory-item": "inventory item template",
}

/** Union-ish row shape so one dialog/table can hold any of the 7 kinds —
 * the per-kind extras are simply absent on the kinds that lack them. */
export type AnyTemplate = ComponentTemplateBase &
  Partial<Pick<InterfaceTemplate, "enabled" | "mgmt_only" | "combo_group">> &
  Partial<{ poe_mode: string; poe_type: string }> &
  Partial<Pick<PowerPortTemplate, "maximum_draw" | "allocated_draw">> &
  Partial<Pick<PowerOutletTemplate, "power_port_template" | "feed_leg">> &
  Partial<Pick<RearPortTemplate, "positions">> &
  Partial<
    Pick<FrontPortTemplate, "rear_port_template" | "rear_port_position">
  > &
  Partial<{
    position: string
    default_module_type: { id: string; name: string } | null
  }> & // module-bay
  Partial<{
    manufacturer: { id: string; name: string } | null
    part_id: string
  }> // inventory-item

const FEED_LEG_OPTIONS = [
  { value: "A", label: "Leg A" },
  { value: "B", label: "Leg B" },
  { value: "C", label: "Leg C" },
]

export interface ComponentTemplateDialogProps {
  kind: TemplateKind
  deviceTypeId: string
  /** Present → edit mode; absent → create. */
  template?: AnyTemplate | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Create/edit dialog shared by all seven component-template tables — common
// name/description plus the kind's extras. Templates are stamped onto every
// new device of the type.
//
// A name may contain one [a-b] range — "GigabitEthernet{position}/0/[1-24]"
// creates 24 templates in one go. Expansion happens client-side on create;
// {position} stays in the stored name and resolves per stack member when
// components are stamped (1 for standalone devices, {position:0} for
// vendors that count from 0).
export function ComponentTemplateDialog({
  kind,
  deviceTypeId,
  template,
  open,
  onOpenChange,
}: ComponentTemplateDialogProps) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const choices = useDcimChoices()

  const [name, setName] = useState("")
  const [type, setType] = useState("")
  const [description, setDescription] = useState("")
  // Interface extras
  const [enabled, setEnabled] = useState(true)
  const [mgmtOnly, setMgmtOnly] = useState(false)
  const [comboGroup, setComboGroup] = useState("")
  const [poeMode, setPoeMode] = useState("")
  const [poeType, setPoeType] = useState("")
  // Power-port extras
  const [maximumDraw, setMaximumDraw] = useState("")
  const [allocatedDraw, setAllocatedDraw] = useState("")
  // Power-outlet extras
  const [powerPortTemplateId, setPowerPortTemplateId] = useState<string | null>(
    null
  )
  const [feedLeg, setFeedLeg] = useState<"" | "A" | "B" | "C">("")
  // Rear-port extras
  const [positions, setPositions] = useState("1")
  const [isSplitter, setIsSplitter] = useState(false)
  // Front-port extras
  const [rearPortTemplateId, setRearPortTemplateId] = useState<string | null>(
    null
  )
  const [rearPortPosition, setRearPortPosition] = useState("1")
  // Module-bay extras — what {module} resolves to in installed port names, and
  // an optional module type pre-seated into the bay on device create / sync.
  const [bayPosition, setBayPosition] = useState("")
  const [defaultModuleTypeId, setDefaultModuleTypeId] = useState<string | null>(
    null
  )
  // Inventory-item extras
  const [manufacturerId, setManufacturerId] = useState<string | null>(null)
  const [partId, setPartId] = useState("")
  const [invKind, setInvKind] = useState("other")
  const [invMedia, setInvMedia] = useState("")
  const [invCapacity, setInvCapacity] = useState("")
  const [invCapacityUnit, setInvCapacityUnit] = useState<StorageUnit>("GB")
  const [invSpeed, setInvSpeed] = useState("")

  // Seed from the template being edited (or blank) every time the dialog opens.
  useEffect(() => {
    if (!open) return
    setName(template?.name ?? "")
    setType(template?.type ?? "")
    setDescription(template?.description ?? "")
    setEnabled(template?.enabled ?? true)
    setMgmtOnly(template?.mgmt_only ?? false)
    setComboGroup(template?.combo_group ?? "")
    setPoeMode(template?.poe_mode ?? "")
    setPoeType(template?.poe_type ?? "")
    setMaximumDraw(
      template?.maximum_draw != null ? String(template.maximum_draw) : ""
    )
    setAllocatedDraw(
      template?.allocated_draw != null ? String(template.allocated_draw) : ""
    )
    setPowerPortTemplateId(template?.power_port_template?.id ?? null)
    setFeedLeg(template?.feed_leg ?? "")
    setPositions(template?.positions != null ? String(template.positions) : "1")
    setIsSplitter(
      (template as Partial<RearPortTemplate> | undefined)?.is_splitter ?? false
    )
    setRearPortTemplateId(template?.rear_port_template?.id ?? null)
    setRearPortPosition(
      template?.rear_port_position != null
        ? String(template.rear_port_position)
        : "1"
    )
    setBayPosition(template?.position ?? "")
    setDefaultModuleTypeId(template?.default_module_type?.id ?? null)
    setManufacturerId(template?.manufacturer?.id ?? null)
    setPartId(template?.part_id ?? "")
    const inv = template as
      | Partial<{
          kind: string
          media: string
          capacity_bytes: number | null
          speed: string
        }>
      | undefined
    setInvKind(inv?.kind ?? "other")
    setInvMedia(inv?.media ?? "")
    const cap = bytesToUnit(inv?.capacity_bytes ?? null)
    setInvCapacity(cap.value)
    setInvCapacityUnit(cap.unit)
    setInvSpeed(inv?.speed ?? "")
    reset()
  }, [open, template, reset])

  // Sibling templates on the same device type, for the relational pickers.
  const powerPorts = useQuery({
    queryKey: [TEMPLATE_QUERY_KEY["power-port"], deviceTypeId],
    queryFn: () =>
      api<Paginated<PowerPortTemplate>>(
        `/api/power-port-templates/?device_type=${deviceTypeId}`
      ),
    enabled: open && kind === "power-outlet",
  })
  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/manufacturers/?picker=1"
      ),
    enabled: open && kind === "inventory-item",
    staleTime: 10 * 60_000,
  })
  const rearPorts = useQuery({
    queryKey: [TEMPLATE_QUERY_KEY["rear-port"], deviceTypeId],
    queryFn: () =>
      api<Paginated<RearPortTemplate>>(
        `/api/rear-port-templates/?device_type=${deviceTypeId}`
      ),
    enabled: open && kind === "front-port",
  })
  // Module types to offer as a bay's pre-seated default.
  const moduleTypes = useQuery({
    queryKey: ["module-types-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/module-types/?picker=1"
      ),
    enabled: open && kind === "module-bay",
    staleTime: 10 * 60_000,
  })

  const editing = !!template
  const mutation = useMutation({
    mutationFn: () => {
      const payload: ComponentTemplateWritePayload = {
        device_type_id: deviceTypeId,
        name: name.trim(),
        description: description.trim(),
      }
      if (kind === "interface") {
        payload.type = type
        payload.enabled = enabled
        payload.mgmt_only = mgmtOnly
        payload.combo_group = comboGroup.trim()
        payload.poe_mode = poeMode
        payload.poe_type = poeType
      } else if (
        kind === "console-port" ||
        kind === "console-server-port" ||
        kind === "aux-port"
      ) {
        payload.type = type
      } else if (kind === "power-port") {
        payload.type = type
        payload.maximum_draw =
          maximumDraw.trim() === "" ? null : Number(maximumDraw)
        payload.allocated_draw =
          allocatedDraw.trim() === "" ? null : Number(allocatedDraw)
      } else if (kind === "power-outlet") {
        payload.type = type
        payload.power_port_template_id = powerPortTemplateId
        payload.feed_leg = feedLeg
      } else if (kind === "rear-port") {
        payload.type = type.trim()
        payload.positions = Number(positions || 1)
        payload.is_splitter = isSplitter
      } else if (kind === "module-bay") {
        payload.position = bayPosition.trim()
        payload.default_module_type_id = defaultModuleTypeId
      } else if (kind === "inventory-item") {
        payload.manufacturer_id = manufacturerId
        payload.part_id = partId.trim()
        payload.kind = invKind
        payload.media = invKind === "disk" ? invMedia : ""
        payload.capacity_bytes = unitToBytes(invCapacity, invCapacityUnit)
        payload.speed = invSpeed.trim()
      } else {
        payload.type = type.trim()
        payload.rear_port_template_id = rearPortTemplateId
        payload.rear_port_position = Number(rearPortPosition || 1)
      }
      const base = `/api/${TEMPLATE_ENDPOINT[kind]}/`
      if (editing) {
        return api<AnyTemplate>(`${base}${template!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }).then((saved) => ({ saved, count: 1 }))
      }
      // Create: a [a-b] range in the name fans out into one POST per port.
      const names = expandNameRange(payload.name)
      const posts = names.reduce<Promise<AnyTemplate>>(
        (chain, n) =>
          chain.then(() =>
            api<AnyTemplate>(base, {
              method: "POST",
              body: JSON.stringify({ ...payload, name: n }),
            })
          ),
        Promise.resolve(null as unknown as AnyTemplate)
      )
      return posts.then((saved) => ({ saved, count: names.length }))
    },
    onSuccess: ({ saved, count }) => {
      qc.invalidateQueries({
        queryKey: [TEMPLATE_QUERY_KEY[kind], deviceTypeId],
      })
      toast.success(
        editing
          ? `Updated ${saved.name}`
          : count > 1
            ? `Created ${count} templates`
            : `Created ${saved.name}`
      )
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const noun = TEMPLATE_NOUN[kind]
  const typeChoices: DcimChoice[] =
    kind === "interface"
      ? choices.interface_types
      : kind === "console-port" || kind === "console-server-port"
        ? (choices.console_port_types ?? [])
        : kind === "power-port"
          ? (choices.power_port_types ?? [])
          : kind === "power-outlet"
            ? (choices.power_outlet_types ?? [])
            : kind === "aux-port"
              ? (choices.aux_port_types ?? [])
              : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${noun}` : `Add ${noun}`}</DialogTitle>
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
            mono
            placeholder={
              kind === "interface"
                ? "GigabitEthernet{position}/0/[1-24]"
                : "port-[1-24]"
            }
            hint="[1-24] creates one template per port · {position} follows the stack member number (1 when standalone, {position:0} for 0-based vendors)"
            error={fieldErrors.name}
          />
          <NamePreview name={name} editing={editing} />

          {/* Type — grouped combobox where the backend serves a choice list,
              free text for the panel-port kinds. */}
          {kind === "inventory-item" ? (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <FormSelect
                  label="Kind"
                  value={invKind}
                  onChange={(v) => v && setInvKind(v)}
                  options={INVENTORY_KIND_OPTIONS}
                  error={fieldErrors.kind}
                />
                <FormCombobox
                  label="Manufacturer"
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
              <div className="grid grid-cols-2 gap-3">
                {invKind === "disk" && (
                  <FormSelect
                    label="Media"
                    value={invMedia || null}
                    onChange={(v) => setInvMedia(v ?? "")}
                    options={INVENTORY_MEDIA_OPTIONS}
                    placeholder="—"
                    error={fieldErrors.media}
                  />
                )}
                <FormText
                  label="Speed"
                  value={invSpeed}
                  onChange={setInvSpeed}
                  placeholder="7200 RPM / PCIe 4.0 x4"
                  suggestions={inventorySpeedSuggestions(
                    invKind as InventoryItemKind,
                    invMedia as InventoryMedia
                  )}
                  error={fieldErrors.speed}
                />
              </div>
              <div className="grid grid-cols-[1fr_100px] gap-3">
                <FormText
                  label="Capacity"
                  type="number"
                  value={invCapacity}
                  onChange={setInvCapacity}
                  error={fieldErrors.capacity_bytes}
                />
                <FormSelect
                  label="Unit"
                  value={invCapacityUnit}
                  onChange={(v) => v && setInvCapacityUnit(v as StorageUnit)}
                  options={STORAGE_UNITS.map((u) => ({
                    value: u.value,
                    label: u.value,
                  }))}
                />
              </div>
              <FormText
                label="Part ID"
                value={partId}
                onChange={setPartId}
                mono
                error={fieldErrors.part_id}
              />
            </div>
          ) : kind === "device-bay" ? null : kind === "module-bay" ? (
            <div className="grid gap-4">
              <FormText
                label="Position"
                value={bayPosition}
                onChange={setBayPosition}
                mono
                placeholder="1"
                hint="What {module} resolves to in installed port names"
                error={fieldErrors.position}
              />
              <FormCombobox
                label="Default module"
                value={defaultModuleTypeId}
                onChange={setDefaultModuleTypeId}
                noneLabel="Empty bay"
                placeholder="Empty bay"
                searchPlaceholder="Search module types…"
                emptyText="No module types yet."
                options={(moduleTypes.data?.results ?? []).map((m) => ({
                  value: m.id,
                  label: m.name,
                }))}
                hint="Pre-installed on new devices and on sync into an empty bay — replaceable per device"
                error={fieldErrors.default_module_type_id}
              />
            </div>
          ) : kind === "rear-port" || kind === "front-port" ? (
            <FormText
              label="Type"
              value={type}
              onChange={setType}
              mono
              placeholder="e.g. lc, 8p8c"
              error={fieldErrors.type}
            />
          ) : (
            <FormCombobox
              label="Type"
              value={type || null}
              onChange={(v) => setType(v ?? "")}
              noneLabel="No type"
              placeholder="Pick a type"
              searchPlaceholder="Search types…"
              emptyText="No types."
              options={typeChoices}
              error={fieldErrors.type}
            />
          )}

          {kind === "interface" && (
            <div className="grid grid-cols-2 gap-3">
              <FormSelect
                label="PoE mode"
                value={poeMode || null}
                onChange={(v) => setPoeMode(v ?? "")}
                noneLabel="No PoE"
                options={choices.poe_modes ?? []}
              />
              <FormSelect
                label="PoE type"
                value={poeType || null}
                onChange={(v) => setPoeType(v ?? "")}
                noneLabel="—"
                options={choices.poe_types ?? []}
              />
            </div>
          )}
          {kind === "interface" && (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <FormCheckbox
                  label="Enabled"
                  checked={enabled}
                  onChange={setEnabled}
                  hint="New interfaces start enabled"
                />
                <FormCheckbox
                  label="Management only"
                  checked={mgmtOnly}
                  onChange={setMgmtOnly}
                  hint="Out-of-band interface"
                />
              </div>
              <FormText
                label="Combo group"
                value={comboGroup}
                onChange={setComboGroup}
                placeholder="e.g. mgmt"
                info="Combo / shared port: give the alternate connectors of one logical port the same group (an RJ45 and its SFP twin). On each device, enabling one automatically disables the others."
              />
            </>
          )}

          {kind === "power-port" && (
            <div className="grid grid-cols-2 gap-3">
              <FormText
                label="Maximum draw (W)"
                type="number"
                value={maximumDraw}
                onChange={setMaximumDraw}
                placeholder="Optional"
                error={fieldErrors.maximum_draw}
              />
              <FormText
                label="Allocated draw (W)"
                type="number"
                value={allocatedDraw}
                onChange={setAllocatedDraw}
                placeholder="Optional"
                error={fieldErrors.allocated_draw}
              />
            </div>
          )}

          {kind === "power-outlet" && (
            <div className="grid grid-cols-2 gap-3">
              <FormSelect
                label="Power port (inlet)"
                value={powerPortTemplateId}
                onChange={setPowerPortTemplateId}
                noneLabel="None"
                placeholder="Pick an inlet"
                options={(powerPorts.data?.results ?? []).map((t) => ({
                  value: t.id,
                  label: t.name,
                }))}
                error={fieldErrors.power_port_template_id}
              />
              <FormSelect
                label="Feed leg"
                value={feedLeg || null}
                onChange={(v) => setFeedLeg((v ?? "") as typeof feedLeg)}
                noneLabel="None"
                placeholder="None"
                options={FEED_LEG_OPTIONS}
                error={fieldErrors.feed_leg}
              />
            </div>
          )}

          {kind === "rear-port" && (
            <div className="grid gap-3">
              <FormText
                label="Positions"
                type="number"
                value={positions}
                onChange={setPositions}
                hint="Strands on the rear side — each maps to one front port"
                error={fieldErrors.positions}
              />
              <FormCheckbox
                label={
                  <>
                    Optical splitter (PON){" "}
                    <span className="text-muted-foreground">
                      — every front port carries the input signal
                    </span>
                  </>
                }
                checked={isSplitter}
                onChange={(v) => {
                  setIsSplitter(v)
                  if (v) setPositions("1")
                }}
              />
            </div>
          )}

          {kind === "front-port" && (
            <div className="grid grid-cols-2 gap-3">
              <FormSelect
                label="Rear port template"
                value={rearPortTemplateId}
                onChange={setRearPortTemplateId}
                placeholder="Pick a rear port"
                options={(rearPorts.data?.results ?? []).map((t) => ({
                  value: t.id,
                  label: t.name,
                }))}
                error={fieldErrors.rear_port_template_id}
              />
              <FormText
                label="Rear port position"
                type="number"
                value={rearPortPosition}
                onChange={setRearPortPosition}
                error={fieldErrors.rear_port_position}
              />
            </div>
          )}

          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="Optional"
            error={fieldErrors.description}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={editing ? "Save changes" : `Create ${noun}`}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Live feedback under the Name field: how many templates a [a-b] range
 * creates, and what a {position} token renders as per stack member. */
function NamePreview({ name, editing }: { name: string; editing: boolean }) {
  const trimmed = name.trim()
  if (!trimmed) return null
  const names = editing ? [trimmed] : expandNameRange(trimmed)
  const hasRange = !editing && names.length > 1
  const hasToken = /\{position(?::\d+)?\}/.test(trimmed)
  if (!hasRange && !hasToken) return null
  const render = (n: string, pos: number) =>
    n.replace(/\{position(?::\d+)?\}/g, String(pos))
  return (
    <p className="-mt-2 font-mono text-[11px] text-muted-foreground">
      {hasRange && (
        <>
          Creates {names.length} templates: {names[0]} …{" "}
          {names[names.length - 1]}
          <br />
        </>
      )}
      {hasToken && (
        <>
          Member 1: {render(names[0], 1)} · member 2: {render(names[0], 2)}
        </>
      )}
    </p>
  )
}
