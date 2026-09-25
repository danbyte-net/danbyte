import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"

import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"
import { DevicePicker } from "@/components/device-picker"
import { FormSelect } from "@/components/forms/select"
import { VMPicker } from "@/components/vm-picker"

// A routing row runs on a device or on a virtual machine (#217). This is
// the one place that knows how the two differ: the list filter, the write
// fields, and where the box's ports come from.

export type OwnerKind = "device" | "vm"

export interface RoutingOwner {
  kind: OwnerKind
  id: string
  name: string
}

type Ref = { id: string; name: string } | null | undefined

/** The owner of a row that carries `device` / `virtual_machine`. */
export function ownerOf(row: {
  device?: Ref
  virtual_machine?: Ref
}): RoutingOwner | null {
  if (row.device) return { kind: "device", ...row.device }
  if (row.virtual_machine) return { kind: "vm", ...row.virtual_machine }
  return null
}

/** Name of the box a row runs on, for labels and titles. */
export const ownerName = (row: { device?: Ref; virtual_machine?: Ref }) =>
  ownerOf(row)?.name ?? "?"

/** A link to the box's page, on its Routing tab unless `tab` says otherwise. */
export function OwnerLink({
  owner,
  className,
  tab = "routing",
}: {
  owner: RoutingOwner | null
  className?: string
  tab?: "routing" | "overview" | "components"
}) {
  if (!owner) return <span className="text-muted-foreground">-</span>
  return owner.kind === "vm" ? (
    <Link
      to="/virtual-machines/$id"
      params={{ id: owner.id }}
      search={{ tab }}
      className={className}
    >
      {owner.name}
    </Link>
  ) : (
    <Link
      to="/devices/$id"
      params={{ id: owner.id }}
      search={{ tab }}
      className={className}
    >
      {owner.name}
    </Link>
  )
}

/** A port: a device interface links to its page, a VM's to the VM's
 * Components tab (VM ports have no page of their own). */
export function PortLink({
  iface,
  vmIface,
  className = "link font-mono",
}: {
  iface?: PortRef
  vmIface?: {
    id: string
    name: string
    vm: { id: string; name: string }
  } | null
  className?: string
}) {
  if (iface)
    return (
      <Link
        to="/interfaces/$id"
        params={{ id: iface.id }}
        className={className}
      >
        {iface.name}
      </Link>
    )
  if (vmIface)
    return (
      <Link
        to="/virtual-machines/$id"
        params={{ id: vmIface.vm.id }}
        search={{ tab: "components" }}
        className={className}
      >
        {vmIface.name}
      </Link>
    )
  return <span className="text-muted-foreground">-</span>
}

/** Opens the box's Routing tab - where a fleet list's pencil leads. */
export function useOpenOwner() {
  const nav = useNavigate()
  return (o: RoutingOwner | null) => {
    if (!o) return
    if (o.kind === "vm")
      nav({
        to: "/virtual-machines/$id",
        params: { id: o.id },
        search: { tab: "routing" },
      })
    else
      nav({
        to: "/devices/$id",
        params: { id: o.id },
        search: { tab: "routing" },
      })
  }
}

/** The list filter for an owner's rows: `device=…` or `virtual_machine=…`. */
export const ownerParam = (o: RoutingOwner) =>
  o.kind === "vm" ? `virtual_machine=${o.id}` : `device=${o.id}`

/** The box page's query key - invalidated when its routing count moves. */
export const ownerDetailKey = (o: RoutingOwner) =>
  o.kind === "vm" ? ["virtual-machine", o.id] : ["device", o.id]

/** "device" or "VM", for empty states. */
export const ownerNoun = (o: RoutingOwner) =>
  o.kind === "vm" ? "VM" : "device"

/** The write fields: exactly one of the two is set. */
export const ownerPayload = (o: RoutingOwner | null) => ({
  device_id: o?.kind === "device" ? o.id : null,
  virtual_machine_id: o?.kind === "vm" ? o.id : null,
})

/** A port on either kind of box, as the API returns it. */
export type PortRef = { id: string; name: string } | null | undefined

/** The port a row points at: the device's or the VM's. */
export const portOf = (row: { interface?: PortRef; vm_interface?: PortRef }) =>
  row.interface ?? row.vm_interface ?? null

/** Write fields for a port: the one for this owner's kind, the other null. */
export function portPayload(
  kind: OwnerKind | undefined,
  id: string | null,
  names: [string, string] = ["interface_id", "vm_interface_id"]
): Record<string, string | null> {
  const [dev, vm] = names
  return kind === "vm" ? { [dev]: null, [vm]: id } : { [dev]: id, [vm]: null }
}

/** The first error the API gave for any of `keys` - the device and VM
 * variants of one field report under different names. */
export const firstError = (
  errors: Record<string, string | undefined>,
  ...keys: string[]
) => keys.map((k) => errors[k]).find(Boolean)

/** The owner's ports, for a picker. */
export function useOwnerPorts(o: { kind: OwnerKind; id: string } | null) {
  return useQuery({
    queryKey: ["routing-owner-ports", o?.kind ?? null, o?.id ?? null],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        o!.kind === "vm"
          ? `/api/vm-interfaces/?vm=${o!.id}&page_size=500`
          : `/api/interfaces/?device=${o!.id}&page_size=500`
      ),
    enabled: !!o,
  })
}

const KIND_OPTIONS = [
  { value: "device", label: "Device" },
  { value: "vm", label: "Virtual machine" },
]

/** "Runs on": device or VM, then the matching picker. Locked when the form
 * opens from the box's own Routing tab. */
export function OwnerField({
  value,
  onChange,
  locked,
  error,
}: {
  value: { kind: OwnerKind; id: string | null }
  onChange: (v: { kind: OwnerKind; id: string | null }) => void
  locked?: boolean
  error?: string
}) {
  return (
    <div className="grid gap-3 @md:grid-cols-2">
      <FormSelect
        label="Runs on"
        value={value.kind}
        onChange={(k) =>
          onChange({ kind: k === "vm" ? "vm" : "device", id: null })
        }
        options={KIND_OPTIONS}
        disabled={locked}
      />
      {value.kind === "vm" ? (
        <VMPicker
          required
          value={value.id}
          onChange={(id) => onChange({ kind: "vm", id })}
          disabled={locked}
          error={error}
        />
      ) : (
        <DevicePicker
          required
          value={value.id}
          onChange={(id) => onChange({ kind: "device", id })}
          disabled={locked}
          error={error}
        />
      )}
    </div>
  )
}
