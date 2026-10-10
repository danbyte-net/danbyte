import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"

import {
  type DevicePortLabels,
  api,
  type Cabinet,
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
  FormColumn,
  FormColumns,
  FormSection,
  FormStatusSelect,
  FormSelect,
  FormText,
  QuickAddDialog,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import {
  photoSizeOf,
  TopologyPhotoSizeSelect,
} from "@/components/topology-photo-size-select"
import {
  BindingDraftsProvider,
  useBindingDraftsRoot,
} from "@/lib/binding-drafts"
import { useSaveObject } from "@/lib/save-object"
import { invalidateCabinetDeviceViews } from "@/lib/cabinets"
import { invalidatePortCounts } from "@/lib/port-utilization"
import { DeviceTypePicker } from "@/components/device-type-picker"
import { DeviceCabinetFields } from "@/components/device-cabinet-fields"
import { RackPicker } from "@/components/rack-picker"
import { RackPlacement } from "@/components/rack-placement"
import { fmtUnits, unitBlocker } from "@/lib/rack-placement"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { MonitoringEngineField } from "@/components/monitoring-engine-field"
import { ColorBadge } from "@/components/cells/color-badge"
import {
  CardLinesEditor,
  useCardLineConfig,
} from "@/components/topology/diagram/card-lines-dialog"
import { inheritedCardLines } from "@/components/topology/diagram/card-lines"
import { useMe } from "@/lib/use-me"

const PORT_LABEL_OPTIONS = [
  { value: "on", label: "Shown" },
  { value: "off", label: "Hidden" },
]

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
  /** Pre-fill rack placement (create only) - e.g. "+ Add here" from an empty
   * rack unit arrives with rack/position/face already chosen. */
  initial?: {
    rackId?: string
    position?: number
    face?: "" | "front" | "rear"
    /** Pre-pick the hardware model - "Add device" from a device type's page. */
    deviceTypeId?: string
    /** Pre-pick the site - "Add device" from a site's Devices tab (#134). */
    siteId?: string
    /** Pre-pick a 0U side mount - "+ side device" from a rack's side lane. */
    mount?: "" | "side_left" | "side_right"
    /** Pre-pick a cabinet and one of its rails - "Add device" on a rail -
     * and a spot on it: "Add device here" on the cabinet's plate. */
    cabinetId?: string
    dinRailId?: string
    dinOffset?: number
  }
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
  const { canDo } = useMe()
  const isEdit = !!device
  // Read cloneable field values from the edit object or the clone seed; identity
  // and placement fields deliberately read from `device` only, so a clone starts
  // them blank.
  const seed = device ?? clone
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  // The Monitoring section stages its picks; Save writes them (#324).
  const bindingDrafts = useBindingDraftsRoot()

  const [name, setName] = useState(device?.name ?? "")
  const [deviceTypeId, setDeviceTypeId] = useState<string | null>(
    seed?.device_type?.id ?? initial?.deviceTypeId ?? null
  )
  const [siteId, setSiteId] = useState<string | null>(
    seed?.site?.id ?? initial?.siteId ?? null
  )
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
  // Zero-U side mounting (vertical PDU strips).
  const [mount, setMount] = useState<"" | "side_left" | "side_right">(
    device?.mount ?? initial?.mount ?? ""
  )
  const [mountOffset, setMountOffset] = useState(
    device?.mount_offset_mm != null ? String(device.mount_offset_mm) : ""
  )
  const [mountSpan, setMountSpan] = useState(
    device?.mount_span_u != null ? String(device.mount_span_u) : ""
  )
  // A cabinet's DIN rail instead of a rack (#277): picking either clears
  // the other. The tabs only choose which one the section shows.
  const [mountIn, setMountIn] = useState<"rack" | "cabinet">(
    device?.cabinet || initial?.cabinetId ? "cabinet" : "rack"
  )
  const [cabinetId, setCabinetId] = useState<string | null>(
    device?.cabinet?.id ?? initial?.cabinetId ?? null
  )
  const [railId, setRailId] = useState<string | null>(
    device?.din_rail?.id ?? initial?.dinRailId ?? null
  )
  const [dinOffset, setDinOffset] = useState(
    device?.din_offset_mm != null
      ? String(device.din_offset_mm)
      : initial?.dinOffset != null
        ? String(initial.dinOffset)
        : ""
  )
  // A refusal about the hidden tab's fields brings that tab up, so the
  // field it highlights is on screen.
  useEffect(() => {
    const on = (keys: string[]) => keys.some((k) => fieldErrors[k])
    if (on(["cabinet_id", "din_rail_id", "din_offset_mm"]))
      setMountIn("cabinet")
    else if (on(["rack_id", "position", "face", "rack_side", "mount"]))
      setMountIn("rack")
  }, [fieldErrors])
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
  const [portLabels, setPortLabels] = useState<DevicePortLabels>(
    seed?.port_labels ?? ""
  )
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
  // The device's own topology card lines; null inherits (view, role, All
  // devices), [] is name only.
  const [topologyCard, setTopologyCard] = useState<string[] | null>(
    seed?.topology_card ?? null
  )
  const [photoSize, setPhotoSize] = useState(
    photoSizeOf(seed?.topology_photo_size)
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
    setMount(device.mount ?? "")
    setMountOffset(
      device.mount_offset_mm != null ? String(device.mount_offset_mm) : ""
    )
    setMountSpan(device.mount_span_u != null ? String(device.mount_span_u) : "")
    setMountIn(device.cabinet ? "cabinet" : "rack")
    setCabinetId(device.cabinet?.id ?? null)
    setRailId(device.din_rail?.id ?? null)
    setDinOffset(
      device.din_offset_mm != null ? String(device.din_offset_mm) : ""
    )
    setTagIds(device.tags.map((t) => t.id))
    setCustomFields(device.custom_fields ?? {})
    setComments(device.comments ?? "")
    setLocationId(device.location?.id ?? null)
    setClusterId(device.cluster?.id ?? null)
    setAirflow(device.airflow ?? "")
    setPortLabels(device.port_labels ?? "")
    setLatitude(device.latitude ?? "")
    setLongitude(device.longitude ?? "")
    setVcId(device.virtual_chassis?.id ?? null)
    setVcPosition(device.vc_position != null ? String(device.vc_position) : "")
    setVcPriority(device.vc_priority != null ? String(device.vc_priority) : "")
    setTopologyCard(device.topology_card ?? null)
    setPhotoSize(photoSizeOf(device.topology_photo_size))
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
  // site - prefill and lock the picker (useSiteOptions already filtered it).
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
  // Devices already in the selected rack - drives the Position (U) dropdown
  // (occupied units render disabled). Same key as RackElevation, so the
  // cache is shared.
  const rackDevices = useQuery({
    queryKey: ["rack-devices", rackId],
    queryFn: () => api<Paginated<Device>>(`/api/devices/?rack=${rackId}`),
    enabled: !!rackId,
  })
  // The picked cabinet: its rails, and its site - a device in a cabinet is
  // at the cabinet's site. Same key as the cabinet page and the picker.
  const cabinet = useQuery({
    queryKey: ["cabinet", cabinetId],
    queryFn: () => api<Cabinet>(`/api/cabinets/${cabinetId}/`),
    enabled: !!cabinetId,
  })
  // Picking a cabinet fills the site (a new device's preset cabinet too),
  // once the cabinet's own site is known.
  const fillSite = useRef(!device && !!initial?.cabinetId)
  const cabinetSite =
    cabinet.data?.id === cabinetId ? cabinet.data?.site.id : undefined
  useEffect(() => {
    if (!fillSite.current || !cabinetSite) return
    fillSite.current = false
    if (cabinetSite !== siteId) setSiteId(cabinetSite)
  }, [cabinetSite, siteId])
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
  // What the topology card shows while this device inherits: its role's
  // lines, else All devices. A saved view's own lines come first on its map.
  const cardConfig = useCardLineConfig()
  const role = (roles.data?.results ?? []).find((r) => r.id === roleId)
  const cardInherited = cardConfig.data
    ? inheritedCardLines(cardConfig.data, role?.slug)
    : null

  const clearRack = () => {
    setRackId(null)
    setPosition("")
    setFace("")
    setSide("")
    setMount("")
    setMountOffset("")
    setMountSpan("")
  }
  const clearCabinet = () => {
    setCabinetId(null)
    setRailId(null)
    setDinOffset("")
  }
  const pickRack = (v: string | null) => {
    setRackId(v)
    setPosition("") // stale unit numbers don't carry across racks
    if (v) clearCabinet()
  }
  const pickCabinet = (v: string | null) => {
    setCabinetId(v)
    // A rail and an offset belong to the cabinet they were picked in.
    setRailId(null)
    setDinOffset("")
    if (v) {
      clearRack()
      fillSite.current = true
    }
  }
  const pickSite = (v: string | null) => {
    setSiteId(v)
    // A cabinet at another site can't hold the device any more.
    if (v && cabinetSite && v !== cabinetSite) clearCabinet()
  }

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

  // Side mounting is a 0U-only concept, and it replaces U placement - the
  // backend enforces both; the form just keeps the fields from fighting.
  const isZeroU = selectedType != null && selectedType.u_height === 0
  // Only a type known to take units clears it: before the types load,
  // selectedType is undefined, and a side-mounted strip must keep its mount.
  const takesUnits = selectedType != null && selectedType.u_height !== 0
  useEffect(() => {
    if (takesUnits && mount !== "") {
      setMount("")
      setMountOffset("")
      setMountSpan("")
    }
  }, [takesUnits, mount])
  useEffect(() => {
    if (mount === "") return
    // A side-mounted strip has no U position and no half-width side. `face`
    // SURVIVES: on a 0U strip it names the channel it bolts into, and the
    // elevation uses it to draw the strip on that face only.
    if (position !== "") setPosition("")
    if (side !== "") setSide("")
  }, [mount, position, side])

  // One option per possible *lowest* unit, in the rack's visual order (top
  // first). Units where the device would collide render disabled with the
  // blocking device as hint - the backend's overlap rules, which the
  // elevation under the fields draws by too (lib/rack-placement).
  const unitOptions = useMemo(() => {
    if (!selectedRack) return []
    const first = selectedRack.starting_unit
    const last = selectedRack.starting_unit + selectedRack.u_height - 1
    const occupants = rackDevices.data?.results ?? []
    const mounted = { face, width: rackWidth, side }
    const blockerAt = (p: number) => {
      for (let u = p; u < p + deviceHeight; u++) {
        const b = unitBlocker(occupants, mounted, u, device?.id)
        if (b) return b
      }
      return undefined
    }
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
        label: fmtUnits(p, deviceHeight),
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

  // "Save and add another": keep the form open with the shared context
  // (site, role, table…) and clear only what names this one.
  const againRef = useRef(false)
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
        mount: rackId && isZeroU ? mount : "",
        mount_offset_mm:
          rackId && mount !== "" && mountOffset.trim() !== ""
            ? Number(mountOffset)
            : null,
        mount_span_u:
          rackId && mount !== "" && mountSpan.trim() !== ""
            ? Number(mountSpan)
            : null,
        // No offset with a rail: the server takes the first gap that fits.
        cabinet_id: cabinetId,
        din_rail_id: cabinetId ? railId : null,
        din_offset_mm:
          cabinetId && railId && dinOffset.trim() !== ""
            ? Number(dinOffset)
            : null,
        comments: comments.trim(),
        airflow,
        port_labels: portLabels,
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
        topology_card: topologyCard,
        topology_photo_size: photoSize ?? "",
      }
      const saved = await saveObject<Device>({
        objectType: "api.device",
        endpoint: "/api/devices/",
        id: isEdit ? device!.id : undefined,
        payload,
      })
      await bindingDrafts.commit()
      return saved
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["devices"] })
      qc.invalidateQueries({ queryKey: ["devices-picker"] })
      qc.invalidateQueries({ queryKey: ["device", saved.id] })
      // A new device brings its type's ports; a stack move moves them.
      invalidatePortCounts(qc)
      if (saved.cabinet || device?.cabinet) invalidateCabinetDeviceViews(qc)
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      if (againRef.current) {
        againRef.current = false
        setName("")
        setSerial("")
        setAssetTag("")
        return
      }
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
      <FormColumns>
        <FormColumn>
          <FormSection title="Device" card>
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
            <div className="grid gap-3 @md:grid-cols-2">
              <DeviceTypePicker
                required
                value={deviceTypeId}
                onChange={setDeviceTypeId}
                error={fieldErrors.device_type_id}
              />
              <FormStatusSelect
                value={statusId}
                onChange={setStatusId}
                options={statuses.data?.results ?? []}
                error={fieldErrors.status_id}
              />
            </div>
            <FormCombobox
              label="Site"
              required
              hint={siteLocked ? "locked to your site" : undefined}
              value={siteId}
              onChange={pickSite}
              noneLabel="No site"
              disabled={siteLocked}
              options={sites.options.map((s) => ({
                value: s.id,
                label: s.name,
              }))}
              error={fieldErrors.site_id}
              searchPlaceholder="Search sites…"
              emptyText="No sites."
            />
            <div className="grid gap-3 @md:grid-cols-2">
              <FormCombobox
                label="Role"
                hint="optional"
                value={roleId}
                onChange={setRoleId}
                options={(roles.data?.results ?? []).map((r) => ({
                  value: r.id,
                  label: r.name,
                  color: r.color,
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
                      {
                        name: "description",
                        label: "Description",
                        type: "textarea",
                      },
                    ]}
                    onCreated={(r) => {
                      qc.invalidateQueries({
                        queryKey: ["device-roles-picker"],
                      })
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
          </FormSection>
          <FormSection title="Notes" card>
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
          </FormSection>
          <FormSection title="Topology card" card>
            <Field
              label="Card lines"
              info="Device, then view, then role, then All devices."
              error={fieldErrors.topology_card}
            >
              <CardLinesEditor
                value={topologyCard}
                onChange={setTopologyCard}
                config={cardConfig.data}
                inherited={cardInherited?.fields ?? []}
                from={
                  cardInherited?.from.level === "role" && role ? (
                    <ColorBadge name={role.name} color={role.color} />
                  ) : (
                    "All devices"
                  )
                }
              />
            </Field>
            <TopologyPhotoSizeSelect
              label="Photo size"
              value={photoSize}
              onChange={setPhotoSize}
              error={fieldErrors.topology_photo_size}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Hardware" card>
            <div className="grid gap-3 @md:grid-cols-2">
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
            {visibility.airflow && (
              <FormSelect
                label="Airflow"
                value={airflow === "" ? null : airflow}
                onChange={(v) => setAirflow(v ?? "")}
                noneLabel="-"
                options={AIRFLOW_OPTIONS}
                error={fieldErrors.airflow}
              />
            )}
            <FormSelect
              label="Port labels"
              value={portLabels === "" ? null : portLabels}
              onChange={(v) => setPortLabels((v ?? "") as DevicePortLabels)}
              noneLabel="Inherit"
              options={PORT_LABEL_OPTIONS}
              error={fieldErrors.port_labels}
            />
          </FormSection>

          <FormSection title="Placement" card>
            {(visibility.location || visibility.cluster) && (
              <div className="grid gap-3 @md:grid-cols-2">
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

            {(visibility.latitude || visibility.longitude) && (
              <div className="grid gap-3 @md:grid-cols-2">
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
          </FormSection>

          <FormSection title="Mounting" card>
            <SegmentedTabs
              items={[
                { value: "rack", label: "Rack" },
                { value: "cabinet", label: "Cabinet" },
              ]}
              value={mountIn}
              onValueChange={setMountIn}
            />
            {mountIn === "cabinet" ? (
              <DeviceCabinetFields
                name={name}
                siteId={siteId}
                cabinetId={cabinetId}
                onCabinetChange={pickCabinet}
                cabinet={cabinet.data}
                railId={railId}
                onRailChange={setRailId}
                offset={dinOffset}
                onOffsetChange={setDinOffset}
                deviceId={device?.id}
                deviceType={selectedType}
                errors={fieldErrors}
              />
            ) : (
              <>
                <RackPicker
                  hint="optional"
                  value={rackId}
                  onChange={pickRack}
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
                        pickRack(r.id)
                      }}
                    />
                  }
                />
                <div className="grid gap-3 @md:grid-cols-2">
                  <FormCombobox
                    label="Position (U)"
                    info="The device's lowest unit. Or click a free unit in the elevation below - the face you click sets Face."
                    value={position === "" ? null : position}
                    onChange={(v) => setPosition(v ?? "")}
                    options={unitOptions}
                    noneLabel="Not racked"
                    placeholder={
                      rackId ? "Pick a unit…" : "Select a rack first"
                    }
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
                    noneLabel="-"
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
                      onChange={(v) =>
                        setSide(v === "right" ? "right" : "left")
                      }
                      options={[
                        { value: "left", label: "Left half" },
                        { value: "right", label: "Right half" },
                      ]}
                      error={fieldErrors.rack_side}
                    />
                  )}
                </div>
                {isZeroU && rackId && (
                  <div className="grid gap-3">
                    <FormSelect
                      label="Side mount (0U)"
                      hint="Vertical strips (PDUs) bolt to a rail instead of taking units"
                      value={mount === "" ? null : mount}
                      onChange={(v) =>
                        setMount(
                          v === "side_left" || v === "side_right" ? v : ""
                        )
                      }
                      noneLabel="Not side-mounted"
                      options={[
                        { value: "side_left", label: "Left rail" },
                        { value: "side_right", label: "Right rail" },
                      ]}
                      error={fieldErrors.mount}
                    />
                    {mount !== "" && (
                      <>
                        <FormSelect
                          label="Channel"
                          hint="Which face the strip is reachable from - blank shows it on both elevations"
                          value={face === "" ? null : face}
                          onChange={(v) =>
                            setFace(v === "front" || v === "rear" ? v : "")
                          }
                          noneLabel="Unspecified (both)"
                          options={[
                            { value: "front", label: "Front channel" },
                            { value: "rear", label: "Rear channel" },
                          ]}
                          error={fieldErrors.face}
                        />
                        <div className="grid gap-3 @md:grid-cols-2">
                          <FormText
                            label="Offset from base (mm)"
                            value={mountOffset}
                            onChange={setMountOffset}
                            placeholder="0"
                            error={fieldErrors.mount_offset_mm}
                          />
                          <FormText
                            label="Span (U)"
                            value={mountSpan}
                            onChange={setMountSpan}
                            placeholder="auto (~¾ rack)"
                            error={fieldErrors.mount_span_u}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
                {rackId && mount === "" && (
                  <RackPlacement
                    rackId={rackId}
                    devices={rackDevices.data?.results}
                    deviceId={device?.id}
                    name={name}
                    position={position}
                    face={face}
                    mount={{ width: rackWidth, side, height: deviceHeight }}
                    onPlace={(p, f) => {
                      setPosition(String(p))
                      setFace(f)
                    }}
                  />
                )}
              </>
            )}
          </FormSection>

          <FormSection title="Stack membership" card>
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
            <div className="grid gap-3 @md:grid-cols-2">
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
          </FormSection>

          {device?.id && (
            <BindingDraftsProvider value={bindingDrafts}>
              <FormSection title="Monitoring" card>
                <MonitoringEngineField
                  scope="device"
                  objectId={device.id}
                  disabled={!canDo("device", "change")}
                />
              </FormSection>
            </BindingDraftsProvider>
          )}
        </FormColumn>
      </FormColumns>

      <Field label="Tags" error={fieldErrors.tag_ids}>
        {" "}
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />{" "}
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
        secondary={
          isEdit ? undefined : (
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => {
                againRef.current = true
                mutation.mutate()
              }}
            >
              Save and add another
            </Button>
          )
        }
      />
    </form>
  )
}
