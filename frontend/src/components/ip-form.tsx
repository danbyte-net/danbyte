import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type IPAddress,
  type IPRoleOption,
  type StatusOption,
  type IPWritePayload,
  type InterfaceOption,
  type Paginated,
  type Prefix,
  type SiteOption,
  type TagOption,
  type VRFOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Combobox } from "@/components/ui/combobox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { DevicePicker } from "@/components/device-picker"
import { useFieldErrors } from "@/components/forms"

export interface IpFormInitial {
  address?: string
  prefixId?: string
  /** Prefill the assignment (e.g. adding an IP from a device's interface). */
  deviceId?: string
  interfaceId?: string
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

const NONE = "__none__"

export function IpForm({ ip, initial, clone, onSaved, onCancel }: IpFormProps) {
  const isEdit = !!ip
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
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
  // Every IP must live in a prefix (non-null FK), and the prefix is what carries
  // VRF + site — so on create the user picks a subnet, optionally narrowed by
  // site/VRF. Seeded from a prefix-page launch (`initial.prefixId`) or a clone.
  const [prefixId, setPrefixId] = useState<string | null>(
    seed?.prefix?.id ?? initial?.prefixId ?? null
  )
  const [siteFilter, setSiteFilter] = useState<string | null>(null)
  const [vrfFilter, setVrfFilter] = useState<string | null>(null)

  // Staff at a single site get that site's default prefix pre-selected — the
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
    setMac(ip.mac_address ?? "")
    setDnsName(ip.dns_name ?? "")
    setIsPrimary(ip.is_primary_for_device)
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
  const interfaces = useQuery({
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

  // Seed default status from the catalog once it loads (create mode).
  useEffect(() => {
    if (ip || statusId) return
    const def = statuses.data?.results.find((s) => s.is_default)
    if (def) setStatusId(def.id)
  }, [ip, statusId, statuses.data])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: IPWritePayload = {
        ip_address: address.trim(),
        status_id: statusId,
        role_id: roleId,
        assigned_device_id: deviceId,
        assigned_interface_id: deviceId ? interfaceId : null,
        mac_address: mac.trim(),
        dns_name: dnsName.trim(),
        description: description.trim(),
        reservation_note: reservationNote.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (!isEdit && prefixId) payload.prefix_id = prefixId
      const saved = isEdit
        ? await api<IPAddress>(`/api/ips/${ip!.id}/`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await api<IPAddress>("/api/ips/", {
            method: "POST",
            body: JSON.stringify(payload),
          })
      if (isPrimary && saved.assigned_device) {
        await api(`/api/devices/${saved.assigned_device.id}/`, {
          method: "PATCH",
          body: JSON.stringify({ primary_ip_id: saved.id }),
        }).catch(() => {})
      }
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
      {!isEdit && (
        <div className="grid gap-3 rounded-md border border-border p-3">
          <p className="text-[11px] text-muted-foreground">
            Pick the subnet this IP belongs to — it sets the VRF and site.
            Narrow the list by site or VRF.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Site (filter)">
              <Combobox
                value={siteFilter}
                onChange={(v) => {
                  setSiteFilter(v)
                  setPrefixId(null)
                }}
                options={siteOpts}
                noneLabel="Any site"
                placeholder="Any site"
                searchPlaceholder="Search sites…"
                emptyText="No sites."
              />
            </Field>
            <Field label="VRF (filter)">
              <Combobox
                value={vrfFilter}
                onChange={(v) => {
                  setVrfFilter(v)
                  setPrefixId(null)
                }}
                options={vrfOpts}
                noneLabel="Any VRF"
                placeholder="Any VRF"
                searchPlaceholder="Search VRFs…"
                emptyText="No VRFs."
              />
            </Field>
          </div>
          <Field label="Subnet" error={fieldErrors.prefix_id}>
            <Combobox
              value={prefixId}
              onChange={setPrefixId}
              options={prefixOpts}
              placeholder="Pick a subnet…"
              searchPlaceholder="Search subnets…"
              emptyText="No subnets — adjust the filters."
            />
          </Field>
        </div>
      )}

      <Field label="Address" error={fieldErrors.ip_address}>
        <Input
          autoFocus={!isEdit}
          required
          placeholder="10.0.10.5"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="font-mono"
        />
        {!isEdit && selectedPrefix?.cidr && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Within{" "}
            <span className="font-mono text-foreground">
              {selectedPrefix.cidr}
            </span>{" "}
            — the network part is filled in, just add the host.
          </p>
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Status" error={fieldErrors.status_id}>
          <Select
            value={statusId ?? NONE}
            onValueChange={(v) => setStatusId(v === NONE ? null : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Pick status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>— none —</SelectItem>
              {statuses.data?.results.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Role" error={fieldErrors.role_id}>
          <Select
            value={roleId ?? NONE}
            onValueChange={(v) => setRoleId(v === NONE ? null : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No role</SelectItem>
              {roles.data?.results.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. db-01 — production replica"
        />
      </Field>

      <Field
        label="Reservation note"
        hint={requiresNote ? "Required for this status" : "Optional"}
        error={fieldErrors.reservation_note}
      >
        <Input
          required={requiresNote}
          value={reservationNote}
          onChange={(e) => setReservationNote(e.target.value)}
          placeholder="Ticket #, owner, etc."
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
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
        <Field label="Interface">
          <Select
            value={interfaceId ?? NONE}
            onValueChange={(v) => setInterfaceId(v === NONE ? null : v)}
            disabled={!deviceId}
          >
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={deviceId ? "Pick interface" : "Pick device first"}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>— none —</SelectItem>
              {interfaces.data?.results.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="MAC address" error={fieldErrors.mac_address}>
          <Input
            value={mac}
            onChange={(e) => setMac(e.target.value)}
            className="font-mono"
            placeholder="00:1b:44:11:3a:b7"
          />
        </Field>
        <Field label="DNS name" error={fieldErrors.dns_name}>
          <Input
            value={dnsName}
            onChange={(e) => setDnsName(e.target.value)}
            className="font-mono"
            placeholder="host.example.com"
          />
        </Field>
      </div>

      {deviceId && (
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            checked={isPrimary}
            onCheckedChange={(v) => setIsPrimary(!!v)}
          />
          Make this the device's primary IP
        </label>
      )}

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

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : isEdit ? "Save changes" : "Add IP"}
        </Button>
      </div>
    </form>
  )
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-xs">{label}</Label>
        {hint && (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        )}
      </div>
      {children}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

// Prefill the network portion of an address from a prefix CIDR, so the user
// only types the host part. IPv4: keep the fully-fixed leading octets
// (floor(prefixlen / 8)) + a trailing dot — e.g. 10.0.10.0/24 → "10.0.10.".
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
