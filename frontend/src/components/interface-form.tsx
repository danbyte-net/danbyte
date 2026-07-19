import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Interface,
  type InterfaceOption,
  type InterfaceWritePayload,
  type Paginated,
  type TagOption,
  type VLANOption,
} from "@/lib/api"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { DevicePicker } from "@/components/device-picker"
import { VlanPicker } from "@/components/vlan-picker"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { useDcimChoices } from "@/lib/use-dcim-choices"

export interface InterfaceFormProps {
  iface?: Interface
  /** Pre-select a device (e.g. when adding from a device page). */
  initialDeviceId?: string
  onSaved: (i: Interface) => void
  onCancel: () => void
}

export function InterfaceForm({
  iface,
  initialDeviceId,
  onSaved,
  onCancel,
}: InterfaceFormProps) {
  const isEdit = !!iface
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const choices = useDcimChoices()

  const [deviceId, setDeviceId] = useState<string | null>(
    iface?.device.id ?? initialDeviceId ?? null
  )
  const [name, setName] = useState(iface?.name ?? "")
  const [type, setType] = useState(iface?.type ?? "")
  const [speed, setSpeed] = useState(iface?.speed ?? "")
  const [mtu, setMtu] = useState(iface?.mtu != null ? String(iface.mtu) : "")
  const [enabled, setEnabled] = useState(iface?.enabled ?? true)
  const [mac, setMac] = useState(iface?.mac_address ?? "")
  const [mgmtOnly, setMgmtOnly] = useState(iface?.mgmt_only ?? false)
  const [duplex, setDuplex] = useState(iface?.duplex ?? "")
  const [poeMode, setPoeMode] = useState(iface?.poe_mode ?? "")
  const [poeType, setPoeType] = useState(iface?.poe_type ?? "")
  const [wwn, setWwn] = useState(iface?.wwn ?? "")
  const [mode, setMode] = useState(iface?.mode ?? "")
  const [vlanId, setVlanId] = useState<string | null>(iface?.vlan?.id ?? null)
  const [taggedVlanIds, setTaggedVlanIds] = useState<string[]>(
    iface?.tagged_vlans.map((v) => v.id) ?? []
  )
  const [vrfId, setVrfId] = useState<string | null>(iface?.vrf?.id ?? null)
  const [virtual, setVirtual] = useState(iface?.virtual ?? false)
  const [parentId, setParentId] = useState<string | null>(
    iface?.parent?.id ?? null
  )
  const [lagId, setLagId] = useState<string | null>(iface?.lag?.id ?? null)
  const [bridgeId, setBridgeId] = useState<string | null>(
    iface?.bridge?.id ?? null
  )
  const [tagIds, setTagIds] = useState<number[]>(
    iface?.tags.map((t) => t.id) ?? []
  )

  useEffect(() => {
    if (!iface) return
    setDeviceId(iface.device.id)
    setName(iface.name)
    setType(iface.type)
    setSpeed(iface.speed)
    setMtu(iface.mtu != null ? String(iface.mtu) : "")
    setEnabled(iface.enabled)
    setMac(iface.mac_address)
    setMgmtOnly(iface.mgmt_only)
    setDuplex(iface.duplex)
    setPoeMode(iface.poe_mode)
    setPoeType(iface.poe_type)
    setWwn(iface.wwn)
    setMode(iface.mode)
    setVlanId(iface.vlan?.id ?? null)
    setTaggedVlanIds(iface.tagged_vlans.map((v) => v.id))
    setVrfId(iface.vrf?.id ?? null)
    setVirtual(iface.virtual)
    setParentId(iface.parent?.id ?? null)
    setLagId(iface.lag?.id ?? null)
    setBridgeId(iface.bridge?.id ?? null)
    setTagIds(iface.tags.map((t) => t.id))
    reset()
  }, [iface, reset])

  const vlans = useQuery({
    queryKey: ["vlans-picker"],
    queryFn: () => api<Paginated<VLANOption>>("/api/vlans/"),
    staleTime: 10 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<{ id: string; name: string }>>("/api/vrfs/"),
    staleTime: 10 * 60_000,
  })
  // Candidate parents: other interfaces on the same device (excluding self).
  const parents = useQuery({
    queryKey: ["interfaces-picker", deviceId],
    queryFn: () =>
      api<Paginated<InterfaceOption>>(`/api/interfaces/?device=${deviceId}`),
    enabled: !!deviceId,
    staleTime: 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: InterfaceWritePayload = {
        device_id: deviceId ?? "",
        name: name.trim(),
        type,
        speed: speed.trim(),
        mtu: mtu.trim() === "" ? null : Number(mtu),
        enabled,
        mac_address: mac.trim(),
        mgmt_only: mgmtOnly,
        duplex,
        poe_mode: poeMode,
        poe_type: poeType,
        wwn: wwn.trim(),
        mode,
        vlan_id: vlanId,
        tagged_vlan_ids: mode === "tagged" ? taggedVlanIds : [],
        vrf_id: vrfId,
        tag_ids: tagIds,
        virtual,
        parent_id: parentId,
        lag_id: lagId,
        bridge_id: bridgeId,
      }
      if (isEdit)
        return api<Interface>(`/api/interfaces/${iface!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Interface>("/api/interfaces/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["interfaces"] })
      qc.invalidateQueries({ queryKey: ["interface", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  // Same-device interfaces (minus self) — candidates for parent / LAG / bridge.
  const ifaceOptions = (parents.data?.results ?? [])
    .filter((p) => p.id !== iface?.id)
    .map((p) => ({ value: p.id, label: p.name }))

  // Standard interface types; keep any legacy/custom value selectable.
  const typeOptions = [...choices.interface_types]
  if (type && !typeOptions.some((o) => o.value === type)) {
    typeOptions.unshift({ value: type, label: type })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      <DevicePicker
        value={deviceId}
        onChange={setDeviceId}
        error={fieldErrors.device_id}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          mono
          placeholder="GigabitEthernet0/1"
          error={fieldErrors.name}
        />
        <FormText
          label="Speed"
          value={speed}
          onChange={setSpeed}
          placeholder="10G"
          suggestions={choices.common_speeds}
          error={fieldErrors.speed}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormCombobox
          label="Type"
          value={type || null}
          onChange={(v) => setType(v ?? "")}
          noneLabel="No type"
          placeholder="Pick a type"
          searchPlaceholder="Search types…"
          emptyText="No types."
          options={typeOptions}
          error={fieldErrors.type}
        />
        <FormText
          label="MTU"
          type="number"
          value={mtu}
          onChange={setMtu}
          placeholder="1500"
          error={fieldErrors.mtu}
        />
        <FormText
          label="MAC address"
          value={mac}
          onChange={setMac}
          mono
          placeholder="00:1b:44:11:3a:b7"
          error={fieldErrors.mac_address}
        />
      </div>

      {/* ── Physical extras ── */}
      <div className="grid grid-cols-3 gap-3">
        <FormSelect
          label="Duplex"
          value={duplex || null}
          onChange={(v) => setDuplex(v ?? "")}
          noneLabel="—"
          options={choices.interface_duplex}
          error={fieldErrors.duplex}
        />
        <FormSelect
          label="PoE mode"
          value={poeMode || null}
          onChange={(v) => setPoeMode(v ?? "")}
          noneLabel="No PoE"
          options={choices.poe_modes}
          error={fieldErrors.poe_mode}
        />
        <FormSelect
          label="PoE type"
          value={poeType || null}
          onChange={(v) => setPoeType(v ?? "")}
          noneLabel="—"
          options={choices.poe_types}
          error={fieldErrors.poe_type}
        />
      </div>
      <FormText
        label="WWN"
        value={wwn}
        onChange={setWwn}
        mono
        hint="Fibre Channel World Wide Name (optional)"
        placeholder="10:00:00:90:fa:12:34:56"
        error={fieldErrors.wwn}
      />

      {/* ── L2 switching ── */}
      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="802.1Q mode"
          value={mode || null}
          onChange={(v) => setMode(v ?? "")}
          noneLabel="—"
          options={[
            { value: "access", label: "Access" },
            { value: "tagged", label: "Tagged (trunk)" },
            { value: "tagged-all", label: "Tagged (all VLANs)" },
          ]}
          error={fieldErrors.mode}
        />
        <VlanPicker
          label={mode === "tagged" ? "Untagged / native VLAN" : "Untagged VLAN"}
          value={vlanId}
          onChange={setVlanId}
          noneLabel="No VLAN"
          placeholder="No VLAN"
          error={fieldErrors.vlan_id}
        />
      </div>
      {mode === "tagged" && (
        <Field label="Tagged VLANs (trunk)" error={fieldErrors.tagged_vlan_ids}>
          <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border p-2">
            {(vlans.data?.results ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No VLANs yet.</p>
            ) : (
              (vlans.data?.results ?? []).map((v) => (
                <label
                  key={v.id}
                  className="flex items-center gap-2 text-[13px]"
                >
                  <input
                    type="checkbox"
                    className="ck"
                    checked={taggedVlanIds.includes(v.id)}
                    onChange={(e) =>
                      setTaggedVlanIds((cur) =>
                        e.target.checked
                          ? [...cur, v.id]
                          : cur.filter((id) => id !== v.id)
                      )
                    }
                  />
                  <span className="font-mono">
                    {v.vlan_id} · {v.name}
                  </span>
                </label>
              ))
            )}
          </div>
        </Field>
      )}

      {/* ── L3 routing ── */}
      <FormCombobox
        label="VRF"
        value={vrfId}
        onChange={setVrfId}
        noneLabel="Global (no VRF)"
        placeholder="Global (no VRF)"
        searchPlaceholder="Search VRFs…"
        emptyText="No VRFs."
        options={(vrfs.data?.results ?? []).map((v) => ({
          value: v.id,
          label: v.name,
        }))}
        error={fieldErrors.vrf_id}
      />
      <FormCombobox
        label="Parent interface"
        value={parentId}
        onChange={setParentId}
        noneLabel="Standalone (no parent)"
        placeholder={
          deviceId ? "Standalone (no parent)" : "Pick a device first"
        }
        searchPlaceholder="Search interfaces…"
        emptyText="No other interfaces on this device."
        options={ifaceOptions}
        error={fieldErrors.parent_id}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormCombobox
          label="LAG / aggregate"
          value={lagId}
          onChange={setLagId}
          noneLabel="Not a LAG member"
          placeholder={deviceId ? "Not a LAG member" : "Pick a device first"}
          searchPlaceholder="Search interfaces…"
          emptyText="No other interfaces on this device."
          options={ifaceOptions}
          error={fieldErrors.lag_id}
        />
        <FormCombobox
          label="Bridge"
          value={bridgeId}
          onChange={setBridgeId}
          noneLabel="No bridge"
          placeholder={deviceId ? "No bridge" : "Pick a device first"}
          searchPlaceholder="Search interfaces…"
          emptyText="No other interfaces on this device."
          options={ifaceOptions}
          error={fieldErrors.bridge_id}
        />
      </div>
      <div className="flex gap-6">
        <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
        <FormCheckbox
          label="Management only"
          checked={mgmtOnly}
          onChange={setMgmtOnly}
        />
        <FormCheckbox
          label="Virtual interface (sub-interface / LAG / loopback)"
          checked={virtual}
          onChange={setVirtual}
        />
      </div>
      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create interface"}
      />
    </form>
  )
}
