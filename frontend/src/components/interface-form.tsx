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
import { usePlanTarget, useSaveObject } from "@/lib/save-object"
import { apiErrorToast } from "@/lib/api-toast"
import { syncPortReservation } from "@/components/port-reservation-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { DevicePicker } from "@/components/device-picker"
import { VlanPicker } from "@/components/vlan-picker"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { NameRangeHint } from "@/components/name-range-hint"
import { createEach, expandNameRange } from "@/lib/name-range"
import { useDcimChoices } from "@/lib/use-dcim-choices"

export interface InterfaceFormProps {
  iface?: Interface
  /** Pre-select a device (e.g. when adding from a device page). */
  initialDeviceId?: string
  /** `i` is the last one saved; `count` > 1 when a [a-b] name range created
   * several at once. */
  onSaved: (i: Interface, count: number) => void
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
  const saveObject = useSaveObject()
  const isPlanning = !!usePlanTarget()
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
  const [markConnected, setMarkConnected] = useState(
    iface?.mark_connected ?? false
  )
  // A direct hold on the (uncabled) port - see syncPortReservation. Mutually
  // exclusive with mark_connected: a physically present cable beats a hold.
  const [reserved, setReserved] = useState(!!iface?.reservation)
  const [reserveNote, setReserveNote] = useState(iface?.reservation?.note ?? "")
  const [comboGroup, setComboGroup] = useState(iface?.combo_group ?? "")
  // The name SNMP reports for this port; clearing it unlinks discovery.
  const [snmpName, setSnmpName] = useState(iface?.snmp_name ?? "")
  const [snmpIgnore, setSnmpIgnore] = useState(iface?.snmp_ignore ?? false)
  const [isUplink, setIsUplink] = useState(iface?.is_uplink ?? false)
  const [duplex, setDuplex] = useState(iface?.duplex ?? "")
  const [poeMode, setPoeMode] = useState(iface?.poe_mode ?? "")
  const [poeType, setPoeType] = useState(iface?.poe_type ?? "")
  const [wwn, setWwn] = useState(iface?.wwn ?? "")
  const [description, setDescription] = useState(iface?.description ?? "")
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
    setMarkConnected(iface.mark_connected ?? false)
    setReserved(!!iface.reservation)
    setReserveNote(iface.reservation?.note ?? "")
    setComboGroup(iface.combo_group ?? "")
    setSnmpName(iface.snmp_name ?? "")
    setSnmpIgnore(iface.snmp_ignore ?? false)
    setIsUplink(iface.is_uplink ?? false)
    setDuplex(iface.duplex)
    setPoeMode(iface.poe_mode)
    setPoeType(iface.poe_type)
    setWwn(iface.wwn)
    setDescription(iface.description ?? "")
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
        mark_connected: markConnected,
        combo_group: comboGroup.trim(),
        snmp_name: snmpName.trim(),
        snmp_ignore: snmpIgnore,
        is_uplink: isUplink,
        duplex,
        poe_mode: poeMode,
        poe_type: poeType,
        wwn: wwn.trim(),
        description: description.trim(),
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
        return saveObject<Interface>({
          objectType: "api.interface",
          endpoint: "/api/interfaces/",
          id: iface!.id,
          payload,
        }).then((saved) => ({ saved, count: 1 }))
      // A [a-b] range in the name fans out - "eth[0-3]" adds four ports. For a
      // whole switch face, /interfaces/bulk does it server-side. In plan mode
      // saveObject stages one create per expanded name, so a planned range
      // records four new interfaces rather than one.
      const names = expandNameRange(payload.name)
      if (names.length > 1 && isPlanning)
        return saveObject<Interface>({
          objectType: "api.interface",
          endpoint: "/api/interfaces/",
          payload,
          names,
        }).then((saved) => ({ saved, count: names.length }))
      return createEach(names, (n) =>
        saveObject<Interface>({
          objectType: "api.interface",
          endpoint: "/api/interfaces/",
          payload: { ...payload, name: n },
        })
      ).then(({ last, count }) => ({ saved: last, count }))
    },
    onSuccess: ({ saved, count }) => {
      // Reservation rides alongside the interface row (its own API object);
      // fan-out creates and staged plans skip it - it holds ONE real port.
      if (count === 1 && !isPlanning && !saved.cable && !markConnected) {
        void syncPortReservation({
          kind: "interface",
          portId: saved.id,
          existing: iface?.reservation ?? null,
          reserved,
          note: reserveNote.trim(),
        }).catch((err) =>
          apiErrorToast(err, "Could not update the reservation")
        )
      }
      qc.invalidateQueries({ queryKey: ["interfaces"] })
      qc.invalidateQueries({ queryKey: ["interface", saved.id] })
      qc.invalidateQueries({ queryKey: ["device-interfaces"] })
      toast.success(
        isEdit
          ? `Updated ${saved.name}`
          : count > 1
            ? `Created ${count} interfaces`
            : `Created ${saved.name}`
      )
      onSaved(saved, count)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  // Same-device interfaces (minus self) - candidates for parent / LAG / bridge.
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
          hint={isEdit ? undefined : "a [0-3] range adds one port per number"}
          error={fieldErrors.name}
        />
        {isEdit && (
          <FormText
            label="SNMP name"
            hint="what discovery calls this port - clear to unlink"
            value={snmpName}
            onChange={setSnmpName}
            mono
            placeholder="eth0"
            error={fieldErrors.snmp_name}
          />
        )}
        <FormText
          label="Speed"
          value={speed}
          onChange={setSpeed}
          placeholder="10G"
          suggestions={choices.common_speeds}
          error={fieldErrors.speed}
        />
      </div>
      <NameRangeHint name={name} editing={isEdit} noun="interfaces" />
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
          noneLabel="-"
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
          noneLabel="-"
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
      <FormText
        label="Combo group"
        value={comboGroup}
        onChange={setComboGroup}
        placeholder="e.g. mgmt"
        info="Combo / shared port: give the alternate connectors of one logical port the same group (an RJ45 and its SFP twin). Enabling one automatically disables the others on this device, so only the live connector shows as up."
        error={fieldErrors.combo_group}
      />

      {/* ── L2 switching ── */}
      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="802.1Q mode"
          value={mode || null}
          onChange={(v) => setMode(v ?? "")}
          noneLabel="-"
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
                  <Checkbox
                    checked={taggedVlanIds.includes(v.id)}
                    onCheckedChange={(c) =>
                      setTaggedVlanIds((cur) =>
                        c ? [...cur, v.id] : cur.filter((id) => id !== v.id)
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
      <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
        <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
        <FormCheckbox
          label="Management only"
          checked={mgmtOnly}
          onChange={setMgmtOnly}
        />
        <FormCheckbox
          label="Mark connected"
          hint="a cable is in the port, just not documented yet"
          checked={markConnected}
          onChange={(v) => {
            setMarkConnected(v)
            if (v) setReserved(false)
          }}
        />
        {!iface?.cable && (
          <FormCheckbox
            label="Reserved"
            hint="hold this port before the far end is known"
            checked={reserved}
            onChange={(v) => {
              setReserved(v)
              if (v) setMarkConnected(false)
            }}
          />
        )}
        {reserved && !iface?.cable && (
          <FormText
            label="Reservation note"
            value={reserveNote}
            onChange={setReserveNote}
            placeholder="Who or what this port is for"
          />
        )}
        <FormCheckbox
          label="Virtual interface"
          hint="sub-interface, LAG, or loopback"
          checked={virtual}
          onChange={setVirtual}
        />
        {isEdit && (
          <FormCheckbox
            label="Exclude from SNMP drift"
            hint="the polled agent can never report this port"
            checked={snmpIgnore}
            onChange={setSnmpIgnore}
          />
        )}
        <FormCheckbox
          label="Uplink"
          hint="faces other network gear - never suggest hosts on this port"
          checked={isUplink}
          onChange={setIsUplink}
        />
      </div>
      <FormText
        label="Description"
        value={description}
        onChange={setDescription}
        placeholder="Optional"
        error={fieldErrors.description}
      />
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
