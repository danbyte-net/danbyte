import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type DhcpReservation,
  type DhcpScope,
  type IPAddress,
  type IPRoleOption,
  type StatusOption,
  type IPWritePayload,
  type IPRange,
  type IPRangeAvailable,
  type InterfaceOption,
  type Paginated,
  type Prefix,
  type SiteOption,
  type TagOption,
  type VRFOption,
} from "@/lib/api"
import { addressInRange, ipToBigInt } from "@/lib/prefix-tree"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { DevicePicker } from "@/components/device-picker"
import {
  Field,
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormStatusSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { InfoTip } from "@/components/ui/info-tip"
import { usePlanTarget, useSaveObject } from "@/lib/save-object"

export interface IpFormInitial {
  address?: string
  prefixId?: string
  /** Prefill the assignment (e.g. adding an IP from a device's interface). */
  deviceId?: string
  interfaceId?: string
  /** …or from a virtual machine's interface. */
  vmId?: string
  vmInterfaceId?: string
}

export interface IpFormProps {
  ip?: IPAddress
  initial?: IpFormInitial
  /** Clone seed (create only): carried fields from GET /api/ips/<id>/clone/.
   * The address + device/interface assignment are absent by design (start
   * blank/unassigned); prefix/status/role/DNS are pre-filled. Distinct from
   * `ip` so this still POSTs. */
  clone?: Partial<IPAddress>
  onSaved: (saved: IPAddress) => void
  onCancel: () => void
}

export function IpForm({ ip, initial, clone, onSaved, onCancel }: IpFormProps) {
  const isEdit = !!ip
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  const planning = !!usePlanTarget()
  // Cloneable fields read from the edit object or the clone seed; the address
  // and device/interface assignment read from `ip`/`initial` only, so a clone
  // starts unaddressed and unassigned.
  const seed = ip ?? clone

  const [address, setAddress] = useState(
    ip?.ip_address ?? initial?.address ?? ""
  )
  const [statusId, setStatusId] = useState<string | null>(
    seed?.status?.id ?? null
  )
  const [roleId, setRoleId] = useState<string | null>(seed?.role?.id ?? null)
  const [description, setDescription] = useState(seed?.description ?? "")
  const [reservationNote, setReservationNote] = useState(
    seed?.reservation_note ?? ""
  )
  const [deviceId, setDeviceId] = useState<string | null>(
    ip?.assigned_device?.id ?? initial?.deviceId ?? null
  )
  const [interfaceId, setInterfaceId] = useState<string | null>(
    ip?.assigned_interface?.id ?? initial?.interfaceId ?? null
  )
  // A VM assignment is the virtual counterpart of device+interface. The model
  // and API have always supported it; the form did not, so a VM's addresses
  // could only be set through the API or a sync.
  const [vmId, setVmId] = useState<string | null>(
    ip?.assigned_vm?.id ?? initial?.vmId ?? null
  )
  const [vmInterfaceId, setVmInterfaceId] = useState<string | null>(
    ip?.assigned_vm_interface?.id ?? initial?.vmInterfaceId ?? null
  )
  // L2 edge: the access switch + port this IP is reached through.
  const [switchId, setSwitchId] = useState<string | null>(
    ip?.switch?.id ?? null
  )
  const [switchInterfaceId, setSwitchInterfaceId] = useState<string | null>(
    ip?.switch_interface?.id ?? null
  )
  // Every IP must live in a prefix (non-null FK), and the prefix is what carries
  // VRF + site - so on create the user picks a subnet, optionally narrowed by
  // site/VRF. Seeded from a prefix-page launch (`initial.prefixId`) or a clone.
  const [prefixId, setPrefixId] = useState<string | null>(
    seed?.prefix?.id ?? initial?.prefixId ?? null
  )
  const [siteFilter, setSiteFilter] = useState<string | null>(null)
  const [vrfFilter, setVrfFilter] = useState<string | null>(null)
  // An IP range inside the subnet used as the pool to allocate from (#143):
  // an ISP hands out .61-.67 of a /24 that isn't yours. Optional - "any
  // address in the subnet" stays the default.
  const [rangeId, setRangeId] = useState<string | null>(null)
  useEffect(() => setRangeId(null), [prefixId])
  const rangesQuery = useQuery({
    queryKey: ["ip-ranges-in-prefix", prefixId ?? ""],
    queryFn: () =>
      api<Paginated<IPRange>>(
        `/api/ip-ranges/?prefix=${prefixId}&page_size=100`
      ),
    enabled: !isEdit && !!prefixId,
    staleTime: 60_000,
  })
  const ranges = (rangesQuery.data?.results ?? []).filter(
    (r) => r.dhcp !== "exclusion"
  )
  const selectedRange = ranges.find((r) => r.id === rangeId) ?? null
  const availableQuery = useQuery({
    queryKey: ["ip-range-available", rangeId ?? ""],
    queryFn: () => api<IPRangeAvailable>(`/api/ip-ranges/${rangeId}/available/`),
    enabled: !!rangeId,
  })

  // Launched from a device/VM interface, the target's own site pre-narrows
  // the subnet list (#135). Seeded once - clearing back to Any site sticks.
  const targetForSite = ip
    ? null
    : (initial?.deviceId ?? null) || (initial?.vmId ?? null)
  const targetSiteQ = useQuery({
    queryKey: ["ip-form-target-site", targetForSite ?? ""],
    queryFn: () =>
      api<{ site: { id: string } | null }>(
        initial?.deviceId
          ? `/api/devices/${initial.deviceId}/`
          : `/api/virtual-machines/${initial?.vmId}/`
      ),
    enabled: !!targetForSite,
    staleTime: 60_000,
  })
  const seededSite = useRef(false)
  useEffect(() => {
    if (seededSite.current) return
    const sid = targetSiteQ.data?.site?.id
    if (sid) {
      seededSite.current = true
      setSiteFilter((cur) => cur ?? sid)
    }
  }, [targetSiteQ.data])

  // Staff at a single site get that site's default prefix pre-selected - the
  // whole point of the Site → Default prefix setting. Never overrides an
  // explicit choice: an edit, a clone, or a launch from a prefix page all
  // already carry a prefix, and the effect only seeds an EMPTY picker once.
  const isNew = !ip && !seed?.prefix?.id && !initial?.prefixId
  const myDefault = useQuery({
    queryKey: ["my-default-prefix"],
    queryFn: () =>
      api<{ prefix: { id: string; cidr: string } | null }>(
        "/api/my-default-prefix/"
      ),
    enabled: isNew,
    staleTime: 5 * 60_000,
  })
  const seededDefault = useRef(false)
  useEffect(() => {
    if (!isNew || seededDefault.current) return
    const p = myDefault.data?.prefix
    if (!p) return
    seededDefault.current = true
    setPrefixId((cur) => cur ?? p.id)
  }, [isNew, myDefault.data])
  const [mac, setMac] = useState(ip?.mac_address ?? "")
  const [dnsName, setDnsName] = useState(seed?.dns_name ?? "")
  const [isPrimary, setIsPrimary] = useState(ip?.is_primary_for_device ?? false)
  // Same idea for a VM: the address it answers on (#122). Separate state
  // because an address is assigned to a device or a VM, never both.
  const [isVmPrimary, setIsVmPrimary] = useState(
    ip?.is_primary_for_vm ?? false
  )
  const [tagIds, setTagIds] = useState<number[]>(
    seed?.tags?.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    seed?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!ip) return
    setAddress(ip.ip_address)
    setStatusId(ip.status?.id ?? null)
    setRoleId(ip.role?.id ?? null)
    setDescription(ip.description)
    setReservationNote(ip.reservation_note)
    setDeviceId(ip.assigned_device?.id ?? null)
    setInterfaceId(ip.assigned_interface?.id ?? null)
    setVmId(ip.assigned_vm?.id ?? null)
    setVmInterfaceId(ip.assigned_vm_interface?.id ?? null)
    setMac(ip.mac_address ?? "")
    setDnsName(ip.dns_name ?? "")
    setIsPrimary(ip.is_primary_for_device)
    setIsVmPrimary(!!ip.is_primary_for_vm)
    setTagIds(ip.tags.map((t) => t.id))
    setCustomFields(ip.custom_fields ?? {})
    reset()
  }, [ip, reset])

  // Subnet narrowing pickers + the candidate subnets (filtered server-side by
  // the chosen site/VRF, same as AssignIpDialog).
  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<SiteOption>>("/api/sites/?picker=1"),
    enabled: !isEdit,
    staleTime: 5 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/?picker=1"),
    enabled: !isEdit,
    staleTime: 5 * 60_000,
  })
  const prefixesQuery = useQuery({
    queryKey: ["prefixes-pick", siteFilter, vrfFilter],
    queryFn: () => {
      const p = new URLSearchParams({ page_size: "500" })
      if (siteFilter) p.set("site", siteFilter)
      if (vrfFilter) p.set("vrf", vrfFilter)
      return api<Paginated<Prefix>>(`/api/prefixes/?${p}`)
    },
    enabled: !isEdit,
    staleTime: 60_000,
  })
  const selectedPrefix = prefixesQuery.data?.results.find(
    (p) => p.id === prefixId
  )

  // Prefill the network portion of the address from the chosen subnet, leaving
  // the user to type only the host part. Re-runs whenever the subnet changes,
  // but never clobbers something the user already typed.
  useEffect(() => {
    if (isEdit || !selectedPrefix) return
    setAddress((cur) =>
      cur.trim() === "" ? networkPrefill(selectedPrefix.cidr) : cur
    )
  }, [selectedPrefix, isEdit])

  const statuses = useQuery({
    queryKey: ["statuses-picker"],
    queryFn: () => api<Paginated<StatusOption>>("/api/statuses/"),
    staleTime: 10 * 60_000,
  })
  const roles = useQuery({
    queryKey: ["ip-roles-picker"],
    queryFn: () => api<Paginated<IPRoleOption>>("/api/ip-roles/"),
    staleTime: 10 * 60_000,
  })
  const vms = useQuery({
    queryKey: ["vms-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/virtual-machines/?picker=1"
      ),
    staleTime: 5 * 60_000,
  })
  const vmInterfaces = useQuery({
    queryKey: ["vm-interfaces-picker", vmId],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        `/api/vm-interfaces/?vm=${vmId}`
      ),
    enabled: !!vmId,
    staleTime: 60_000,
  })
  const interfaces = useQuery({
    queryKey: ["interfaces-picker", deviceId],
    queryFn: () =>
      api<Paginated<InterfaceOption>>(`/api/interfaces/?device=${deviceId}`),
    enabled: !!deviceId,
    staleTime: 60_000,
  })
  const switchInterfaces = useQuery({
    queryKey: ["interfaces-picker", switchId],
    queryFn: () =>
      api<Paginated<InterfaceOption>>(`/api/interfaces/?device=${switchId}`),
    enabled: !!switchId,
    staleTime: 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  // Seed default status from the catalog once it loads (create mode).
  useEffect(() => {
    if (ip || statusId) return
    const def = statuses.data?.results.find((s) => s.is_default)
    if (def) setStatusId(def.id)
  }, [ip, statusId, statuses.data])

  // ── DHCP reservation (MAC binding) ────────────────────────────────────
  // When the address sits inside a DHCP scope's pool, the form offers to
  // reserve it: saving pushes Add/Remove-DhcpServerv4Reservation to the
  // Windows server after the IP write, using the MAC field above. Queries
  // 404 harmlessly when the DHCP integration is off - the section just hides.
  const dhcpScopes = useQuery({
    queryKey: ["dhcp-scopes", "ip-form"],
    queryFn: () => api<Paginated<DhcpScope>>("/api/dhcp-scopes/?page_size=500"),
    staleTime: 60_000,
    retry: false,
  })
  const addrInt = ipToBigInt(address.trim())
  const poolScope = (dhcpScopes.data?.results ?? []).find((s) => {
    if (addrInt == null || !s.start_range || !s.end_range) return false
    const lo = ipToBigInt(s.start_range)
    const hi = ipToBigInt(s.end_range)
    return lo != null && hi != null && addrInt >= lo && addrInt <= hi
  })
  const dhcpResQuery = useQuery({
    queryKey: ["dhcp-reservation", "for-ip", address.trim()],
    queryFn: () =>
      api<Paginated<DhcpReservation>>(
        `/api/dhcp-reservations/?${new URLSearchParams({ search: address.trim() })}`
      ),
    enabled: !!address.trim() && !!dhcpScopes.data,
    staleTime: 30_000,
    retry: false,
  })
  const existingRes = (dhcpResQuery.data?.results ?? []).find(
    (r) => r.ip === address.trim()
  )
  const [dhcpReserve, setDhcpReserve] = useState(false)
  // Reflect the server's answer once it arrives (and on address change).
  useEffect(() => {
    setDhcpReserve(!!existingRes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingRes?.id])
  const canDhcp = !!poolScope || !!existingRes

  /** Post-save reconciliation: create or remove the reservation to match the
   * toggle. The IP itself is already saved - a DHCP push failure must not
   * look like a failed save, so it reports separately. */
  const syncDhcpReservation = async (savedIp: string) => {
    try {
      if (dhcpReserve && !existingRes && poolScope) {
        await api("/api/dhcp-reservations/", {
          method: "POST",
          body: JSON.stringify({
            scope: poolScope.id,
            ip: savedIp,
            mac: mac.trim(),
            name: dnsName.trim().split(".")[0] ?? "",
            description: description.trim(),
          }),
        })
        toast.success("DHCP reservation created on the server")
      } else if (!dhcpReserve && existingRes) {
        await api(`/api/dhcp-reservations/${existingRes.id}/`, {
          method: "DELETE",
        })
        toast.success("DHCP reservation removed from the server")
      }
      qc.invalidateQueries({ queryKey: ["dhcp-reservations"] })
      qc.invalidateQueries({ queryKey: ["dhcp-reservation", "for-ip"] })
    } catch (err) {
      const msg = handleApiError(err)
      toast.error(
        `The IP was saved, but the DHCP server refused the reservation change${msg ? `: ${msg}` : "."}`
      )
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: IPWritePayload = {
        ip_address: address.trim(),
        status_id: statusId,
        role_id: roleId,
        assigned_device_id: deviceId,
        assigned_interface_id: deviceId ? interfaceId : null,
        assigned_vm_id: vmId,
        assigned_vm_interface_id: vmId ? vmInterfaceId : null,
        switch_id: switchId,
        switch_interface_id: switchId ? switchInterfaceId : null,
        mac_address: mac.trim(),
        dns_name: dnsName.trim(),
        description: description.trim(),
        reservation_note: reservationNote.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (!isEdit && prefixId) payload.prefix_id = prefixId
      const saved = await saveObject<IPAddress>({
        objectType: "api.ipaddress",
        endpoint: "/api/ips/",
        id: isEdit ? ip!.id : undefined,
        payload,
      })
      // Primary IP lives on the device/VM, so it takes a second request.
      // Unticking has to clear it, or the box would only ever turn on.
      if (saved.assigned_device && isPrimary !== !!ip?.is_primary_for_device) {
        await api(`/api/devices/${saved.assigned_device.id}/`, {
          method: "PATCH",
          body: JSON.stringify({ primary_ip_id: isPrimary ? saved.id : null }),
        }).catch(() => {})
      }
      if (saved.assigned_vm && isVmPrimary !== !!ip?.is_primary_for_vm) {
        await api(`/api/virtual-machines/${saved.assigned_vm.id}/`, {
          method: "PATCH",
          body: JSON.stringify({
            primary_ip_id: isVmPrimary ? saved.id : null,
          }),
        }).catch(() => {})
      }
      // DHCP reservation rides along after the IP write (real writes only -
      // a plan can't push to an external server).
      if (!planning && canDhcp) await syncDhcpReservation(saved.ip_address)
      return saved
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["prefix-ips"] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      qc.invalidateQueries({ queryKey: ["ip", saved.id] })
      toast.success(
        isEdit ? `Updated ${saved.ip_address}` : `Created ${saved.ip_address}`
      )
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const selectedStatus = statuses.data?.results.find((s) => s.id === statusId)
  const requiresNote = !!selectedStatus?.requires_note

  const siteOpts = (sites.data?.results ?? []).map((s) => ({
    value: s.id,
    label: s.name,
  }))
  const vrfOpts = (vrfs.data?.results ?? []).map((v) => ({
    value: v.id,
    label: v.name,
  }))
  const prefixOpts = (prefixesQuery.data?.results ?? []).map((p) => ({
    value: p.id,
    label: p.vrf ? `${p.cidr} · ${p.vrf.name}` : p.cidr,
  }))

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!isEdit && !prefixId) {
          toast.error("Pick the subnet this IP belongs to.")
          return
        }
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="Address" card>
            {!isEdit && (
              <>
                <div className="grid gap-3 @md:grid-cols-2">
                  <FormCombobox
                    label="Site"
                    hint="filter"
                    value={siteFilter}
                    onChange={(v) => {
                      setSiteFilter(v)
                      // Keep the chosen subnet when it survives the new
                      // filter - clearing a prefix the user just picked
                      // because they then narrowed to its own site was
                      // maddening. Only a prefix the filter excludes clears.
                      if (v && selectedPrefix?.site?.id !== v)
                        setPrefixId(null)
                    }}
                    options={siteOpts}
                    noneLabel="Any site"
                    placeholder="Any site"
                    searchPlaceholder="Search sites…"
                    emptyText="No sites."
                  />
                  <FormCombobox
                    label="VRF"
                    hint="filter"
                    value={vrfFilter}
                    onChange={(v) => {
                      setVrfFilter(v)
                      if (v && selectedPrefix?.vrf?.id !== v)
                        setPrefixId(null)
                    }}
                    options={vrfOpts}
                    noneLabel="Any VRF"
                    placeholder="Any VRF"
                    searchPlaceholder="Search VRFs…"
                    emptyText="No VRFs."
                  />
                </div>
                <FormCombobox
                  label="Subnet"
                  required
                  hint="sets the VRF and site"
                  value={prefixId}
                  onChange={setPrefixId}
                  options={prefixOpts}
                  placeholder="Pick a subnet…"
                  searchPlaceholder="Search subnets…"
                  emptyText="No subnets - adjust the filters."
                  error={fieldErrors.prefix_id}
                />
                {ranges.length > 0 && (
                  <FormSelect
                    label="Range"
                    hint="allocate from a pool inside the subnet"
                    value={rangeId}
                    onChange={setRangeId}
                    noneLabel="Any address in the subnet"
                    options={ranges.map((r) => ({
                      value: r.id,
                      label: r.description
                        ? `${r.start_address} – ${r.end_address} · ${r.description}`
                        : `${r.start_address} – ${r.end_address}`,
                    }))}
                  />
                )}
              </>
            )}

            <Field label="Address" required error={fieldErrors.ip_address}>
              <Input
                autoFocus={!isEdit}
                required
                placeholder="10.0.10.5"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="font-mono"
              />
              {!isEdit && selectedRange ? (
                <RangePool
                  range={selectedRange}
                  available={availableQuery.data}
                  loading={availableQuery.isLoading}
                  address={address}
                  onPick={setAddress}
                />
              ) : (
                !isEdit &&
                selectedPrefix?.cidr && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Within{" "}
                    <span className="font-mono text-foreground">
                      {selectedPrefix.cidr}
                    </span>{" "}
                    - the network part is filled in, just add the host.
                  </p>
                )
              )}
            </Field>

            <div className="grid gap-3 @md:grid-cols-2">
              <FormStatusSelect
                value={statusId}
                onChange={setStatusId}
                options={statuses.data?.results ?? []}
                noneLabel="No status"
                error={fieldErrors.status_id}
              />
              <FormCombobox
                label="Role"
                value={roleId}
                onChange={setRoleId}
                options={(roles.data?.results ?? []).map((r) => ({
                  value: r.id,
                  label: r.name,
                  color: r.color,
                }))}
                noneLabel="No role"
                placeholder="No role"
                searchPlaceholder="Search roles…"
                emptyText="No IP roles."
                error={fieldErrors.role_id}
              />
            </div>
          </FormSection>

          <FormSection title="Notes" card>
            <FormTextarea
              label="Description"
              rows={3}
              value={description}
              onChange={setDescription}
              placeholder="e.g. db-01 - production replica"
              error={fieldErrors.description}
            />
            <FormText
              label="Reservation note"
              required={requiresNote}
              hint={requiresNote ? "required by the status" : "optional"}
              value={reservationNote}
              onChange={setReservationNote}
              placeholder="Ticket #, owner, etc."
              error={fieldErrors.reservation_note}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Assignment" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <DevicePicker
                label="Device"
                value={deviceId}
                onChange={(next) => {
                  setDeviceId(next)
                  setInterfaceId(null)
                  if (!next) setIsPrimary(false)
                }}
                noneLabel="No device"
                placeholder="No device"
                error={fieldErrors.assigned_device_id}
              />
              <FormSelect
                label="Interface"
                value={interfaceId}
                onChange={setInterfaceId}
                disabled={!deviceId}
                noneLabel="No interface"
                placeholder={deviceId ? "Pick interface" : "Pick device first"}
                options={(interfaces.data?.results ?? []).map((i) => ({
                  value: i.id,
                  label: i.name,
                }))}
                error={fieldErrors.assigned_interface_id}
              />
            </div>

            {/* The virtual counterpart of Device + Interface above. */}
            <div className="grid gap-3 @md:grid-cols-2">
              <FormCombobox
                label="Virtual machine"
                value={vmId}
                onChange={(next) => {
                  setVmId(next)
                  setVmInterfaceId(null)
                }}
                options={(vms.data?.results ?? []).map((v) => ({
                  value: v.id,
                  label: v.name,
                }))}
                noneLabel="No virtual machine"
                placeholder="No virtual machine"
                searchPlaceholder="Search VMs…"
                emptyText="No virtual machines."
                error={fieldErrors.assigned_vm_id}
              />
              <FormSelect
                label="VM interface"
                value={vmInterfaceId}
                onChange={setVmInterfaceId}
                disabled={!vmId}
                noneLabel="No interface"
                placeholder={vmId ? "Pick interface" : "Pick a VM first"}
                options={(vmInterfaces.data?.results ?? []).map((i) => ({
                  value: i.id,
                  label: i.name,
                }))}
                error={fieldErrors.assigned_vm_interface_id}
              />
            </div>

            <div className="grid gap-3 @md:grid-cols-2">
              <DevicePicker
                label="Switch"
                value={switchId}
                onChange={(next) => {
                  setSwitchId(next)
                  setSwitchInterfaceId(null)
                }}
                noneLabel="No switch"
                placeholder="No switch"
                error={fieldErrors.switch_id}
              />
              <FormSelect
                label="Switch port"
                value={switchInterfaceId}
                onChange={setSwitchInterfaceId}
                disabled={!switchId}
                noneLabel="No port"
                placeholder={switchId ? "Pick port" : "Pick switch first"}
                options={(switchInterfaces.data?.results ?? []).map((i) => ({
                  value: i.id,
                  label: i.name,
                }))}
                error={fieldErrors.switch_interface_id}
              />
            </div>

            {deviceId && (
              <label
                className={`flex items-center gap-2 text-xs ${
                  planning ? "text-muted-foreground" : "cursor-pointer"
                }`}
              >
                {/* Primary IP is a field on the *device*, written by a second
                  request that plan mode never reaches. Rather than silently
                  drop it from a plan, the box is unavailable here and says
                  where it lives. */}
                <Checkbox
                  checked={isPrimary && !planning}
                  disabled={planning}
                  onCheckedChange={(v) => setIsPrimary(!!v)}
                />
                Make this the device's primary IP
                {planning && (
                  <InfoTip>
                    Primary IP is stored on the device, not the address. Plan it
                    from the device's own form.
                  </InfoTip>
                )}
              </label>
            )}

            {vmId && (
              <label
                className={`flex items-center gap-2 text-xs ${
                  planning ? "text-muted-foreground" : "cursor-pointer"
                }`}
              >
                {/* A VM has a primary IP for the same reason a device does -
                  the address it answers on. Stored on the VM, so plan mode
                  can't reach it either (#122). */}
                <Checkbox
                  checked={isVmPrimary && !planning}
                  disabled={planning}
                  onCheckedChange={(v) => setIsVmPrimary(!!v)}
                />
                Make this the VM's primary IP
                {planning && (
                  <InfoTip>
                    Primary IP is stored on the VM, not the address. Plan it
                    from the VM's own form.
                  </InfoTip>
                )}
              </label>
            )}
          </FormSection>

          <FormSection title="Identity" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="MAC address"
                value={mac}
                onChange={setMac}
                mono
                placeholder="00:1b:44:11:3a:b7"
                error={fieldErrors.mac_address}
              />
              <FormText
                label="DNS name"
                value={dnsName}
                onChange={setDnsName}
                mono
                placeholder="host.example.com"
                error={fieldErrors.dns_name}
              />
            </div>

            {canDhcp && (
              <div className="rounded-md border border-border p-3">
                <label
                  className={
                    "flex items-center gap-2 text-sm " +
                    (planning || (!existingRes && !mac.trim())
                      ? "text-muted-foreground"
                      : "cursor-pointer")
                  }
                >
                  <Checkbox
                    checked={dhcpReserve}
                    disabled={planning || (!existingRes && !mac.trim())}
                    onCheckedChange={(v) => setDhcpReserve(!!v)}
                  />
                  <span>Reserve in DHCP (MAC binding)</span>
                  <InfoTip>
                    This address is inside the DHCP scope pool{" "}
                    <span className="font-mono">
                      {poolScope?.scope_id ?? existingRes?.scope_display}
                    </span>{" "}
                    on{" "}
                    {poolScope?.connection_name ?? existingRes?.connection_name}
                    . Reserving binds it to the MAC address above and pushes the
                    reservation to the Windows server on save; unticking removes
                    it there.
                  </InfoTip>
                </label>
                <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
                  {planning
                    ? "Unavailable in plan mode - reservations push to the DHCP server immediately."
                    : !existingRes && !mac.trim()
                      ? "Enter the MAC address above to reserve this address."
                      : existingRes
                        ? `Currently reserved on ${existingRes.connection_name ?? "Danbyte (local)"} (${existingRes.mac}).`
                        : `Will reserve on ${poolScope?.connection_name ?? "Danbyte (local)"} when you save.`}
                </p>
              </div>
            )}
          </FormSection>
        </FormColumn>
      </FormColumns>

      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>

      <CustomFieldInputs
        model="ipaddress"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Add IP"}
      />
    </form>
  )
}

// Prefill the network portion of an address from a prefix CIDR, so the user
// only types the host part. IPv4: keep the fully-fixed leading octets
// (floor(prefixlen / 8)) + a trailing dot - e.g. 10.0.10.0/24 → "10.0.10.".
// IPv6: the network address (the part before "/") is a good starting base.
export function networkPrefill(cidr: string): string {
  const [addr, lenStr] = cidr.split("/")
  const len = Number(lenStr)
  if (!addr) return ""
  if (addr.includes(":")) return addr // IPv6 network base, e.g. "2001:db8::"
  const octets = addr.split(".")
  if (octets.length !== 4 || Number.isNaN(len)) return ""
  const fixed = Math.floor(len / 8)
  if (fixed <= 0) return ""
  if (fixed >= 4) return addr // /32 host address
  return octets.slice(0, fixed).join(".") + "."
}

/** The picked range as an allocation pool: how much is free, the first free
 * addresses as one-click picks, "Next free", and a nudge when the typed
 * address falls outside the span. Server-side truth stays the range's own
 * availability endpoint. */
function RangePool({
  range,
  available,
  loading,
  address,
  onPick,
}: {
  range: IPRange
  available?: IPRangeAvailable
  loading: boolean
  address: string
  onPick: (addr: string) => void
}) {
  const outside =
    address.trim() !== "" &&
    !addressInRange(address, range.start_address, range.end_address)
  const picks = available?.results.slice(0, 8) ?? []
  return (
    <div className="mt-1.5 space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        Within{" "}
        <span className="font-mono text-foreground">
          {range.start_address} – {range.end_address}
        </span>
        {available && (
          <>
            {" "}
            · <span className="num">{available.available}</span> of{" "}
            <span className="num">{available.size}</span> free
          </>
        )}
        {loading && " · Loading…"}
      </p>
      {picks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => onPick(picks[0])}
          >
            Next free
          </Button>
          {picks.map((a) => (
            <Button
              key={a}
              type="button"
              size="sm"
              variant={a === address.trim() ? "secondary" : "ghost"}
              className="h-6 px-1.5 font-mono text-[11px]"
              onClick={() => onPick(a)}
            >
              {a}
            </Button>
          ))}
          {available && available.available > picks.length && (
            <span className="text-[11px] text-muted-foreground">
              +{available.available - picks.length} more
            </span>
          )}
        </div>
      )}
      {available && available.available === 0 && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          Nothing free in this range.
        </p>
      )}
      {outside && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          Outside the picked range.
        </p>
      )}
    </div>
  )
}

