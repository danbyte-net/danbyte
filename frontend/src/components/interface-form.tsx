import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  type VRFOption,
  api,
  type Interface,
  type InterfaceWritePayload,
  type Paginated,
  type Status,
  type TagOption,
  type VLANOption,
} from "@/lib/api"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormColumn,
  FormColumns,
  FormSection,
  FormStatusSelect,
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
  const statuses = useQuery({
    queryKey: ["statuses", "interface"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=interface&picker=1"),
    staleTime: 5 * 60_000,
  })
  const saveObject = useSaveObject()
  const isPlanning = !!usePlanTarget()
  const choices = useDcimChoices()

  const [deviceId, setDeviceId] = useState<string | null>(
    iface?.device.id ?? initialDeviceId ?? null
  )
  const [name, setName] = useState(iface?.name ?? "")
  const [label, setLabel] = useState(iface?.label ?? "")
  const [type, setType] = useState(iface?.type ?? "")
  const [speed, setSpeed] = useState(iface?.speed ?? "")
  const [mtu, setMtu] = useState(iface?.mtu != null ? String(iface.mtu) : "")
  const [enabled, setEnabled] = useState(iface?.enabled ?? true)
  const [statusId, setStatusId] = useState<string | null>(
    iface?.status?.id ?? null
  )
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
    setStatusId(iface.status?.id ?? null)
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

  // The device's own site floats its VLANs to the top of both pickers
  // (#136) - shared/other-site VLANs stay reachable below, never hidden.
  const deviceQ = useQuery({
    queryKey: ["device", deviceId],
    queryFn: () =>
      api<{
        site: { id: string } | null
        virtual_chassis: { id: string; name: string } | null
      }>(`/api/devices/${deviceId}/`),
    enabled: !!deviceId,
    staleTime: 60_000,
  })
  const deviceSiteId = deviceQ.data?.site?.id ?? null
  const vcId = deviceQ.data?.virtual_chassis?.id ?? null
  const vlans = useQuery({
    queryKey: ["vlans-picker"],
    queryFn: () => api<Paginated<VLANOption>>("/api/vlans/"),
    staleTime: 10 * 60_000,
  })
  const taggedRows = useMemo(() => {
    const all = vlans.data?.results ?? []
    if (!deviceSiteId) return all
    return [
      ...all.filter((v) => v.site?.id === deviceSiteId),
      ...all.filter((v) => v.site?.id !== deviceSiteId),
    ]
  }, [vlans.data, deviceSiteId])
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/?picker=1"),
    staleTime: 10 * 60_000,
  })
  // Candidate parents / LAGs / bridges: the device's own interfaces - or,
  // on a stack, every member's, so a port can join the aggregate that lives
  // on the master (#145). Waits for the device so the query key is final.
  const parents = useQuery({
    queryKey: ["interfaces-picker", deviceId, vcId],
    queryFn: () =>
      api<Paginated<Pick<Interface, "id" | "name" | "device">>>(
        vcId
          ? `/api/interfaces/?virtual_chassis=${vcId}&page_size=1000`
          : `/api/interfaces/?device=${deviceId}`
      ),
    enabled: !!deviceId && deviceQ.isSuccess,
    staleTime: 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      // A port never moves between devices - the field is locked on edit and
      // left out of the payload so a stale form can't move it either.
      const payload: InterfaceWritePayload = {
        ...(isEdit ? {} : { device_id: deviceId ?? "" }),
        name: name.trim(),
        label: label.trim(),
        type,
        speed: speed.trim(),
        mtu: mtu.trim() === "" ? null : Number(mtu),
        enabled,
        status_id: statusId,
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
    onSuccess: async ({ saved, count }) => {
      // The hold is its own API object riding alongside the port row.
      // Awaited (not fire-and-forget) so the invalidations below can't race
      // it - a reservation written after the refetch left the row looking
      // unchanged until the cache went stale.
      if (count === 1 && !isPlanning && !saved.cable && !markConnected) {
        try {
          await syncPortReservation({
            kind: "interface",
            portId: saved.id,
            existing: iface?.reservation ?? null,
            reserved,
            note: reserveNote.trim(),
          })
        } catch (err) {
          apiErrorToast(err, "Saved, but the reservation didn't update")
        }
      }
      // The faceplate paints ports from their cable state, so it goes stale
      // on a reservation change too.
      qc.invalidateQueries({ queryKey: ["device-face-ports"] })
      qc.invalidateQueries({ queryKey: ["port-reservations"] })
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

  // Candidates for parent / LAG / bridge (minus self). Own ports first; a
  // port on another stack member is labelled with its device.
  const ifaceOptions = (parents.data?.results ?? [])
    .filter((p) => p.id !== iface?.id)
    .sort((a, b) =>
      a.device.id === b.device.id
        ? 0
        : a.device.id === deviceId
          ? -1
          : b.device.id === deviceId
            ? 1
            : a.device.name.localeCompare(b.device.name)
    )
    .map((p) => ({
      value: p.id,
      label: p.device.id === deviceId ? p.name : `${p.device.name}: ${p.name}`,
    }))
  const noIfaceText = vcId
    ? "No other interfaces on this stack."
    : "No other interfaces on this device."

  // A legacy/custom media type still round-trips: surface it at the top of
  // the dropdown instead of silently blanking the field.
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
      <FormColumns>
        <FormColumn>
          <FormSection title="Interface" card>
            <DevicePicker
              value={deviceId}
              onChange={setDeviceId}
              disabled={isEdit}
              hint={isEdit ? "fixed" : undefined}
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
                info={
                  isEdit ? undefined : (
                    <span className="grid gap-1">
                      <span>
                        <b className="font-mono text-foreground">[0-3]</b> in
                        the name creates one port per number.
                      </span>
                      <span>
                        <b className="font-mono text-foreground">
                          {"{position}"}
                        </b>{" "}
                        resolves to the device&apos;s stack member number, so a
                        template port is named for the member it sits on.
                      </span>
                    </span>
                  )
                }
                error={fieldErrors.name}
              />
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
            </div>
            <NameRangeHint name={name} editing={isEdit} noun="interfaces" />
              <FormText
                label="Label"
                hint="Printed name, e.g. X1-P1"
                value={label}
                onChange={setLabel}
                mono
                error={fieldErrors.label}
              />
          </FormSection>

          <FormSection title="Switching" card>
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
                label={
                  mode === "tagged" ? "Untagged / native VLAN" : "Untagged VLAN"
                }
                preferQuery={
                  deviceSiteId ? `site=${deviceSiteId}` : undefined
                }
                value={vlanId}
                onChange={setVlanId}
                noneLabel="No VLAN"
                placeholder="No VLAN"
                error={fieldErrors.vlan_id}
              />
            </div>
            {mode === "tagged" && (
              <Field
                label="Tagged VLANs (trunk)"
                error={fieldErrors.tagged_vlan_ids}
              >
                <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border p-2">
                  {taggedRows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No VLANs yet.
                    </p>
                  ) : (
                    taggedRows.map((v) => (
                      <label
                        key={v.id}
                        className="flex items-center gap-2 text-[13px]"
                      >
                        <Checkbox
                          checked={taggedVlanIds.includes(v.id)}
                          onCheckedChange={(c) =>
                            setTaggedVlanIds((cur) =>
                              c
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
                color: v.color,
              }))}
              error={fieldErrors.vrf_id}
            />
          </FormSection>

          <FormSection title="Notes" card>
            <FormText
              label="Description"
              value={description}
              onChange={setDescription}
              placeholder="Optional"
              error={fieldErrors.description}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="State" card>
            <div className="mb-3 max-w-xs">
              <FormStatusSelect
                value={statusId}
                onChange={setStatusId}
                options={statuses.data?.results ?? []}
                noneLabel="Active"
                placeholder="Active"
                error={fieldErrors.status_id}
              />
            </div>
            <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
              <FormCheckbox
                label="Enabled"
                checked={enabled}
                onChange={setEnabled}
              />
              <FormCheckbox
                label="Management only"
                checked={mgmtOnly}
                onChange={setMgmtOnly}
              />
              <FormCheckbox
                label="Mark connected"
                checked={markConnected}
                onChange={(v) => {
                  setMarkConnected(v)
                  if (v) setReserved(false)
                }}
              />
              {!iface?.cable && (
                <FormCheckbox
                  label="Reserved"
                  checked={reserved}
                  onChange={(v) => {
                    setReserved(v)
                    if (v) setMarkConnected(false)
                  }}
                />
              )}
              <FormCheckbox
                label="Uplink"
                checked={isUplink}
                onChange={setIsUplink}
              />
            </div>
            {reserved && !iface?.cable && (
              <FormText
                label="Reservation note"
                value={reserveNote}
                onChange={setReserveNote}
                placeholder="Who or what this port is for"
              />
            )}
          </FormSection>

          <FormSection title="Hardware" card>
            <div className="grid grid-cols-3 gap-3">
              <FormText
                label="Speed"
                value={speed}
                onChange={setSpeed}
                placeholder="10G"
                suggestions={choices.common_speeds}
                error={fieldErrors.speed}
              />
              <FormText
                label="MTU"
                type="number"
                value={mtu}
                onChange={setMtu}
                placeholder="1500"
                error={fieldErrors.mtu}
              />
              <FormSelect
                label="Duplex"
                value={duplex || null}
                onChange={(v) => setDuplex(v ?? "")}
                noneLabel="-"
                options={choices.interface_duplex}
                error={fieldErrors.duplex}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormText
                label="MAC address"
                value={mac}
                onChange={setMac}
                mono
                placeholder="00:1b:44:11:3a:b7"
                error={fieldErrors.mac_address}
              />
              <FormText
                label="WWN"
                value={wwn}
                onChange={setWwn}
                mono
                hint="Fibre Channel World Wide Name"
                placeholder="10:00:00:90:fa:12:34:56"
                error={fieldErrors.wwn}
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
              label="Combo group"
              value={comboGroup}
              onChange={setComboGroup}
              placeholder="e.g. mgmt"
              info="Combo / shared port: give the alternate connectors of one logical port the same group (an RJ45 and its SFP twin). Enabling one automatically disables the others on this device, so only the live connector shows as up."
              error={fieldErrors.combo_group}
            />
          </FormSection>

          <FormSection title="Nesting" card>
            <FormCheckbox
              label="Virtual interface"
              checked={virtual}
              onChange={setVirtual}
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
              emptyText={noIfaceText}
              options={ifaceOptions}
              error={fieldErrors.parent_id}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormCombobox
                label="LAG / aggregate"
                value={lagId}
                onChange={setLagId}
                noneLabel="Not a LAG member"
                placeholder={
                  deviceId ? "Not a LAG member" : "Pick a device first"
                }
                searchPlaceholder="Search interfaces…"
                emptyText={noIfaceText}
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
                emptyText={noIfaceText}
                options={ifaceOptions}
                error={fieldErrors.bridge_id}
              />
            </div>
          </FormSection>

          {isEdit && (
            <FormSection title="SNMP" card>
              <FormText
                label="SNMP name"
                hint="what discovery calls this port - clear to unlink"
                value={snmpName}
                onChange={setSnmpName}
                mono
                placeholder="eth0"
                error={fieldErrors.snmp_name}
              />
              <FormCheckbox
                label="Exclude from SNMP drift"
                checked={snmpIgnore}
                onChange={setSnmpIgnore}
              />
            </FormSection>
          )}
        </FormColumn>
      </FormColumns>

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
