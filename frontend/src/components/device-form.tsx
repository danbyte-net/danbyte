import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  DEFAULT_DEVICE_FIELD_VISIBILITY,
  type Device,
  type DeviceFieldVisibility,
  type DeviceRoleOption,
  type DeviceTypeOption,
  type DeviceWritePayload,
  type ExportTemplate,
  type LocationOption,
  type Paginated,
  type PlatformOption,
  type RackOption,
  type Status,
  type TagOption,
} from "@/lib/api"
import {
  Field,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  QuickAddDialog,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { RackPicker } from "@/components/rack-picker"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

const AIRFLOW_OPTIONS: { value: string; label: string }[] = [
  { value: "front-to-rear", label: "Front to rear" },
  { value: "rear-to-front", label: "Rear to front" },
  { value: "left-to-right", label: "Left to right" },
  { value: "right-to-left", label: "Right to left" },
  { value: "passive", label: "Passive" },
  { value: "mixed", label: "Mixed" },
]

interface ClusterOption {
  id: string
  name: string
}

interface VirtualChassisOption {
  id: string
  name: string
}

export interface DeviceFormProps {
  device?: Device
  /** Pre-fill rack placement (create only) — e.g. "+ Add here" from an empty
   * rack unit arrives with rack/position/face already chosen. */
  initial?: { rackId?: string; position?: number; face?: "" | "front" | "rear" }
  /** Clone seed (create only): the source's carried-over fields from
   * GET /api/devices/<id>/clone/. Identity/placement (name, serial, rack) are
   * absent by design, so they start blank; type/role/site/etc. are pre-filled.
   * Distinct from `device` so this still POSTs a new device. */
  clone?: Partial<Device>
  onSaved: (d: Device) => void
  onCancel: () => void
}

export function DeviceForm({
  device,
  initial,
  clone,
  onSaved,
  onCancel,
}: DeviceFormProps) {
  const isEdit = !!device
  // Read cloneable field values from the edit object or the clone seed; identity
  // and placement fields deliberately read from `device` only, so a clone starts
  // them blank.
  const seed = device ?? clone
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(device?.name ?? "")
  const [deviceTypeId, setDeviceTypeId] = useState<string | null>(
    seed?.device_type?.id ?? null
  )
  const [siteId, setSiteId] = useState<string | null>(seed?.site?.id ?? null)
  const [roleId, setRoleId] = useState<string | null>(seed?.role?.id ?? null)
  const [platformId, setPlatformId] = useState<string | null>(
    seed?.platform?.id ?? null
  )
  const [configTemplateId, setConfigTemplateId] = useState<string | null>(
    device?.config_template?.own?.id ?? null
  )
  const [statusId, setStatusId] = useState<string | null>(
    seed?.status?.id ?? null
  )
  const [serial, setSerial] = useState(device?.serial_number ?? "")
  const [assetTag, setAssetTag] = useState(device?.asset_tag ?? "")
  const [description, setDescription] = useState(seed?.description ?? "")
  const [rackId, setRackId] = useState<string | null>(
    device?.rack?.id ?? initial?.rackId ?? null
  )
  const [position, setPosition] = useState(
    device?.position != null
      ? String(device.position)
      : initial?.position != null
        ? String(initial.position)
        : ""
  )
  const [face, setFace] = useState<"" | "front" | "rear">(
    device?.face ?? initial?.face ?? ""
  )
  const [side, setSide] = useState<"" | "left" | "right">(
    device?.rack_side ?? ""
  )
  const [tagIds, setTagIds] = useState<number[]>(
    seed?.tags?.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    seed?.custom_fields ?? {}
  )
  // ─── Promoted built-in fields (visibility is admin-controlled) ──────────
  const [comments, setComments] = useState(seed?.comments ?? "")
  const [locationId, setLocationId] = useState<string | null>(
    seed?.location?.id ?? null
  )
  const [clusterId, setClusterId] = useState<string | null>(
    seed?.cluster?.id ?? null
  )
  const [airflow, setAirflow] = useState(seed?.airflow ?? "")
  const [latitude, setLatitude] = useState(device?.latitude ?? "")
  const [longitude, setLongitude] = useState(device?.longitude ?? "")
  // ─── Stack membership (virtual chassis) ──────────────────────────────────
  const [vcId, setVcId] = useState<string | null>(
    device?.virtual_chassis?.id ?? null
  )
  const [vcPosition, setVcPosition] = useState(
    device?.vc_position != null ? String(device.vc_position) : ""
  )
  const [vcPriority, setVcPriority] = useState(
    device?.vc_priority != null ? String(device.vc_priority) : ""
  )

  useEffect(() => {
    if (!device) return
    setName(device.name)
    setDeviceTypeId(device.device_type?.id ?? null)
    setSiteId(device.site?.id ?? null)
    setRoleId(device.role?.id ?? null)
    setPlatformId(device.platform?.id ?? null)
    setConfigTemplateId(device.config_template?.own?.id ?? null)
    setStatusId(device.status?.id ?? null)
    setSerial(device.serial_number)
    setAssetTag(device.asset_tag)
    setDescription(device.description)
    setRackId(device.rack?.id ?? null)
    setPosition(device.position != null ? String(device.position) : "")
    setFace(device.face ?? "")
    setSide(device.rack_side)
    setTagIds(device.tags.map((t) => t.id))
    setCustomFields(device.custom_fields ?? {})
    setComments(device.comments ?? "")
    setLocationId(device.location?.id ?? null)
    setClusterId(device.cluster?.id ?? null)
    setAirflow(device.airflow ?? "")
    setLatitude(device.latitude ?? "")
    setLongitude(device.longitude ?? "")
    setVcId(device.virtual_chassis?.id ?? null)
    setVcPosition(device.vc_position != null ? String(device.vc_position) : "")
    setVcPriority(device.vc_priority != null ? String(device.vc_priority) : "")
    reset()
  }, [device, reset])

  const types = useQuery({
    queryKey: ["device-types-picker"],
    queryFn: () =>
      api<Paginated<DeviceTypeOption>>("/api/device-types/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "device"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=device&picker=1"),
    staleTime: 5 * 60_000,
  })
  const sites = useSiteOptions()
  // Enhanced site separation: a single-site user's creates land in their own
  // site — prefill and lock the picker (useSiteOptions already filtered it).
  const siteLocked = !!sites.lockedId
  useEffect(() => {
    if (!isEdit && sites.lockedId && !siteId) setSiteId(sites.lockedId)
  }, [isEdit, sites.lockedId, siteId])
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  const racks = useQuery({
    queryKey: ["racks-picker"],
    queryFn: () => api<Paginated<RackOption>>("/api/racks/?picker=1"),
    staleTime: 10 * 60_000,
  })
  // Devices already in the selected rack — drives the Position (U) dropdown
  // (occupied units render disabled). Same key as RackElevation, so the
  // cache is shared.
  const rackDevices = useQuery({
    queryKey: ["rack-devices", rackId],
    queryFn: () => api<Paginated<Device>>(`/api/devices/?rack=${rackId}`),
    enabled: !!rackId,
  })
  const roles = useQuery({
    queryKey: ["device-roles-picker"],
    queryFn: () =>
      api<Paginated<DeviceRoleOption>>("/api/device-roles/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const platforms = useQuery({
    queryKey: ["platforms-picker"],
    queryFn: () => api<Paginated<PlatformOption>>("/api/platforms/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const templates = useQuery({
    queryKey: ["export-templates", "device"],
    queryFn: () =>
      api<Paginated<ExportTemplate>>(
        "/api/export-templates/?object_type=device"
      ),
    staleTime: 5 * 60_000,
  })
  const locations = useQuery({
    queryKey: ["locations-picker"],
    queryFn: () => api<Paginated<LocationOption>>("/api/locations/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const clusters = useQuery({
    queryKey: ["clusters-picker"],
    queryFn: () => api<Paginated<ClusterOption>>("/api/clusters/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const virtualChassis = useQuery({
    queryKey: ["virtual-chassis-picker"],
    queryFn: () =>
      api<Paginated<VirtualChassisOption>>("/api/virtual-chassis/"),
    staleTime: 10 * 60_000,
  })
  // Admin-controlled field visibility. Falls back to the documented defaults
  // if the endpoint isn't up yet (404) or the request fails.
  const visibilityQuery = useQuery({
    queryKey: ["device-field-visibility"],
    queryFn: () => api<DeviceFieldVisibility>("/api/device-fields/"),
    staleTime: 10 * 60_000,
    retry: false,
  })
  const visibility = visibilityQuery.data ?? DEFAULT_DEVICE_FIELD_VISIBILITY

  // ─── Rack placement derived state ────────────────────────────────────────
  const selectedRack = (racks.data?.results ?? []).find((r) => r.id === rackId)
  const selectedType = (types.data?.results ?? []).find(
    (t) => t.id === deviceTypeId
  )
  const rackWidth: "full" | "half" =
    selectedType?.rack_width === "half" ? "half" : "full"
  const deviceHeight = Math.max(1, selectedType?.u_height ?? 1)

  // Half-width devices need a side; default to left. Full-width carries none.
  useEffect(() => {
    if (rackWidth === "half" && side === "") setSide("left")
    if (rackWidth === "full" && side !== "") setSide("")
  }, [rackWidth, side])

  // One option per possible *lowest* unit, in the rack's visual order (top
  // first). Units where the device would collide render disabled with the
  // blocking device as hint — mirrors the backend overlap validation.
  const unitOptions = useMemo(() => {
    if (!selectedRack) return []
    const first = selectedRack.starting_unit
    const last = selectedRack.starting_unit + selectedRack.u_height - 1
    const others = (rackDevices.data?.results ?? []).filter(
      (d) => d.id !== device?.id && d.position != null
    )
    const blockerAt = (p: number): Device | undefined =>
      others.find((d) => {
        // Different explicit faces never collide.
        if (face && d.face && d.face !== face) return false
        // Two half-width devices coexist on opposite sides of the same U.
        if (
          rackWidth === "half" &&
          d.rack_width === "half" &&
          side &&
          d.rack_side &&
          d.rack_side !== side
        )
          return false
        const dTop = (d.position as number) + Math.max(1, d.u_height) - 1
        return p <= dTop && p + deviceHeight - 1 >= (d.position as number)
      })
    const opts: {
      value: string
      label: string
      disabled?: boolean
      hint?: string
    }[] = []
    const push = (p: number) => {
      if (p + deviceHeight - 1 > last) return // doesn't fit this high
      const blocker = blockerAt(p)
      opts.push({
        value: String(p),
        label: deviceHeight > 1 ? `U${p}–U${p + deviceHeight - 1}` : `U${p}`,
        disabled: !!blocker,
        hint: blocker ? blocker.name : undefined,
      })
    }
    if (selectedRack.desc_units) {
      for (let p = first; p <= last; p++) push(p)
    } else {
      for (let p = last; p >= first; p--) push(p)
    }
    // Keep a stale/legacy value selectable when editing.
    if (position !== "" && !opts.some((o) => o.value === position)) {
      opts.unshift({ value: position, label: `U${position}` })
    }
    return opts
  }, [
    selectedRack,
    rackDevices.data,
    device?.id,
    face,
    side,
    rackWidth,
    deviceHeight,
    position,
  ])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: DeviceWritePayload = {
        name: name.trim(),
        device_type_id: deviceTypeId,
        site_id: siteId,
        role_id: roleId,
        platform_id: platformId,
        status_id: statusId,
        serial_number: serial.trim(),
        asset_tag: assetTag.trim(),
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
        rack_id: rackId,
        position: rackId && position.trim() !== "" ? Number(position) : null,
        face: rackId ? face : "",
        rack_side: rackId && rackWidth === "half" ? side : "",
        comments: comments.trim(),
        airflow,
        latitude: latitude.trim() !== "" ? latitude.trim() : null,
        longitude: longitude.trim() !== "" ? longitude.trim() : null,
        location_id: locationId,
        cluster_id: clusterId,
        config_template_id: configTemplateId,
        virtual_chassis_id: vcId,
        vc_position:
          vcId && vcPosition.trim() !== "" ? Number(vcPosition) : null,
        vc_priority:
          vcId && vcPriority.trim() !== "" ? Number(vcPriority) : null,
      }
      if (isEdit)
        return api<Device>(`/api/devices/${device!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Device>("/api/devices/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["devices"] })
      qc.invalidateQueries({ queryKey: ["devices-picker"] })
      qc.invalidateQueries({ queryKey: ["device", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
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
        autoFocus={!isEdit}
        value={name}
        onChange={setName}
        mono
        placeholder="sw-fra-01"
        error={fieldErrors.name}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="Device type"
          value={deviceTypeId}
          onChange={setDeviceTypeId}
          noneLabel="No type"
          options={(types.data?.results ?? []).map((t) => ({
            value: t.id,
            label: t.name,
          }))}
          error={fieldErrors.device_type_id}
        />
        <FormCombobox
          label="Status"
          value={statusId}
          onChange={setStatusId}
          options={(statuses.data?.results ?? []).map((s) => ({
            value: s.id,
            label: s.name,
          }))}
          noneLabel="No status"
          placeholder="Select a status…"
          error={fieldErrors.status_id}
        />
      </div>
      <FormSelect
        label="Site"
        hint={siteLocked ? "locked to your site" : undefined}
        value={siteId}
        onChange={setSiteId}
        noneLabel="No site"
        disabled={siteLocked}
        options={sites.options.map((s) => ({
          value: s.id,
          label: s.name,
        }))}
        error={fieldErrors.site_id}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormCombobox
          label="Role"
          hint="optional"
          value={roleId}
          onChange={setRoleId}
          options={(roles.data?.results ?? []).map((r) => ({
            value: r.id,
            label: r.name,
          }))}
          noneLabel="No role"
          placeholder="Select a role…"
          searchPlaceholder="Search roles…"
          emptyText="No device roles."
          error={fieldErrors.role_id}
          quickAdd={
            <QuickAddDialog
              title="New device role"
              endpoint="/api/device-roles/"
              fields={[
                { name: "name", label: "Name", required: true },
                { name: "description", label: "Description", type: "textarea" },
              ]}
              onCreated={(r) => {
                qc.invalidateQueries({ queryKey: ["device-roles-picker"] })
                setRoleId(r.id)
              }}
            />
          }
        />
        <FormCombobox
          label="Platform"
          hint="optional"
          value={platformId}
          onChange={setPlatformId}
          options={(platforms.data?.results ?? []).map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          noneLabel="No platform"
          placeholder="Select a platform…"
          searchPlaceholder="Search platforms…"
          emptyText="No platforms."
          error={fieldErrors.platform_id}
          quickAdd={
            <QuickAddDialog
              title="New platform"
              endpoint="/api/platforms/"
              fields={[{ name: "name", label: "Name", required: true }]}
              onCreated={(p) => {
                qc.invalidateQueries({ queryKey: ["platforms-picker"] })
                setPlatformId(p.id)
              }}
            />
          }
        />
      </div>
      <FormCombobox
        label="Config template"
        hint="overrides role/platform"
        value={configTemplateId}
        onChange={setConfigTemplateId}
        options={(templates.data?.results ?? []).map((t) => ({
          value: t.id,
          label: t.name,
        }))}
        noneLabel="Inherit from role/platform"
        placeholder="Inherit from role/platform"
        searchPlaceholder="Search templates…"
        emptyText="No device export templates."
        error={fieldErrors.config_template_id}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="Serial number"
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
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />

      {visibility.comments && (
        <FormTextarea
          label="Comments"
          hint="optional"
          value={comments}
          onChange={setComments}
          error={fieldErrors.comments}
        />
      )}

      {(visibility.location || visibility.cluster) && (
        <div className="grid grid-cols-2 gap-3">
          {visibility.location && (
            <FormCombobox
              label="Location"
              hint="optional"
              value={locationId}
              onChange={setLocationId}
              options={(locations.data?.results ?? []).map((l) => ({
                value: l.id,
                label: l.name,
              }))}
              noneLabel="No location"
              placeholder="Select a location…"
              searchPlaceholder="Search locations…"
              emptyText="No locations."
              error={fieldErrors.location_id}
            />
          )}
          {visibility.cluster && (
            <FormCombobox
              label="Cluster"
              hint="optional"
              value={clusterId}
              onChange={setClusterId}
              options={(clusters.data?.results ?? []).map((c) => ({
                value: c.id,
                label: c.name,
              }))}
              noneLabel="No cluster"
              placeholder="Select a cluster…"
              searchPlaceholder="Search clusters…"
              emptyText="No clusters."
              error={fieldErrors.cluster_id}
            />
          )}
        </div>
      )}

      {visibility.airflow && (
        <FormSelect
          label="Airflow"
          value={airflow === "" ? null : airflow}
          onChange={(v) => setAirflow(v ?? "")}
          noneLabel="—"
          options={AIRFLOW_OPTIONS}
          error={fieldErrors.airflow}
        />
      )}

      {(visibility.latitude || visibility.longitude) && (
        <div className="grid grid-cols-2 gap-3">
          {visibility.latitude && (
            <FormText
              label="Latitude"
              hint="optional"
              type="number"
              inputMode="decimal"
              mono
              value={latitude}
              onChange={setLatitude}
              placeholder="55.6761"
              error={fieldErrors.latitude}
            />
          )}
          {visibility.longitude && (
            <FormText
              label="Longitude"
              hint="optional"
              type="number"
              inputMode="decimal"
              mono
              value={longitude}
              onChange={setLongitude}
              placeholder="12.5683"
              error={fieldErrors.longitude}
            />
          )}
        </div>
      )}

      <fieldset className="grid gap-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Rack
        </legend>
        <RackPicker
          hint="optional"
          value={rackId}
          onChange={(v) => {
            setRackId(v)
            setPosition("") // stale unit numbers don't carry across racks
          }}
          noneLabel="No rack"
          placeholder="Select a rack…"
          error={fieldErrors.rack_id}
          quickAdd={
            <QuickAddDialog
              title="New rack"
              endpoint="/api/racks/"
              fields={[
                { name: "name", label: "Name", required: true },
                {
                  name: "site_id",
                  label: "Site",
                  type: "combobox",
                  endpoint: "/api/sites/?picker=1",
                  queryKey: "sites-picker",
                  required: true,
                },
              ]}
              onCreated={(r) => {
                qc.invalidateQueries({ queryKey: ["racks-picker"] })
                setRackId(r.id)
              }}
            />
          }
        />
        <div className="grid grid-cols-2 gap-3">
          <FormCombobox
            label="Position (U)"
            value={position === "" ? null : position}
            onChange={(v) => setPosition(v ?? "")}
            options={unitOptions}
            noneLabel="Not racked"
            placeholder={rackId ? "Pick a unit…" : "Select a rack first"}
            searchPlaceholder="Search units…"
            emptyText={
              rackId
                ? rackDevices.isLoading
                  ? "Loading units…"
                  : "No free units."
                : "Select a rack first."
            }
            disabled={!rackId}
            error={fieldErrors.position}
          />
          <FormSelect
            label="Face"
            value={face === "" ? null : face}
            onChange={(v) => setFace((v as "front" | "rear") ?? "")}
            noneLabel="—"
            options={[
              { value: "front", label: "Front" },
              { value: "rear", label: "Rear" },
            ]}
            error={fieldErrors.face}
          />
          {rackWidth === "half" && (
            <FormSelect
              label="Side (half-width)"
              value={side === "" ? null : side}
              onChange={(v) => setSide(v === "right" ? "right" : "left")}
              options={[
                { value: "left", label: "Left half" },
                { value: "right", label: "Right half" },
              ]}
              error={fieldErrors.rack_side}
            />
          )}
        </div>
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Stack membership
        </legend>
        <FormCombobox
          label="Virtual chassis"
          hint="optional"
          value={vcId}
          onChange={setVcId}
          options={(virtualChassis.data?.results ?? []).map((v) => ({
            value: v.id,
            label: v.name,
          }))}
          noneLabel="Not stacked"
          placeholder="Select a virtual chassis…"
          searchPlaceholder="Search virtual chassis…"
          emptyText="No virtual chassis."
          error={fieldErrors.virtual_chassis_id}
        />
        <div className="grid grid-cols-2 gap-3">
          <FormText
            label="Position"
            hint={vcId ? undefined : "pick a chassis first"}
            type="number"
            value={vcPosition}
            onChange={setVcPosition}
            placeholder="1"
            error={fieldErrors.vc_position}
          />
          <FormText
            label="Priority"
            hint={vcId ? undefined : "pick a chassis first"}
            type="number"
            value={vcPriority}
            onChange={setVcPriority}
            placeholder="128"
            error={fieldErrors.vc_priority}
          />
        </div>
      </fieldset>

      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>
      <CustomFieldInputs
        model="device"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create device"}
      />
    </form>
  )
}
